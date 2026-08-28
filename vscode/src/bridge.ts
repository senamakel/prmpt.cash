// prmpt -- the localhost bridge.
//
// The chat card runs inside Cursor's renderer, which cannot read
// ~/.config/prmpt/slot.json: it has no filesystem access. So the extension host,
// which does, serves the parked ad over loopback and the injected script polls
// it.
//
// The port is CONFIGURED, not chosen at random. A random port would have to be
// baked into the patched workbench.js at apply time and would go stale on the
// next restart, silently killing the card until someone re-patched. A fixed
// default with a small fallback range survives restarts, and the injected script
// probes the range.
//
// What this server is allowed to be:
//   - loopback only, never 0.0.0.0. Anything else publishes the user's ad slot
//     -- and by extension their activity -- to the local network.
//   - GET one path, no state, no token, nothing writable.
//   - Origin-agnostic but content-trivial: it returns the same headline that is
//     already on screen, so the worst case for another local process reading it
//     is that it learns which ad this machine was shown.

import * as http from 'node:http';
import { readSlot } from './slot';

/** Kept in sync with PORT_RANGE in chatInject.ts -- the script probes these. */
export const DEFAULT_PORT = 51793;
export const PORT_SPAN = 5;

export class Bridge {
  private server?: http.Server;
  private port = 0;

  /** Called when the chat card is clicked, so the host opens the URL. */
  constructor(private readonly onOpen: () => void) {}

  async start(preferred: number): Promise<number> {
    const base = Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_PORT;
    for (let i = 0; i < PORT_SPAN; i++) {
      const candidate = base + i;
      try {
        this.port = await this.listen(candidate);
        return this.port;
      } catch {
        // Port taken -- most likely another editor window running this same
        // extension, which is fine: its bridge serves the same file.
      }
    }
    return 0;
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method !== 'GET' || !req.url) {
          res.writeHead(404).end();
          return;
        }
        if (req.url.startsWith('/open')) {
          // The renderer never opens URLs itself -- it asks for this, and the
          // host opens the parked ad with openExternal, exactly as the sidebar
          // and status bar do. So the renderer never learns a URL it could
          // navigate to on its own, and every surface attributes identically.
          this.onOpen();
          res.writeHead(204).end();
          return;
        }
        if (!req.url.startsWith('/slot')) {
          res.writeHead(404).end();
          return;
        }
        const ad = readSlot();
        res.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          // The renderer's origin is a vscode-file:// URL, which is opaque.
          'access-control-allow-origin': '*',
        });
        // Deliberately no clickUrl: the renderer asks /open instead, so a URL
        // never crosses into a context that could navigate to it unprompted.
        res.end(JSON.stringify(ad ? {
          requestId: ad.requestId,
          headline: ad.headline,
          body: ad.body,
        } : null));
      });
      // Only a server that actually bound becomes the one dispose() closes. A
      // failed attempt used to overwrite it, so a window that fell through to
      // the next port left its real listener open for the life of the process.
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve(port);
      });
    });
  }

  dispose(): void {
    try { this.server?.close(); } catch { /* ignore */ }
  }
}
