import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as configModule from '../hooks/lib/config.mjs';

async function withConfigEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmpt-config-'));
  const keys = [
    'XDG_CONFIG_HOME', 'PRMPT_TOKEN', 'PRMPT_API_KEY', 'PRMPT_ENDPOINT',
    'PRMPT_TIMEOUT_MS', 'PRMPT_DISABLED',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.XDG_CONFIG_HOME = root;
  for (const key of keys.slice(1)) delete process.env[key];
  try {
    await fn(configModule, root);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('config paths honour XDG_CONFIG_HOME and stored config is defensive', async () => {
  await withConfigEnv(async ({ configDir, configPath, readStoredConfig }, root) => {
    assert.equal(configDir(), path.join(root, 'prmpt'));
    assert.equal(configPath(), path.join(root, 'prmpt', 'config.json'));
    assert.deepEqual(readStoredConfig(), {});

    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configPath(), 'null');
    assert.deepEqual(readStoredConfig(), {});
    fs.writeFileSync(configPath(), '{broken');
    assert.deepEqual(readStoredConfig(), {});
  });
});

test('writeConfig merges values and locks down the file', async () => {
  await withConfigEnv(async ({ configPath, writeConfig }) => {
    writeConfig({ token: 'first', endpoint: 'https://one.example/graphql' });
    const file = writeConfig({ token: 'second' });
    assert.equal(file, configPath());
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      token: 'second',
      endpoint: 'https://one.example/graphql',
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
});

test('install and session ids use supplied ids and stable fallbacks', async () => {
  await withConfigEnv(async ({ resolveInstallId, resolveSessionId }) => {
    assert.equal(resolveInstallId({ installId: 'installed-here' }), 'installed-here');
    const generated = resolveInstallId({});
    assert.match(generated, /^[a-f0-9]{32}$/);
    assert.equal(resolveInstallId({}), generated);

    assert.equal(resolveSessionId({ session_id: 'claude' }), 'claude');
    assert.equal(resolveSessionId({ sessionId: 'camel' }), 'camel');
    assert.equal(resolveSessionId({ 'thread-id': 'codex' }), 'codex');
    const session = resolveSessionId({}, '/tmp/repository');
    assert.match(session, /^[a-f0-9]{32}$/);
    assert.equal(resolveSessionId({}, '/tmp/repository'), session);
  });
});

test('loadConfig layers environment over disk and validates the timeout', async () => {
  await withConfigEnv(async ({ DEFAULT_ENDPOINT, loadConfig, writeConfig }) => {
    const defaults = loadConfig({ cwd: '/workspace', session_id: 'session' });
    assert.equal(defaults.endpoint, DEFAULT_ENDPOINT);
    assert.equal(defaults.timeoutMs, 1500);
    assert.equal(defaults.cwd, '/workspace');

    writeConfig({ token: ' disk-token ', endpoint: ' https://disk.example/graphql ' });
    let loaded = loadConfig({ session_id: 'session' });
    assert.equal(loaded.token, 'disk-token');
    assert.equal(loaded.endpoint, 'https://disk.example/graphql');

    process.env.PRMPT_TOKEN = ' env-token ';
    process.env.PRMPT_ENDPOINT = ' https://env.example/graphql ';
    process.env.PRMPT_TIMEOUT_MS = '250';
    process.env.PRMPT_DISABLED = '1';
    loaded = loadConfig({ session_id: 'session' });
    assert.equal(loaded.token, 'env-token');
    assert.equal(loaded.endpoint, 'https://env.example/graphql');
    assert.equal(loaded.timeoutMs, 250);
    assert.equal(loaded.disabled, true);

    delete process.env.PRMPT_TOKEN;
    process.env.PRMPT_API_KEY = 'legacy-token';
    process.env.PRMPT_TIMEOUT_MS = '-1';
    loaded = loadConfig({ session_id: 'session' });
    assert.equal(loaded.token, 'legacy-token');
    assert.equal(loaded.timeoutMs, 1500);
  });
});

test('detectRepo identifies marker languages without reading recursively', async () => {
  await withConfigEnv(async ({ detectRepo }, root) => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module example');
    fs.writeFileSync(path.join(repo, 'demo.csproj'), '<Project/>');

    assert.deepEqual(detectRepo(repo), {
      repoLanguage: 'go',
      fileTypes: ['.go', '.ts', '.tsx', '.cs'],
    });
    assert.deepEqual(detectRepo(path.join(root, 'missing')), {
      repoLanguage: null,
      fileTypes: [],
    });
  });
});
