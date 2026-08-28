// prmpt -- the text surgery behind the Cursor patch.
//
// Split out from cursorPatch.ts, which imports `vscode` and therefore cannot be
// loaded outside the editor. Everything here is pure string work over the
// contents of workbench.js, so the risky part -- the part that can leave
// somebody unable to open their editor -- is testable without Cursor.

export const MARKER_VERSION = 1;
export const MARKER = `/*__PRMPT_PATCH_V${MARKER_VERSION}__*/`;

/** Any marker we have ever written, so an upgrade supersedes rather than stacks. */
export const ANY_MARKER = /\/\*__PRMPT_PATCH_V\d+__\*\//;

/**
 * The tail of Cursor's bootstrap, where the workbench has just been handed
 * control. Appending after `B.main(S)` means our script runs once the workbench
 * exists rather than racing it.
 */
export const HOOK = 'performance.mark("code/didLoadWorkbenchMain"),B.main(S)})();';

export const HOOKED =
  'performance.mark("code/didLoadWorkbenchMain"),B.main(S),' +
  'setTimeout(function(){typeof PRMPT_RUN==="function"&&PRMPT_RUN()},2500)})();';

export function isPatchedText(content: string): boolean {
  return ANY_MARKER.test(content);
}

export function isStaleText(content: string): boolean {
  return ANY_MARKER.test(content) && !content.includes(MARKER);
}

/**
 * Remove any marker block and undo the hook rewrite, returning clean source.
 *
 * Used to derive pristine content from a backup that may itself have been taken
 * after an older patch, so re-patching cannot nest one injection inside another.
 */
export function strip(content: string): string {
  let c = content;
  const idx = c.search(ANY_MARKER);
  if (idx >= 0) c = `${c.slice(0, idx).trimEnd()}\n`;
  c = c.replace(
    /performance\.mark\("code\/didLoadWorkbenchMain"\),B\.main\(S\),[^}]+\}\)\(\);/,
    HOOK,
  );
  return c;
}

/** Whether this build of Cursor still has the shape the patch needs. */
export function canHook(pristine: string): boolean {
  return pristine.includes(HOOK);
}

/** The patched file contents, given already-stripped source and the script. */
export function buildPatched(pristine: string, script: string): string {
  return `${pristine.replace(HOOK, HOOKED)}\n${MARKER}\nfunction PRMPT_RUN(){${script}}\n`;
}
