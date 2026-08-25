// prmpt -- the CLI, driven as a real subprocess.
//
// Spawning rather than importing is the point: the CLI's contract is argv in,
// stdout/stderr/exit code out, and the direct-invocation guard that decides
// whether it runs at all is only exercised by actually running it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/prmpt.mjs', import.meta.url));

/** Run the CLI against a scratch config home. Never rejects; returns the result. */
async function prmpt(args, home, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        // A clean env: an inherited PRMPT_TOKEN or PRMPT_ENDPOINT from the
        // developer's shell would quietly change what these assert.
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: home,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-cli-'));
}

test('help lists the commands and exits 0', async () => {
  const home = tempHome();
  const { code, stdout } = await prmpt(['help'], home);
  assert.equal(code, 0);
  for (const fragment of ['login', 'status', 'logout', 'wallet new', 'wallet import', 'wallet export', 'link']) {
    assert.ok(stdout.includes(fragment), `help should mention ${fragment}`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('an unknown command exits non-zero and says so', async () => {
  const home = tempHome();
  const { code, stderr } = await prmpt(['frobnicate'], home);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command: frobnicate/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('status on a fresh machine reports no wallet and no token', async () => {
  const home = tempHome();
  const { code, stdout } = await prmpt(['status'], home);
  assert.equal(code, 0);
  assert.match(stdout, /wallet:\s+none yet/);
  assert.match(stdout, /token:\s+none/);
  // And it created nothing on the way -- status is read-only.
  assert.equal(fs.existsSync(path.join(home, 'prmpt', 'wallet.json')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

/** The Solana and Base addresses `prmpt wallet` prints, in that order. */
function addresses(stdout) {
  return {
    solana: stdout.match(/solana\s+(\S+)/)[1],
    base: stdout.match(/base\s+(\S+)/)[1],
  };
}

test('wallet new creates both chains from one phrase, and refuses to clobber it', async () => {
  const home = tempHome();

  const created = await prmpt(['wallet', 'new'], home);
  assert.equal(created.code, 0);
  const solana = created.stdout.match(/solana:\s+(\S+)/)[1];
  const base = created.stdout.match(/base:\s+(\S+)/)[1];
  assert.match(base, /^0x[0-9a-fA-F]{40}$/);

  const shown = addresses((await prmpt(['wallet'], home)).stdout);
  assert.equal(shown.solana, solana);
  assert.equal(shown.base, base);

  // The phrase is the backup, and it must actually be printable -- an install
  // whose only copy of the key cannot be written down is not backed up.
  const phrase = await prmpt(['wallet', 'mnemonic'], home);
  assert.equal(phrase.code, 0);
  assert.equal(phrase.stdout.trim().split(/\s+/).length, 12);

  const refused = await prmpt(['wallet', 'new'], home);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already exists/);
  assert.match(refused.stderr, /--force/);
  // Refusing means refusing: the key on disk is untouched.
  assert.deepEqual(addresses((await prmpt(['wallet'], home)).stdout), shown);

  const forced = await prmpt(['wallet', 'new', '--force'], home);
  assert.equal(forced.code, 0);
  const replaced = addresses((await prmpt(['wallet'], home)).stdout);
  assert.notEqual(replaced.solana, solana);
  // Both chains move together: they come from one phrase, so a new phrase
  // must not leave the Base address pointing at the old wallet.
  assert.notEqual(replaced.base, base);
  assert.match(forced.stdout, new RegExp(`replaced: ${solana}`));

  fs.rmSync(home, { recursive: true, force: true });
});

test('a seed phrase imports both chains and derives the same addresses', async () => {
  const source = tempHome();
  await prmpt(['wallet', 'new'], source);
  const original = addresses((await prmpt(['wallet'], source)).stdout);
  const phrase = (await prmpt(['wallet', 'mnemonic'], source)).stdout.trim();

  const target = tempHome();
  const imported = await prmpt(['wallet', 'import', phrase], target);
  assert.equal(imported.code, 0, imported.stderr);
  // Same phrase, same wallet, on both chains -- which is the whole reason the
  // phrase is what we ask people to back up.
  assert.deepEqual(addresses((await prmpt(['wallet'], target)).stdout), original);

  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('export round-trips through import, in both formats', async () => {
  const source = tempHome();
  await prmpt(['wallet', 'new'], source);
  const address = addresses((await prmpt(['wallet'], source)).stdout).solana;

  for (const flags of [[], ['--json']]) {
    const exported = await prmpt(['wallet', 'export', ...flags], source);
    assert.equal(exported.code, 0);
    // The key goes to stdout alone so `> key.txt` captures exactly the key; the
    // warning goes to stderr.
    assert.match(exported.stderr, /private key for/);

    const target = tempHome();
    const imported = await prmpt(['wallet', 'import', exported.stdout.trim()], target);
    assert.equal(imported.code, 0, imported.stderr);
    // A RAW key round-trips the Solana address only: no phrase exists behind
    // it, so the Base address on the far side is a freshly generated one.
    assert.equal(addresses((await prmpt(['wallet'], target)).stdout).solana, address);
    fs.rmSync(target, { recursive: true, force: true });
  }

  fs.rmSync(source, { recursive: true, force: true });
});

test('import reads the key from stdin when given -', async () => {
  const source = tempHome();
  await prmpt(['wallet', 'new'], source);
  const address = addresses((await prmpt(['wallet'], source)).stdout).solana;
  const secret = (await prmpt(['wallet', 'export'], source)).stdout.trim();

  const target = tempHome();
  const child = execFile(process.execPath, [CLI, 'wallet', 'import', '-'], {
    env: { PATH: process.env.PATH, HOME: target, XDG_CONFIG_HOME: target },
  });
  child.stdin.end(`${secret}\n`);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  assert.equal(addresses((await prmpt(['wallet'], target)).stdout).solana, address);

  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test('importing the wallet already in place is a no-op, not a replacement', async () => {
  const home = tempHome();
  await prmpt(['wallet', 'new'], home);
  const secret = (await prmpt(['wallet', 'export'], home)).stdout.trim();
  const again = await prmpt(['wallet', 'import', secret], home);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already the wallet here/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('importing rubbish fails without touching the existing key', async () => {
  const home = tempHome();
  await prmpt(['wallet', 'new'], home);
  const address = (await prmpt(['wallet'], home)).stdout.trim();

  const bad = await prmpt(['wallet', 'import', 'definitely-not-a-key'], home);
  assert.equal(bad.code, 1);
  assert.equal((await prmpt(['wallet'], home)).stdout.trim(), address);
  fs.rmSync(home, { recursive: true, force: true });
});

test('status reads the expiry out of the stored JWT', async () => {
  const home = tempHome();
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
    Buffer.from(JSON.stringify({ typ: 'publisher', exp })).toString('base64url'),
    'not-a-real-signature',
  ].join('.');

  fs.mkdirSync(path.join(home, 'prmpt'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'prmpt', 'config.json'),
    JSON.stringify({ token: jwt, installId: 'abc', endpoint: 'http://example.test/graphql' }),
  );

  const { stdout } = await prmpt(['status'], home);
  assert.match(stdout, /29 days left|30 days left/);
  assert.match(stdout, /endpoint:\s+http:\/\/example\.test\/graphql/);
  // Never the whole token.
  assert.equal(stdout.includes(jwt), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('status reports a token supplied by the environment as such', async () => {
  const home = tempHome();
  const { stdout } = await prmpt(['status'], home, { PRMPT_TOKEN: 'a'.repeat(40) });
  assert.match(stdout, /from PRMPT_TOKEN/);
  assert.equal(stdout.includes('a'.repeat(40)), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('logout forgets the token and leaves the wallet alone', async () => {
  const home = tempHome();
  await prmpt(['wallet', 'new'], home);
  const address = (await prmpt(['wallet'], home)).stdout.trim();
  fs.writeFileSync(
    path.join(home, 'prmpt', 'config.json'),
    JSON.stringify({ token: 'a-token', installId: 'abc' }),
  );

  const { code, stdout } = await prmpt(['logout'], home);
  assert.equal(code, 0);
  assert.match(stdout, /Nothing was revoked/);

  const config = JSON.parse(fs.readFileSync(path.join(home, 'prmpt', 'config.json'), 'utf8'));
  assert.equal('token' in config, false);
  assert.equal(config.installId, 'abc');
  assert.equal((await prmpt(['wallet'], home)).stdout.trim(), address);

  fs.rmSync(home, { recursive: true, force: true });
});

test('link rejects a malformed code before spending a round trip', async () => {
  const home = tempHome();
  const { code, stderr } = await prmpt(['link', 'ABC'], home, {
    // If validation ever stopped happening first, this endpoint would make the
    // failure a connection error rather than the message asserted below.
    PRMPT_ENDPOINT: 'http://127.0.0.1:1/graphql',
  });
  assert.equal(code, 1);
  assert.match(stderr, /invalid install code/);
  fs.rmSync(home, { recursive: true, force: true });
});
