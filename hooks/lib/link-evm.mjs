// prmpt -- backfilling the Base address on an install that predates it.
//
// Payouts settle on two chains now, and ERC-20s — including USDC, the default —
// go to Base. An install created before that has proven only its Solana
// address, so its earnings accrue and park: real money, owed, unsendable.
//
// Self-enrolment does not cover this. It fires only when there is NO token, and
// these installs have one, so they update to the new plugin and then sit there
// unchanged forever. Every existing publisher is in exactly that state, which
// is why this exists rather than a line in a release note asking people to
// re-run `prmpt login`.
//
// Two rules it inherits from the hook it serves: never on the turn's clock, and
// never a word to the user. It also inherits enrolment's marker-file rate
// limit, because each turn is a fresh process with no memory of the last.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { configDir } from './config.mjs';
import { loadWallet } from './wallet.mjs';

/** How long before a failed attempt is retried. Matches enrolment. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

function attemptMarkerPath() {
  return path.join(configDir(), '.evm-link-attempt');
}

function shouldAttempt() {
  if (process.env.PRMPT_NO_AUTO_ENROL === '1') return false;
  try {
    const stat = fs.statSync(attemptMarkerPath());
    return Date.now() - stat.mtimeMs > RETRY_AFTER_MS;
  } catch {
    return true;
  }
}

function markAttempt() {
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(attemptMarkerPath(), new Date().toISOString() + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

/**
 * Should this install backfill a Base address in the background?
 *
 * `config` is what loadConfig returned, and `localAddress` is the address of
 * the wallet on this machine (null when there is none).
 *
 * The last condition is the important one, and it is a refusal rather than a
 * capability. An install linked with a dashboard code holds a token for a
 * wallet that is deliberately NOT on this machine — that is the whole reason
 * that flow exists. Generating an EVM key here and attaching it to their
 * account would put a key on a box they specifically chose to keep keys off,
 * and it would do it silently. So this only ever runs where the local key IS
 * already the publisher's identity, and those installs are told to link from
 * the dashboard instead.
 */
export function needsEvmLink(config) {
  if (!config?.token) return false;        // enrolment's job, not ours
  if (config.evmWallet) return false;      // already linked
  if (!config.solanaWallet) return false;  // cannot tell whose account this is
  return true;
}

/**
 * The address of the wallet on this machine, or null.
 *
 * Never throws: a corrupt keystore is a reason to do nothing quietly, not to
 * surface an error in somebody's coding session.
 */
function localWalletAddress() {
  try {
    return loadWallet()?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Detach a child that proves and links the Base address, and return at once.
 *
 * It runs `prmpt link-evm`, NOT `prmpt login`. The difference is not cosmetic:
 * `login` signs in as whatever key is on this machine, so on an install whose
 * token belongs to a different wallet it would quietly switch the publisher —
 * and the user would start earning into an account they have never seen. This
 * subcommand only ever adds an address to the account the stored token already
 * speaks for.
 */
export function linkEvmInBackground(config) {
  // Ordered cheapest-first, and that ordering is the point. This runs on every
  // turn of every install, so the config checks and the marker file -- both
  // trivial -- have to fail fast before anything reads a keystore. Deriving an
  // address from a seed phrase means PBKDF2 over 2048 rounds; doing that on a
  // turn that was never going to link anything would be a real cost paid
  // forever by installs that can never satisfy the condition below.
  if (!needsEvmLink(config)) return false;
  if (!shouldAttempt()) return false;

  const local = localWalletAddress();
  // Refuse when the key here is not this account's own -- see the note above.
  if (!local || local !== config.solanaWallet) return false;

  markAttempt();

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cli = path.resolve(here, '..', '..', 'bin', 'prmpt.mjs');
    if (!fs.existsSync(cli)) return false;
    const child = spawn(process.execPath, [cli, 'link-evm'], {
      detached: true,
      stdio: 'ignore',
      cwd: os.tmpdir(),
      env: { ...process.env, PRMPT_ENDPOINT: config.endpoint },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
