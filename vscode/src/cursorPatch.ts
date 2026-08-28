// prmpt -- the Cursor chat patch.
//
// Cursor has no extension point that puts anything next to its chat composer,
// so the card gets there by adding a line to Cursor's own startup bundle. This
// is the only part of prmpt that writes to a file it does not own, and it is
// gated behind an explicit prompt for that reason.
//
// It is a much milder operation than patching an Electron app's asar:
// workbench.js is plain, unsigned JavaScript on disk. Nothing is repacked,
// no integrity hash is recomputed, and nothing is re-signed.
//
// The rules, all of which have a failure they exist to prevent:
//
//   - Patch the BOOTSTRAP, not the main bundle. workbench.desktop.main.js is
//     tens of megabytes and rewritten wholesale on every Cursor update; the
//     bootstrap is small and its hook string has been stable across many more
//     versions. We also strip our marker out of the main bundles in case an
//     older layout put one there.
//   - Back up before the first write, and restore from the BACKUP rather than
//     by un-editing. Reversing a text edit assumes the edit is the only thing
//     that changed since; a byte copy does not.
//   - Version the marker. A stale injected script from an older extension
//     version must be replaced, not appended to.
//   - Validate the script before writing it. A syntax error here lands inside
//     Cursor's startup path, and the symptom is an editor that will not open.
//   - Fail closed. If the hook string is not found -- Cursor changed -- do
//     nothing at all and say so. The sidebar and status bar still work.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { chatInjectScript } from './chatInject';

const MARKER_VERSION = 1;
const MARKER = `/*__PRMPT_PATCH_V${MARKER_VERSION}__*/`;
/** Any marker we have ever written, so an upgrade supersedes rather than stacks. */
const ANY_MARKER = /\/\*__PRMPT_PATCH_V\d+__\*\//;

const BACKUP_SUFFIX = '.prmpt-backup';

const BOOTSTRAP_REL = 'out/vs/code/electron-sandbox/workbench/workbench.js';
const MAIN_RELS = [
  'out/vs/workbench/workbench.desktop.main.js',
  'out/vs/workbench/workbench.glass.main.js',
];

/**
 * The tail of Cursor's bootstrap, where the workbench has just been handed
 * control. Appending after `B.main(S)` means our script runs once the workbench
 * exists rather than racing it.
 */
const HOOK = 'performance.mark("code/didLoadWorkbenchMain"),B.main(S)})();';
const HOOKED =
  'performance.mark("code/didLoadWorkbenchMain"),B.main(S),' +
  'setTimeout(function(){typeof PRMPT_RUN==="function"&&PRMPT_RUN()},2500)})();';

export interface PatchResult {
  ok: boolean;
  message: string;
}

function target(rel: string): string {
  return path.join(vscode.env.appRoot, rel);
}

export function isCursor(): boolean {
  const name = (vscode.env.appName || '').toLowerCase();
  if (name.includes('cursor')) return true;
  return (vscode.env.appRoot || '').toLowerCase().includes('cursor');
}

export function canPatch(): boolean {
  try {
    return isCursor() && fs.existsSync(target(BOOTSTRAP_REL));
  } catch {
    return false;
  }
}

export function isPatched(): boolean {
  try {
    return ANY_MARKER.test(fs.readFileSync(target(BOOTSTRAP_REL), 'utf8'));
  } catch {
    return false;
  }
}

/** True when a patch is present but from an older extension version. */
export function isStale(): boolean {
  try {
    const src = fs.readFileSync(target(BOOTSTRAP_REL), 'utf8');
    return ANY_MARKER.test(src) && !src.includes(MARKER);
  } catch {
    return false;
  }
}

/** Remove any marker block and undo the hook rewrite, returning clean source. */
function strip(content: string): string {
  let c = content;
  const idx = c.search(ANY_MARKER);
  if (idx >= 0) c = `${c.slice(0, idx).trimEnd()}\n`;
  c = c.replace(
    /performance\.mark\("code\/didLoadWorkbenchMain"\),B\.main\(S\),[^}]+\}\)\(\);/,
    HOOK,
  );
  return c;
}

/** Older layouts injected into the main bundles; make sure nothing is left there. */
function stripMainBundles(): void {
  for (const rel of MAIN_RELS) {
    const file = target(rel);
    const backup = file + BACKUP_SUFFIX;
    try {
      if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, file);
        fs.rmSync(backup, { force: true });
        continue;
      }
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const idx = content.search(ANY_MARKER);
      if (idx >= 0) fs.writeFileSync(file, `${content.slice(0, idx).trimEnd()}\n`);
    } catch {
      // A read-only install is a reason not to patch, not a reason to throw.
    }
  }
}

export function applyPatch(portBase: number): PatchResult {
  const file = target(BOOTSTRAP_REL);
  if (!fs.existsSync(file)) {
    return { ok: false, message: 'Cursor workbench.js not found — unsupported build.' };
  }

  try {
    stripMainBundles();

    // The backup is taken from the file as it was BEFORE we ever touched it,
    // and is never overwritten afterwards, so a re-patch cannot bake our own
    // previous edit into the thing we restore to.
    const backup = file + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);

    const pristine = strip(fs.readFileSync(backup, 'utf8'));
    if (!pristine.includes(HOOK)) {
      return {
        ok: false,
        message:
          'Cursor’s startup code has changed and the patch no longer fits. ' +
          'The sidebar and status bar still work; the chat card does not.',
      };
    }

    const script = chatInjectScript(portBase);
    // Parse it before it goes anywhere near Cursor's startup path.
    try {
      // eslint-disable-next-line no-new-func
      new Function(script);
    } catch {
      return { ok: false, message: 'Generated patch failed validation — Cursor untouched.' };
    }

    const out =
      `${pristine.replace(HOOK, HOOKED)}\n` +
      `${MARKER}\nfunction PRMPT_RUN(){${script}}\n`;

    fs.writeFileSync(file, out);
    return { ok: true, message: 'Chat card enabled. Reload Cursor to see it.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Could not write to the Cursor install (${msg}). Nothing was changed.`,
    };
  }
}

export function removePatch(): PatchResult {
  const file = target(BOOTSTRAP_REL);
  const backup = file + BACKUP_SUFFIX;
  try {
    stripMainBundles();
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, file);
      fs.rmSync(backup, { force: true });
      return { ok: true, message: 'Chat card removed. Reload Cursor.' };
    }
    if (!fs.existsSync(file)) return { ok: true, message: 'Nothing to remove.' };
    const content = fs.readFileSync(file, 'utf8');
    if (!ANY_MARKER.test(content)) return { ok: true, message: 'Nothing to remove.' };
    fs.writeFileSync(file, strip(content));
    return { ok: true, message: 'Chat card removed. Reload Cursor.' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Could not restore the Cursor install (${msg}).` };
  }
}
