// Linux host E2E: package the editor integration, then hand that exact VSIX to
// the real VS Code CLI.  Unit tests cover the extension's TypeScript and its
// Cursor patch surgery; this test catches the separate release-time failures:
// an invalid VSIX, a malformed manifest, or an extension identifier that the
// editor refuses to install.
//
// It is deliberately opt-in locally.  The Linux workflow supplies the two
// paths after downloading VS Code and building the VSIX, so a missing artifact
// or host binary is a CI failure instead of a skipped green build.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exec, smokeEnv } from './lib.mjs';

const REQUIRE = process.env.PRMPT_SMOKE_REQUIRE_LINUX_E2E === '1';
const CODE = process.env.PRMPT_CODE_BIN;
const VSIX = process.env.PRMPT_VSIX;
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).version;

function required(value, label) {
  assert.ok(value, `${label} must be set by the Linux E2E workflow`);
  assert.ok(fs.existsSync(value), `${label} does not exist: ${value}`);
  return value;
}

test('the packaged VS Code integration installs through the real Linux CLI', {
  skip: !REQUIRE && 'only enforced in the Linux E2E workflow',
}, async () => {
  assert.equal(process.platform, 'linux', 'this E2E contract is Linux-specific');
  const code = required(CODE, 'PRMPT_CODE_BIN');
  const vsix = required(VSIX, 'PRMPT_VSIX');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-vscode-e2e-'));
  const extensions = path.join(home, 'extensions');

  try {
    const installed = await exec(code, [
      '--install-extension', vsix, '--force', '--extensions-dir', extensions,
    ], { env: smokeEnv(home), timeout: 120_000 });
    assert.equal(
      installed.code,
      0,
      `VS Code rejected the packaged extension:\n${installed.stdout}\n${installed.stderr}`,
    );

    const listed = await exec(code, ['--list-extensions', '--show-versions', '--extensions-dir', extensions], {
      env: smokeEnv(home),
      timeout: 60_000,
    });
    assert.equal(listed.code, 0, `VS Code could not list installed extensions:\n${listed.stderr}`);
    assert.match(
      listed.stdout,
      new RegExp(`^prmpt\\.prmpt@${VERSION.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}$`, 'm'),
      `VS Code did not register prmpt from the VSIX:\n${listed.stdout}\n${listed.stderr}`,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
