// prmpt -- the VS Code / Cursor extension.
//
// This is a DISPLAY, not an engine. It holds no token, makes no backend call,
// and matches nothing: it reads the ad that the end-of-turn hook already chose
// for this machine's last agent turn and renders it. Everything that costs
// money or knows a secret lives in the CLI plugin.
//
// Three placements, in descending order of how much they ask of the user:
//
//   sidebar     stock VS Code API, works everywhere, nothing patched
//   status bar  stock VS Code API, works everywhere, nothing patched
//   chat card   Cursor only, and only after the user says yes to patching
//               Cursor's own workbench.js
//
// The first two are always on. The third is never applied without an explicit
// answer, and is removable in one command.

import * as vscode from 'vscode';
import { readSlot, watchSlot, Slot } from './slot';
import { AdCardView } from './adCardView';
import { StatusBarAd } from './statusBar';
import { Bridge, DEFAULT_PORT } from './bridge';
import {
  applyPatch,
  removePatch,
  canPatch,
  isCursor,
  isPatched,
  isStale,
} from './cursorPatch';

/** Remembers a declined patch prompt so it is asked once, not every launch. */
const DECLINED_KEY = 'prmpt.chatCardDeclined';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const open = (ad: Slot) => {
    void vscode.env.openExternal(vscode.Uri.parse(ad.clickUrl));
  };

  const view = new AdCardView(open);
  const statusBar = new StatusBarAd();
  const bridge = new Bridge(() => {
    const ad = readSlot();
    if (ad) open(ad);
  });

  const config = () => vscode.workspace.getConfiguration('prmpt');
  const portBase = config().get('bridgePort', DEFAULT_PORT);
  await bridge.start(portBase);

  const refresh = () => {
    view.render();
    statusBar.render();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AdCardView.viewType, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    statusBar,
    { dispose: watchSlot(refresh) },
    { dispose: () => bridge.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('prmpt')) refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('prmpt.openCurrentAd', () => {
      const ad = readSlot();
      if (ad) open(ad);
      else void vscode.window.showInformationMessage('prmpt: no sponsored line is parked right now.');
    }),
    vscode.commands.registerCommand('prmpt.applyCursorPatch', async () => {
      const r = applyPatch(config().get('bridgePort', DEFAULT_PORT));
      await (r.ok
        ? vscode.window.showInformationMessage(`prmpt: ${r.message}`)
        : vscode.window.showWarningMessage(`prmpt: ${r.message}`));
    }),
    vscode.commands.registerCommand('prmpt.removeCursorPatch', async () => {
      const r = removePatch();
      await (r.ok
        ? vscode.window.showInformationMessage(`prmpt: ${r.message}`)
        : vscode.window.showWarningMessage(`prmpt: ${r.message}`));
    }),
    vscode.commands.registerCommand('prmpt.showStatus', () => showStatus()),
  );

  refresh();
  void maybeOfferChatCard(context);
}

/**
 * Offer the Cursor chat card, once.
 *
 * The prompt spells out that this writes to Cursor's own files, because that is
 * the part a reasonable person would want to know before answering. "Not now"
 * is remembered; the command is still there for anyone who changes their mind.
 */
async function maybeOfferChatCard(context: vscode.ExtensionContext): Promise<void> {
  if (!canPatch()) return;

  const setting = vscode.workspace.getConfiguration('prmpt').get<string>('cursorChatCard', 'ask');
  if (setting === 'off') return;

  const port = vscode.workspace.getConfiguration('prmpt').get('bridgePort', DEFAULT_PORT);

  // An existing patch from an older version has to be refreshed or it runs
  // stale injected code against a newer bridge.
  if (isStale()) {
    applyPatch(port);
    return;
  }
  if (isPatched()) return;

  if (setting === 'on') {
    applyPatch(port);
    return;
  }
  if (context.globalState.get<boolean>(DECLINED_KEY)) return;

  const yes = 'Enable';
  const no = 'Not now';
  const answer = await vscode.window.showInformationMessage(
    'prmpt can show the sponsored line above Cursor’s chat input while the agent is working. ' +
      'Cursor has no extension point for that, so this modifies one file inside your Cursor ' +
      'installation (workbench.js). A backup is kept and “prmpt: Remove Cursor Chat Card” ' +
      'restores it. The sidebar and status bar work either way.',
    yes,
    no,
  );

  if (answer !== yes) {
    await context.globalState.update(DECLINED_KEY, true);
    return;
  }

  const r = applyPatch(port);
  await (r.ok
    ? vscode.window.showInformationMessage(`prmpt: ${r.message}`)
    : vscode.window.showWarningMessage(`prmpt: ${r.message}`));
}

function showStatus(): void {
  const ad = readSlot();
  const lines = [
    `host: ${vscode.env.appName}${isCursor() ? ' (chat card supported)' : ''}`,
    `parked ad: ${ad ? ad.headline : '(none)'}`,
  ];
  if (isCursor()) lines.push(`chat card: ${isPatched() ? 'enabled' : 'not enabled'}`);
  void vscode.window.showInformationMessage(`prmpt — ${lines.join(' · ')}`);
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions; the patch is deliberately
  // NOT reverted here. Uninstalling the extension must not silently rewrite the
  // user's Cursor install behind their back -- that is what the remove command
  // is for, and it is named in the README.
}
