// The Amp plugin is TypeScript for Bun and cannot be executed under plain
// node, and the suite is dependency-free so there is no transpiler to reach
// for. These are therefore static source assertions -- deliberately narrow,
// and aimed at the two traps the file's own header documents, because both
// are silent in production: one starts an extra turn, the other reads the
// user's prompt and sends it to the ad backend as if it were the reply.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_DIR } from './helpers.mjs';

const AMP = path.join(PLUGIN_DIR, 'amp', 'adengine.ts');
const src = fs.readFileSync(AMP, 'utf8');

/** The source with comments stripped, so prose about a trap is not the trap. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('the agent.end handler never returns an action (which would start another turn)', () => {
  // Any `action:` in a returned object -- `{ action: 'continue' }` and friends
  // -- makes Amp run the agent again, turning one sponsored line into an
  // infinite loop of them.
  assert.ok(
    !/\baction\s*:/.test(code),
    'amp/adengine.ts must never return an `action`; that would start another turn',
  );
  assert.ok(
    !/return\s*\{/.test(code),
    'the agent.end handler must only ever `return` bare (early-exit), never a value',
  );
});

test('it reads event.messages, not event.message', () => {
  // `event.message` is the USER'S prompt that started the turn. Sending that
  // as the turn text would both mis-target the ad and transmit user input.
  assert.ok(/\.messages\b/.test(code), 'amp/adengine.ts must read event.messages');
  assert.ok(
    !/\bevent\s*(?:as[^)]*\)?)?\s*\.message\b(?!s)/.test(code),
    'amp/adengine.ts must not read event.message (that is the user prompt)',
  );
  assert.ok(
    !/\bmessage\b(?!s)\s*:/.test(code.replace(/messages\?:/g, '')),
    'no `message` property should be destructured or typed off the event',
  );
});

test('it stays silent on failure and honours the shared opt-outs', () => {
  assert.ok(/catch\s*\{/.test(code) || /catch\s*\(/.test(code), 'the handler must swallow errors');
  assert.ok(/ADENGINE_DISABLED/.test(code), 'the opt-out must be honoured here too');
  assert.ok(/AbortSignal\.timeout\(\s*TIMEOUT_MS\s*\)/.test(code), 'the request must have a deadline');
  assert.ok(/const TIMEOUT_MS = 1500/.test(code), 'the deadline must match the hook (1500ms)');
  assert.ok(/const MIN_TURN_CHARS = 80/.test(code));
  assert.ok(/const MAX_TURN_CHARS = 4000/.test(code));
});

test('it only ever looks at assistant messages', () => {
  assert.ok(/role\s*!==\s*'assistant'/.test(code), 'non-assistant messages must be skipped');
  assert.ok(/type\s*===\s*'text'/.test(code), 'only text blocks are read; no thinking blocks');
  assert.ok(!/'thinking'/.test(code), 'thinking blocks must never be gathered');
});

test('it does not write to stdout or stderr', () => {
  // Amp surfaces the block through ctx.ui.notify; a console write would land
  // in the middle of the user's session.
  assert.ok(!/console\.(log|error|warn|info)/.test(code));
  assert.ok(!/process\.std(out|err)\.write/.test(code));
  assert.ok(/ctx\.ui\.notify/.test(code));
});
