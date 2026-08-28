// The extension's view of the parked ad, and the loopback bridge that hands it
// to Cursor's renderer.
//
// The slot reader is a port of hooks/lib/slot.mjs and has to agree with it, so
// the fixtures here are the shape the hook actually writes.

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-vsc-slot-'));

let slot;
let bridge;

before(async () => {
  for (const name of ['slot', 'bridge']) {
    await build({
      entryPoints: [path.join(root, 'src', `${name}.ts`)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: path.join(outDir, `${name}.mjs`),
      logLevel: 'silent',
    });
  }
  slot = await import(path.join(outDir, 'slot.mjs'));
  bridge = await import(path.join(outDir, 'bridge.mjs'));
});

/** Point the module at a throwaway config dir, the way the hook lays it out. */
function park(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-cfg-'));
  process.env.XDG_CONFIG_HOME = dir;
  const cfg = path.join(dir, 'prmpt');
  fs.mkdirSync(cfg, { recursive: true });
  if (over !== null) {
    fs.writeFileSync(path.join(cfg, 'slot.json'), JSON.stringify({
      requestId: 'req_abc123',
      headline: 'Ship faster with Widget CI',
      body: 'Parallel test sharding for Node monorepos.',
      clickUrl: 'https://ads.example/c/req_abc123',
      sessionId: 'sess-1',
      harness: 'cursor',
      ts: Date.now(),
      ...over,
    }));
  }
  return cfg;
}

test('reads what the hook parked', () => {
  park();
  const ad = slot.readSlot();
  assert.equal(ad.headline, 'Ship faster with Widget CI');
  assert.equal(ad.clickUrl, 'https://ads.example/c/req_abc123');
  assert.equal(ad.harness, 'cursor');
});

test('an expired slot reads as nothing', () => {
  park({ ts: Date.now() - 60 * 60 * 1000 });
  assert.equal(slot.readSlot(), null);
});

test('no slot, and a corrupt slot, both read as nothing', () => {
  park(null);
  assert.equal(slot.readSlot(), null);
  const cfg = park();
  fs.writeFileSync(path.join(cfg, 'slot.json'), 'not json {');
  assert.equal(slot.readSlot(), null);
});

test('a non-http click URL is refused', () => {
  // The click URL is handed to openExternal. A file: or command: URI reaching
  // that would be a local-execution path out of a file we merely expect to
  // have written ourselves.
  for (const clickUrl of ['file:///etc/passwd', 'command:workbench.action.terminal.new', 'javascript:alert(1)']) {
    park({ clickUrl });
    assert.equal(slot.readSlot(), null, clickUrl);
  }
});

test('a slot missing a headline or URL is refused', () => {
  park({ headline: '   ' });
  assert.equal(slot.readSlot(), null);
  park({ clickUrl: '' });
  assert.equal(slot.readSlot(), null);
});

// --- the bridge -------------------------------------------------------------

test('the bridge binds loopback only, and never exposes the click URL', async () => {
  park();
  let opened = 0;
  const b = new bridge.Bridge(() => { opened++; });
  const port = await b.start(53111);
  assert.ok(port >= 53111, 'a port was claimed');

  const res = await fetch(`http://127.0.0.1:${port}/slot`);
  const body = await res.json();
  assert.equal(body.headline, 'Ship faster with Widget CI');
  assert.equal(
    'clickUrl' in body, false,
    'the renderer must never receive a URL it could navigate to on its own',
  );

  // Clicking is a request to the host, which owns openExternal.
  await fetch(`http://127.0.0.1:${port}/open`);
  assert.equal(opened, 1);

  // Anything else is not served.
  assert.equal((await fetch(`http://127.0.0.1:${port}/../etc/passwd`)).status, 404);

  // Not reachable off loopback.
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const addr of addresses) {
    await assert.rejects(
      fetch(`http://${addr}:${port}/slot`, { signal: AbortSignal.timeout(1500) }),
      `bridge must not answer on ${addr}`,
    );
  }

  b.dispose();
});

test('the bridge serves null rather than failing when nothing is parked', async () => {
  park(null);
  const b = new bridge.Bridge(() => {});
  const port = await b.start(53211);
  const res = await fetch(`http://127.0.0.1:${port}/slot`);
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
  b.dispose();
});

test('a taken port falls through to the next in the range', async () => {
  park();
  const a = new bridge.Bridge(() => {});
  const first = await a.start(53311);
  const b = new bridge.Bridge(() => {});
  const second = await b.start(53311);
  assert.equal(first, 53311);
  assert.equal(second, 53312, 'a second window must not fight the first for the port');
  a.dispose();
  b.dispose();
});
