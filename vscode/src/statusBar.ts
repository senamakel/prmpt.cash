// prmpt -- the status bar entry.
//
// One item, left-aligned, showing the current headline clipped to something a
// status bar can hold. Hidden entirely when nothing is parked: an ad slot that
// says "no ad" is still an ad slot taking up the user's chrome.

import * as vscode from 'vscode';
import { readSlot, Slot } from './slot';

const MAX_CHARS = 48;

export class StatusBarAd implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
    this.item.command = 'prmpt.openCurrentAd';
  }

  render(): void {
    const enabled = vscode.workspace.getConfiguration('prmpt').get('showStatusBar', true);
    const ad = enabled ? readSlot() : null;
    if (!ad) {
      this.item.hide();
      return;
    }
    this.item.text = `$(megaphone) ${clip(ad.headline, MAX_CHARS)}`;
    this.item.tooltip = tooltip(ad);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function tooltip(ad: Slot): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Sponsored** — ${escapeMd(ad.headline)}\n\n`);
  if (ad.body) md.appendMarkdown(`${escapeMd(ad.body)}\n\n`);
  md.appendMarkdown('_Click to open. prmpt pays you 70% of the click price._');
  return md;
}

/** Model-generated copy in a markdown tooltip is a link-injection path. */
function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1');
}
