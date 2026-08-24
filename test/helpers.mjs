// Shared machinery for the prmpt plugin end-to-end suite.
//
// Every test spawns the real hook as a child process against a stub HTTP
// server on an ephemeral port, so the suite is hermetic, parallel-safe and
// needs no backend. Nothing here imports the hook's modules directly: the
// contract under test is about exit codes, streams and the wire, and only a
// real process boundary exercises those.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(here, '..');
export const TURN_END = path.join(PLUGIN_DIR, 'hooks', 'turn-end.mjs');
export const LINK = path.join(PLUGIN_DIR, 'hooks', 'link.mjs');

/** The token used everywhere, so one assertion can prove it never leaks. */
export const TEST_TOKEN = 'eyJ.test.SECRET_TOKEN_MUST_NEVER_BE_PRINTED';

/** A turn comfortably over the hook's 80 character minimum. */
export const LONG_TURN =
  'I refactored the retry loop in the storage client so a transient 503 backs off ' +
  'exponentially instead of hammering the bucket, and added a regression test.';

/**
 * A throwaway directory, removed when the test process exits.
 *
 * Tests point HOME and XDG_CONFIG_HOME at one of these so a developer's real
 * ~/.config/prmpt/config.json is never read and never written.
 */
const scratch = [];
process.on('exit', () => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export function tmpDir(prefix = 'prmpt-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A minimal environment.
 *
 * Built from scratch rather than spread over `process.env`, because the suite
 * may itself be running inside Claude Code / Codex / Cursor, and an inherited
 * CLAUDECODE or CURSOR_TRACE_ID would silently decide the harness-detection
 * assertions for us.
 */
export function baseEnv(extra = {}) {
  const home = extra.HOME ?? tmpDir('prmpt-home-');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    // Keep colour codes out of the assertions on the text branch.
    NO_COLOR: '1',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Start a stub GraphQL server on an ephemeral port.
 *
 * `handler(body, req, res)` decides the response; returning a plain object
 * sends it as JSON with 200. Every request body is recorded on `.requests`.
 */
export async function stubServer(handler) {
  const requests = [];
  const headers = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      headers.push(req.headers);
      let body = null;
      try { body = JSON.parse(raw); } catch { /* record the raw form below */ }
      requests.push({ raw, body, method: req.method, url: req.url });
      const out = handler(body, req, res);
      if (res.writableEnded || out === undefined) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    headers,
    port,
    url: `http://127.0.0.1:${port}/graphql`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

/** A well-formed serveAd decision. */
export function decision(over = {}) {
  return {
    data: {
      serveAd: {
        requestId: 'req_abc123',
        headline: 'Ship faster with Widget CI',
        body: 'Parallel test sharding for Node monorepos.',
        clickUrl: 'https://ads.example/c/req_abc123',
        ...over,
      },
    },
  };
}

/** Spawn a script and collect exit code, streams and wall-clock duration. */
export function run(script, { args = [], env = baseEnv(), stdin, cwd = PLUGIN_DIR } = {}) {
  const started = process.hrtime.bigint();
  const child = spawn(process.execPath, [script, ...args], {
    env,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  if (stdin === undefined) {
    child.stdin.end();
  } else {
    child.stdin.end(stdin);
  }

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ code, signal, stdout, stderr, ms });
    });
  });
}

/** Spawn the end-of-turn hook. */
export function runHook(opts) {
  return run(TURN_END, opts);
}

/**
 * The core contract: exit 0, nothing on stdout, nothing on stderr.
 *
 * Anything that is not "a real decision arrived inside the deadline" must be
 * indistinguishable from the hook not being installed at all.
 */
export function assertSilentSuccess(res, what) {
  assert.equal(res.code, 0, `${what}: expected exit 0, got ${res.code} (stderr: ${res.stderr})`);
  assert.equal(res.stdout, '', `${what}: expected empty stdout, got ${JSON.stringify(res.stdout)}`);
  assert.equal(res.stderr, '', `${what}: expected empty stderr, got ${JSON.stringify(res.stderr)}`);
}

/** The API key must never reach a stream a human or a log can see. */
export function assertNoKeyLeak(res, what) {
  assert.ok(!res.stdout.includes(TEST_TOKEN), `${what}: token leaked to stdout`);
  assert.ok(!res.stderr.includes(TEST_TOKEN), `${what}: token leaked to stderr`);
}

/** Write a Claude Code JSONL transcript and return its path. */
export function writeTranscript(entries, dir = tmpDir('prmpt-transcript-')) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

/** A Claude Code assistant transcript entry. */
export function assistantEntry(content, { version = '1.0.128', model = 'claude-opus-4-6' } = {}) {
  return {
    type: 'assistant',
    version,
    message: {
      role: 'assistant',
      model,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    },
  };
}

/** A Claude Code user transcript entry. */
export function userEntry(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

/** The input object the hook posted, from a recorded stub request. */
export function servedInput(server, index = 0) {
  return server.requests[index]?.body?.variables?.input;
}
