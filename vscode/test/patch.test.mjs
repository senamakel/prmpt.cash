// The Cursor patch, tested where it can actually hurt someone.
//
// The failure this suite exists to prevent is an editor that will not open.
// Everything asserted here is about the file we write into a real Cursor
// install: that the script inside it parses, that a re-patch does not nest,
// that an unrecognised Cursor is left alone, and that removal is byte-exact.
//
// The modules under test are TypeScript, so the suite compiles them with
// esbuild first and imports the JavaScript. That is deliberate: testing the
// .ts source through a transform nobody ships would prove something other than
// what runs.

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'test', '.compiled');
fs.mkdirSync(outDir, { recursive: true });

let patchText;
let chatInject;

before(async () => {
  // `vscode` is never imported by these two modules, which is the point of
  // having split them out -- so they compile and run outside the editor.
  for (const name of ['patchText', 'chatInject']) {
    await build({
      entryPoints: [path.join(root, 'src', `${name}.ts`)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: path.join(outDir, `${name}.mjs`),
      sourcemap: 'inline',
      logLevel: 'silent',
    });
  }
  patchText = await import(path.join(outDir, 'patchText.mjs'));
  chatInject = await import(path.join(outDir, 'chatInject.mjs'));
});

/** A stand-in for the tail of Cursor's real bootstrap file. */
function fakeBootstrap() {
  return [
    '(function(){',
    '  "use strict";',
    '  var B = require("./workbench.desktop.main");',
    '  var S = { some: "config" };',
    '  performance.mark("code/didLoadWorkbenchMain"),B.main(S)})();',
    '',
  ].join('\n');
}

// --- the thing that would break the editor ---------------------------------

test('the injected script is valid JavaScript', () => {
  const script = chatInject.chatInjectScript(51793);
  assert.doesNotThrow(() => new Function(script));
});

test('the injected script is valid at any configured port', () => {
  for (const port of [1024, 51793, 65000]) {
    const script = chatInject.chatInjectScript(port);
    assert.doesNotThrow(() => new Function(script), `port ${port}`);
    assert.match(script, new RegExp(`PORTS\\.push\\(${port}\\+i\\)`));
  }
});

test('the patched file as a whole is valid JavaScript', () => {
  const script = chatInject.chatInjectScript(51793);
  const out = patchText.buildPatched(fakeBootstrap(), script);
  assert.doesNotThrow(() => new Function(out));
});

test('the injected script never interpolates unescaped copy', () => {
  // Ad copy reaches the renderer over the bridge at runtime and is set with
  // textContent. Nothing model-generated may be baked into the script text.
  const script = chatInject.chatInjectScript(51793);
  // Match assignment, not the word: the script carries a comment explaining
  // why innerHTML is not used, and that comment is not a finding.
  assert.ok(!/\.innerHTML\s*=/.test(script), 'the card must never assign innerHTML');
  assert.ok(!/insertAdjacentHTML|outerHTML\s*=/.test(script));
  assert.match(script, /textContent/);
});

// --- the surgery ------------------------------------------------------------

test('patching rewrites the bootstrap hook and appends the marker', () => {
  const out = patchText.buildPatched(fakeBootstrap(), 'void 0;');
  assert.ok(out.includes('PRMPT_RUN()'), 'the bootstrap must call our entry point');
  assert.ok(patchText.isPatchedText(out));
  assert.ok(!out.includes(patchText.HOOK), 'the original hook line is replaced');
});

test('a build without the hook string is refused, not guessed at', () => {
  const moved = fakeBootstrap().replace('performance.mark("code/didLoadWorkbenchMain")', 'performance.mark("something/else")');
  assert.equal(patchText.canHook(moved), false);
});

test('strip returns a patched file exactly to its pristine form', () => {
  const pristine = fakeBootstrap();
  const patched = patchText.buildPatched(pristine, chatInject.chatInjectScript(51793));
  assert.equal(patchText.strip(patched), pristine);
});

test('re-patching does not nest one injection inside another', () => {
  const pristine = fakeBootstrap();
  let content = patchText.buildPatched(pristine, 'void 1;');
  for (let i = 0; i < 3; i++) {
    content = patchText.buildPatched(patchText.strip(content), 'void 1;');
  }
  assert.equal((content.match(/__PRMPT_PATCH_V/g) || []).length, 1);
  assert.equal((content.match(/function PRMPT_RUN/g) || []).length, 1);
  assert.equal((content.match(/PRMPT_RUN\(\)\},2500\)/g) || []).length, 1);
  assert.doesNotThrow(() => new Function(content));
});

test('a patch from an older marker version is detected as stale', () => {
  const old = `${fakeBootstrap()}\n/*__PRMPT_PATCH_V0__*/\nfunction PRMPT_RUN(){}\n`;
  assert.ok(patchText.isPatchedText(old));
  assert.ok(patchText.isStaleText(old), 'an older marker must be refreshed, not left running');

  const current = patchText.buildPatched(fakeBootstrap(), 'void 0;');
  assert.equal(patchText.isStaleText(current), false);
});

test('an unpatched file is neither patched nor stale', () => {
  assert.equal(patchText.isPatchedText(fakeBootstrap()), false);
  assert.equal(patchText.isStaleText(fakeBootstrap()), false);
});
