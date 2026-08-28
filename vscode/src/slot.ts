// prmpt -- reading the parked ad.
//
// A TypeScript port of hooks/lib/slot.mjs, deliberately kept to the same rules:
// same path, same 30-minute TTL, same validation. The extension is a DISPLAY
// for a decision the end-of-turn hook already made -- it never calls the
// backend, and it holds no token.
//
// If the two ever disagree about what a valid slot is, the extension shows
// something the hook considers stale. So the constants below are not to be
// tuned independently of the hook.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Must match DEFAULT_TTL_MS in hooks/lib/slot.mjs. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface Slot {
  requestId: string;
  headline: string;
  body: string;
  clickUrl: string;
  sessionId: string;
  harness: string;
  ts: number;
}

/** ~/.config/prmpt, honouring XDG_CONFIG_HOME exactly as hooks/lib/config.mjs does. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'prmpt');
}

export function slotPath(): string {
  return path.join(configDir(), 'slot.json');
}

function ttlMs(): number {
  const raw = Number.parseInt(process.env.PRMPT_SLOT_TTL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * The parked decision, or null when there is none, it is malformed, or it has
 * aged out.
 *
 * Note there is no session scoping here, unlike the terminal status line. The
 * editor has no notion of which agent session a turn came from, and the useful
 * behaviour is to show whatever this machine most recently matched -- including
 * a turn taken in a Codex or Claude Code session running in the editor's own
 * terminal, which is a placement those hosts cannot give us themselves.
 */
export function readSlot(now: number = Date.now()): Slot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(slotPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  const headline = typeof p.headline === 'string' ? p.headline.trim() : '';
  const clickUrl = typeof p.clickUrl === 'string' ? p.clickUrl.trim() : '';
  if (!headline || !clickUrl) return null;
  if (typeof p.ts !== 'number' || now - p.ts > ttlMs()) return null;

  // The click URL is opened with openExternal and injected into a webview, so
  // refuse anything that is not plainly an http(s) URL rather than trusting a
  // file we merely expect to have written ourselves.
  try {
    const parsedUrl = new URL(clickUrl);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  return {
    requestId: typeof p.requestId === 'string' ? p.requestId : '',
    headline,
    body: typeof p.body === 'string' ? p.body.trim() : '',
    clickUrl,
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : '',
    harness: typeof p.harness === 'string' ? p.harness : '',
    ts: p.ts,
  };
}

/**
 * Call `onChange` whenever the parked ad changes.
 *
 * Watches the directory rather than the file: the hook writes slot.json by
 * replacing it, and a watcher bound to the old inode stops firing after the
 * first write. Returns a disposer.
 */
export function watchSlot(onChange: () => void): () => void {
  let watcher: fs.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;

  const start = () => {
    try {
      fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      watcher = fs.watch(configDir(), (_event, filename) => {
        if (filename && !String(filename).startsWith('slot.json')) return;
        // Coalesce: a replace shows up as several events in quick succession.
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, 120);
      });
    } catch {
      // A home directory we cannot watch is not an error worth surfacing; the
      // poll below still picks changes up.
    }
  };

  start();
  // Backstop for platforms and filesystems where fs.watch is unreliable
  // (network homes, some containers). Cheap: one stat-sized read a minute.
  const poll = setInterval(onChange, 60_000);

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    try { watcher?.close(); } catch { /* ignore */ }
  };
}
