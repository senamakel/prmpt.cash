// prmpt -- the sidebar card.
//
// A webview showing the ad the hook matched for the last turn. It is the one
// surface here that works in stock VS Code with no patching of anything.
//
// The webview is locked down: no scripts beyond the tiny click forwarder, a
// strict CSP with a nonce, and every piece of ad copy inserted as textContent
// rather than HTML. Copy comes from a model on our backend, so treating it as
// markup would be an injection path straight into the editor's chrome.

import * as vscode from 'vscode';
import { readSlot, Slot } from './slot';

export class AdCardView implements vscode.WebviewViewProvider {
  public static readonly viewType = 'prmpt.adCard';
  private view?: vscode.WebviewView;

  constructor(private readonly onOpen: (ad: Slot) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'open') {
        const ad = readSlot();
        if (ad) this.onOpen(ad);
      }
    });
    this.render();
  }

  render(): void {
    if (!this.view) return;
    this.view.webview.html = html(readSlot());
  }
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function html(ad: Slot | null): string {
  const n = nonce();
  // default-src 'none' plus a nonced inline script: no network, no images, no
  // fonts. The card is text and CSS, so it needs nothing else, and anything it
  // did need would be a reason to look twice.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';`;

  if (!ad) {
    return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${css()}</style></head><body>
<div class="empty">No sponsored line right now.<br><span class="hint">One appears after an agent turn that matches.</span></div>
</body></html>`;
  }

  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${css()}</style></head><body>
<div class="card" id="card" role="link" tabindex="0">
  <div class="label">Sponsored</div>
  <div class="headline" id="headline"></div>
  <div class="body" id="body"></div>
  <div class="open">Open ↗</div>
</div>
<script nonce="${n}">
  const vscodeApi = acquireVsCodeApi();
  // textContent, never innerHTML: this copy is model-generated.
  document.getElementById('headline').textContent = ${JSON.stringify(ad.headline)};
  document.getElementById('body').textContent = ${JSON.stringify(ad.body)};
  const card = document.getElementById('card');
  const open = () => vscodeApi.postMessage({ type: 'open' });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
</script>
</body></html>`;
}

function css(): string {
  return `
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); padding: 8px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px;
            cursor: pointer; background: var(--vscode-editorWidget-background); }
    .card:hover { border-color: var(--vscode-focusBorder); }
    .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
             opacity: .6; margin-bottom: 6px; }
    .headline { font-weight: 600; line-height: 1.35; }
    .body { opacity: .8; line-height: 1.4; margin-top: 4px; }
    .open { margin-top: 8px; font-size: 11px; color: var(--vscode-textLink-foreground); }
    .empty { opacity: .6; line-height: 1.5; }
    .hint { font-size: 11px; opacity: .8; }
  `;
}
