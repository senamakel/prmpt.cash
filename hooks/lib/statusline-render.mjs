// prmpt -- rendering the parked ad for a host status line.
//
// Pure string work, no I/O, so the shape of the output can be asserted in a
// test without a filesystem or a host.
//
// Two things make a status line different from the end-of-turn line:
//
//   - It is permanent. The end-of-turn block is three lines that scroll away;
//     the status line sits above the prompt for as long as the ad is parked.
//     So the default here is ONE line, dim, and never the three-line block.
//     A persistent ad that takes a quarter of the terminal is the kind of thing
//     that gets a plugin uninstalled.
//   - It cannot print a URL usefully. A raw click URL on a permanent line is
//     noise, and the user cannot select it without disturbing the prompt. So
//     the line is wrapped in an OSC 8 hyperlink instead: modern terminals make
//     the whole thing clickable, and ones that do not simply show the text.
//
// Everything stays honest about what it is: the word "Sponsored" leads, and
// nothing is dressed up to look like output from the agent.

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;

/** Wrap text in an OSC 8 hyperlink. Terminals that don't support it show the text. */
export function hyperlink(url, text) {
  if (!safeUrl(url)) return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/** Visible width, ignoring SGR colour codes and OSC 8 hyperlink wrappers. */
export function visibleLength(s) {
  return s
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .length;
}

/**
 * Strip anything that could steer the terminal rather than print in it.
 *
 * The headline is written by a model, server-side, and lands unescaped on the
 * row above somebody's prompt. An escape sequence in it would be able to move
 * the cursor, repaint the screen or hide what it did. Text only.
 */
function plainText(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, ' ');
}

/**
 * Is this a URL we are willing to hand a terminal as a hyperlink target?
 *
 * Same reasoning as above, one step further: the URL goes inside an OSC 8
 * escape, so a control character in it would terminate the sequence early and
 * write whatever followed straight to the screen.
 */
export function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s\x00-\x1f\x7f]+$/.test(url);
}

/** Collapse whitespace and clip to `max`, breaking on a word boundary. */
function oneLine(s, max) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The ad line the surface is sold against: at most this many visible chars. */
export const AD_LINE_MAX = 60;

const LABEL = 'Sponsored';
const OPEN = '↗';

/**
 * The status-line rendering: one dim, clickable line.
 *
 *   Sponsored · Ship faster with Foo — 2ms cold starts ↗
 *
 * `columns` is the terminal width. The line is budgeted against it so it never
 * wraps: a wrapped status line pushes the prompt down by a row on every redraw,
 * which looks like the terminal is broken.
 */
export function renderSlotLine(ad, { columns = 80, color = true } = {}) {
  const dim = (s) => (color ? `${DIM}${s}${RESET}` : s);

  // Reserve: the label, its separator, the trailing affordance, and a couple of
  // columns of slack so a status line that is exactly the terminal width does
  // not wrap on terminals that count the last cell differently.
  // Two independent ceilings, and the tighter one wins.
  //
  //   columns  -- so the line never wraps (a wrapped status line pushes the
  //               prompt down a row on every redraw and looks broken);
  //   AD_LINE_MAX -- the format contract the surface is *sold* against. An
  //               advertiser buys a short line; a wide terminal must not turn
  //               that into a banner, and it must leave room for whatever the
  //               user's own chained status line already puts on the row.
  const fit = Math.max(20, columns - LABEL.length - OPEN.length - 6);
  const budget = Math.min(AD_LINE_MAX, fit);

  let text = oneLine(plainText(ad.headline), budget);
  if (ad.body) {
    const room = budget - text.length - 3;
    if (room >= 24) text = `${text} — ${oneLine(plainText(ad.body), room)}`;
  }

  return hyperlink(ad.clickUrl, dim(`${LABEL} · ${text} ${OPEN}`));
}

/**
 * The full status line: the host's own status line (if we chained one) with
 * ours beneath it, closest to the prompt.
 *
 * `mode` is 'card' for hosts that render every line of the command's output
 * (Claude Code) and 'line' for hosts that use only the first (Codex). In 'line'
 * mode a chained status line cannot be shown alongside ours at all -- there is
 * one row -- so the chained one wins and we stay silent. Taking the user's own
 * status line away to show an ad is not a trade this plugin makes.
 */
export function composeStatusLine(opts) {
  return composeStatusLineParts(opts).text;
}

/**
 * The same composition, plus whether the ad was actually drawn.
 *
 * The caller bills an impression, and "an ad was parked" is not the same claim
 * as "an ad reached the screen". In 'line' mode with a chained status line it
 * did not, and billing for it would charge an advertiser for a row nobody saw.
 */
export function composeStatusLineParts({
  ad,
  chained = '',
  mode = 'card',
  columns = 80,
  color = true,
}) {
  const chain = (chained || '').replace(/\s+$/, '');
  if (mode === 'line') {
    if (chain) return { text: chain.split('\n')[0], adRendered: false };
    if (!ad) return { text: '', adRendered: false };
    return { text: renderSlotLine(ad, { columns, color }), adRendered: true };
  }
  if (!ad) return { text: chain, adRendered: false };
  const line = renderSlotLine(ad, { columns, color });
  return { text: chain ? `${chain}\n${line}` : line, adRendered: true };
}
