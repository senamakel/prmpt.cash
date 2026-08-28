// Real Linux UI E2E for the packaged extension.
//
// The test parks the same slot.json the agent hook writes, installs the VSIX
// through the real `code` CLI, starts a real Electron workbench under Xvfb and
// drives its UI over Chromium's debugging protocol.  This verifies the two
// stock-editor surfaces a user sees, plus the loopback delivery used by the
// Cursor composer card.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const CODE = process.env.PRMPT_CODE_BIN || 'code';
const CODE_APP = process.env.PRMPT_CODE_APP || CODE;
const VSIX = process.env.PRMPT_VSIX;
const REQUIRE = process.env.PRMPT_SMOKE_REQUIRE_LINUX_UI === '1';
const ARTIFACTS = process.env.PRMPT_UI_ARTIFACT_DIR;

const MOCK_AD = {
  requestId: 'req_linux_ui_e2e',
  headline: 'Mock ad: Linux UI delivery works',
  body: 'Rendered from a parked agent decision, with no production request.',
  clickUrl: 'https://example.test/c/req_linux_ui_e2e',
  sessionId: 'session-linux-ui-e2e',
  harness: 'codex',
};

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function connect(port, child, logs) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`VS Code exited before its UI was ready (${child.exitCode})\n${logs()}`);
    }
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`VS Code did not expose its UI at ${endpoint}: ${last}\n${logs()}`);
}

async function workbenchPage(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      if (await page.locator('.monaco-workbench').count()) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the VS Code workbench page never appeared');
}

async function openSponsoredView(page) {
  // Explorer is the default container, but explicitly focus it so saved state
  // from the editor version cannot decide whether the contributed view exists.
  const sidebar = page.locator('.part.sidebar').first();
  if (!(await sidebar.isVisible())) await page.keyboard.press('Control+Shift+E');
  await sidebar.waitFor({ state: 'visible', timeout: 10_000 });

  const header = page.locator('.pane-header').filter({ hasText: /Sponsored/ }).first();
  await header.waitFor({ state: 'visible', timeout: 20_000 });
  const expanded = await header.getAttribute('aria-expanded');
  if (expanded === 'false') await header.click();
}

async function waitForWebviewCopy(page, copy) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if ((await frame.locator('body').innerText()).includes(copy)) return;
      } catch {
        // A webview frame can be replaced while the contributed view resolves.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the Sponsored webview never rendered ${JSON.stringify(copy)}`);
}

