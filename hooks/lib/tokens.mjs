// prmpt -- local derivation of match signal from the user's prompt.
//
// The status-line surface has no turn text to match on: it renders while the
// model is still thinking, so the only thing that exists yet is what the user
// typed. Sending that would break the promise this plugin makes in its README,
// so the prompt never leaves the machine. What leaves is the output of this
// function: a sorted, de-duplicated bag of individual keywords.
//
// Three properties are deliberate and each is load-bearing:
//
//   - It is a BAG, not a list. The tokens are sorted alphabetically, so word
//     order -- the last thing that makes a set of words into prose -- is gone
//     before anything is serialised. "acquire nightingale" cannot be read back
//     out of ["acquire", "nightingale"] sorted next to thirty other words.
//   - Anything that is not prose is removed WHOLE, before splitting: code
//     blocks, inline code, URLs, filesystem paths and email addresses. Splitting
//     first and filtering after would already have turned /home/janedoe into
//     the token "janedoe".
//   - Only the head of the prompt is read, and the result is capped. This runs
//     inside UserPromptSubmit, which blocks the user.
//
// None of this makes tokenised text anonymous in general. It makes the specific
// claim the README makes -- that we do not transmit your prompt -- literally
// true, and keeps the obvious identifiers out.

/** Only the first slice of the prompt is read. Bounded work on a huge paste. */
const MAX_PROMPT_CHARS = 4000;
/** Shorter than this carries no signal; longer than this is not a word. */
const MIN_TOKEN_CHARS = 2;
const MAX_TOKEN_CHARS = 24;
/** How many tokens ride on the wire. */
const MAX_TOKENS = 32;

/**
 * Words that say nothing about what the user is working on.
 *
 * Includes ordinary English function words plus the politeness and
 * instruction-giving vocabulary that shows up in every single agent prompt --
 * "please", "can you", "let's" -- and would otherwise be the most common
 * tokens we ever send.
 */
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both',
  'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during',
  'each', 'else', 'few', 'for', 'from', 'further', 'get', 'go', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'let', 'lets', 'like', 'make', 'me', 'more',
  'most', 'my', 'myself', 'need', 'no', 'nor', 'not', 'now', 'of', 'off', 'ok', 'okay', 'on',
  'once', 'one', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'please', 'put', 'same', 'she', 'should', 'so', 'some', 'still', 'such', 'sure',
  'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us', 'use', 'very',
  'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours', 'yourself',
]);

/**
 * Strip everything that is not prose, whole, before any splitting happens.
 *
 * Order matters: fences before inline spans (an inline rule would eat the
 * fence markers), URLs before paths (a URL contains slashes).
 */
function redact(text) {
  let s = text;
  // Balanced fenced code blocks.
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // An UNBALANCED fence: everything from it to the end is code we never saw the
  // end of. A truncated paste is the common case and must not fall through.
  const openFence = s.indexOf('```');
  if (openFence !== -1) s = s.slice(0, openFence);
  // Inline code spans, single line only so an unmatched backtick cannot eat
  // the rest of a prompt that merely mentions one.
  s = s.replace(/`[^`\n]*`/g, ' ');
  // URLs, including scheme-relative ones.
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  s = s.replace(/(?:^|\s)\/\/\S+/g, ' ');
  // Email addresses. Before paths: an address has no leading slash, so the
  // path rule would leave it alone and the local part would become tokens.
  s = s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, ' ');
  // Windows paths, drive-qualified or UNC.
  s = s.replace(/(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\)\S*/g, ' ');
  // POSIX paths, absolute or home-relative, and any bare token holding a
  // separator (src/lib/thing.ts, ..\build).
  s = s.replace(/(?:^|\s)~?\/\S*/g, ' ');
  s = s.replace(/\S*[\\/]\S*/g, ' ');
  return s;
}

/**
 * Is this token a credential, a hash or an id rather than a word?
 *
 * Not a general secret detector -- there is no such thing. It catches the
 * shapes that actually turn up in a prompt about a bug: hex digests, opaque
 * ids, and anything long enough that it is not a word somebody typed.
 */
function looksOpaque(token) {
  if (/^\d+$/.test(token)) return true;                 // a bare number
  if (/^[0-9a-f]{8,}$/.test(token)) return true;        // hex digest or id
  if (/^[0-9a-f-]{16,}$/.test(token)) return true;      // uuid-ish
  return false;
}

/**
 * Derive the wire signal from a prompt.
 *
 * Always returns an array; never throws, whatever it is handed.
 */
export function signalTokens(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];

  const words = redact(prompt.slice(0, MAX_PROMPT_CHARS))
    .toLowerCase()
    .split(/[^a-z0-9_+#]+/);

  // Kept in order of first appearance up to the cap, so a long prompt
  // contributes its opening -- where the ask usually is -- rather than an
  // alphabetical slice of itself. The output is sorted afterwards.
  const picked = [];
  const seen = new Set();
  for (const word of words) {
    if (word.length < MIN_TOKEN_CHARS || word.length > MAX_TOKEN_CHARS) continue;
    if (STOPWORDS.has(word) || looksOpaque(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    picked.push(word);
    if (picked.length >= MAX_TOKENS) break;
  }
  return picked.sort();
}