test('a mock agent ad renders across the real Linux editor UI', {
  skip: !REQUIRE && 'only enforced in the Linux UI E2E workflow',
  timeout: 120_000,
}, async () => {
  assert.equal(process.platform, 'linux');
  assert.ok(process.env.DISPLAY, 'run this test under xvfb-run');
  assert.ok(VSIX && fs.existsSync(VSIX), `PRMPT_VSIX does not exist: ${VSIX}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-linux-ui-'));
  const configHome = path.join(root, 'config');
  const userData = path.join(root, 'user-data');
  const extensions = path.join(root, 'extensions');
  const workspace = path.join(root, 'workspace');
  const slotDir = path.join(configHome, 'prmpt');
  const debugPort = await reservePort();
  const bridgePort = await reservePort();
  const artifactDir = ARTIFACTS || path.join(root, 'artifacts');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.mkdirSync(slotDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# prmpt UI E2E\n');
  fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'prmpt.bridgePort': bridgePort,
  }));
  // Workspace trust is a user setting. Putting it in .vscode/settings.json is
  // too late: Restricted Mode disables the extension before it can read that
  // file, which makes a UI test silently test an inactive extension.
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
  }));
  fs.writeFileSync(path.join(slotDir, 'slot.json'), JSON.stringify({ ...MOCK_AD, ts: Date.now() }), {
    mode: 0o600,
  });
  const chatModule = path.join(root, 'chatInject.mjs');
  await build({
    entryPoints: [path.resolve('src/chatInject.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: chatModule,
    logLevel: 'silent',
  });
  const { chatInjectScript } = await import(pathToFileURL(chatModule).href);

  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(root, 'data'),
    PRMPT_NO_AUTO_ENROL: '1',
    PRMPT_NO_AUTO_UPDATE: '1',
  };
  const install = spawnSync(CODE, [
    '--install-extension', VSIX, '--force', '--extensions-dir', extensions,
  ], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(install.status, 0, `VSIX install failed:\n${install.stdout}\n${install.stderr}`);

  let stdout = '';
  let stderr = '';
  // Launch Electron itself, not the `code` shell wrapper. The wrapper forks
  // the app into another process group, which leaves orphan workbenches after
  // the test and eventually exhausts ports on a busy CI box.
  const child = spawn(CODE_APP, [
    '--new-window', '--wait', '--disable-gpu', '--skip-welcome',
    '--user-data-dir', userData,
    '--extensions-dir', extensions,
    `--remote-debugging-port=${debugPort}`,
    workspace,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  let browser;
  try {
    browser = await connect(debugPort, child, () => `${stdout}\n${stderr}`);
    const page = await workbenchPage(browser);

    const status = page.locator('.statusbar').getByText(MOCK_AD.headline, { exact: true });
    await status.waitFor({ state: 'visible', timeout: 30_000 });

    await openSponsoredView(page);
    await waitForWebviewCopy(page, MOCK_AD.headline);
    await waitForWebviewCopy(page, MOCK_AD.body);

    const bridge = await fetch(`http://127.0.0.1:${bridgePort}/slot`);
    assert.equal(bridge.status, 200, 'the Cursor renderer bridge did not start');
    const delivered = await bridge.json();
    assert.equal(delivered.headline, MOCK_AD.headline);
    assert.equal(delivered.body, MOCK_AD.body);
    assert.equal('clickUrl' in delivered, false, 'the Cursor renderer received the click URL');

    // Cursor itself is proprietary and unavailable on GitHub's stock runner,
    // so exercise its shipped renderer script in this real Electron renderer
    // against the DOM contract Cursor exposes: composer wrapper + editable +
    // Stop control. This is the exact script patched into workbench.js.
    await page.evaluate(() => {
      const scope = document.createElement('section');
      scope.className = 'composer-input-wrapper prmpt-e2e-cursor-composer';
      scope.style.cssText = [
        'position:fixed', 'right:24px', 'bottom:70px', 'width:430px',
        'z-index:10000', 'padding:10px', 'background:var(--vscode-editor-background)',
      ].join(';');
      const stop = document.createElement('button');
      stop.textContent = 'Stop generation';
      stop.style.display = 'none';
      const box = document.createElement('div');
      box.className = 'composer-input-container';
      const input = document.createElement('textarea');
      box.append(stop, input);
      scope.appendChild(box);
      document.body.appendChild(scope);
    });
    // Stock VS Code's workbench CSP rejects renderer-to-loopback requests;
    // Cursor is the host that permits this patched transport. Feed the exact
    // response already proven above into the renderer boundary, and record the
    // /open request, so the proprietary host is the only piece being mocked.
    await page.evaluate((mock) => {
      const originalFetch = window.fetch.bind(window);
      window.__PRMPT_E2E_OPENED__ = false;
      window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/slot')) {
          return new Response(JSON.stringify(mock), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/open')) {
          window.__PRMPT_E2E_OPENED__ = true;
          return new Response(null, { status: 204 });
        }
        return originalFetch(input, init);
      };
    }, delivered);
    await page.evaluate(chatInjectScript(bridgePort));
    const cursorCard = page.locator('[data-prmpt-card="1"]');
    await cursorCard.getByText(MOCK_AD.headline, { exact: true }).waitFor({ timeout: 10_000 });
    await cursorCard.getByText(MOCK_AD.body, { exact: true }).waitFor({ timeout: 10_000 });
    await cursorCard.click();
    await page.waitForFunction(() => window.__PRMPT_E2E_OPENED__ === true);

    await page.screenshot({ path: path.join(artifactDir, 'linux-mock-ad.png'), fullPage: true });
  } catch (err) {
    if (browser) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages[0]) await pages[0].screenshot({ path: path.join(artifactDir, 'linux-ui-failure.png'), fullPage: true });
    }
    throw err;
  } finally {
    try { await browser?.close(); } catch { /* already closed */ }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (!ARTIFACTS) fs.rmSync(root, { recursive: true, force: true });
  }
});
