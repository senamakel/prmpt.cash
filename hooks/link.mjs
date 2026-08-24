#!/usr/bin/env node
// prmpt -- link this install to a publisher account.
//
//   node hooks/link.mjs <install-code>
//
// Redeems a one-off code from the dashboard and persists
// {installId, token, endpoint} to ~/.config/prmpt/config.json at mode 0600.
//
// This used to take a wallet address and mint an API key, which meant the
// address was merely ASSERTED -- anyone could register a stranger's wallet and
// be paid into it. The wallet is now proven by signature in the dashboard,
// which is the only place a wallet prompt can open, and this exchanges the code
// that proof produced.
//
// This is the one place in the plugin that is allowed to be loud: it is run by
// hand, and a silent failure here would leave the publisher wondering why they
// are never paid.

import process from 'node:process';

import { DEFAULT_ENDPOINT, writeConfig, configPath, resolveInstallId } from './lib/config.mjs';
import { exchangeInstallCode } from './lib/api.mjs';

// Crockford-ish base32: the code alphabet the backend mints from, which omits
// every character that gets misread off a screen -- no I, L, O, U, 0 or 1.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

/**
 * Normalise a pasted code the same way the backend does before hashing it.
 *
 * Case, hyphens and stray spaces are all discarded, so a code typed by hand
 * still matches the one that was minted. This has to agree with
 * NormalizeInstallCode in backend/internal/auth/install_code.go or a perfectly
 * correct code fails to redeem.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw.trim().toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/**
 * Client-side shape check.
 *
 * Catches a truncated paste before spending the code on a round trip. Whether
 * the code is real is the backend's call, and a wrong one is single-use there
 * too -- so it is worth not sending obvious garbage.
 */
export function validateCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return 'the code is empty, or contains none of the code alphabet';
  if (code.length !== CODE_LENGTH) {
    return `an install code is ${CODE_LENGTH} characters, got ${code.length}`;
  }
  return null;
}

/** Show enough of the token to identify it, never enough to use it. */
function maskToken(token) {
  if (token.length <= 12) return '*'.repeat(token.length);
  return `${token.slice(0, 6)}${'*'.repeat(24)}${token.slice(-4)}`;
}

async function main() {
  const [arg] = process.argv.slice(2);
  const fromEnv = (process.env.PRMPT_LOGIN_CODE || '').trim();
  const raw = arg || fromEnv;

  if (!raw || raw === '-h' || raw === '--help') {
    process.stderr.write(
      'usage: node hooks/link.mjs <install-code>\n\n' +
      '  Sign in with your wallet at the dashboard, choose "Link a plugin\n' +
      '  install", and paste the code it gives you here. It works once and\n' +
      '  expires in ten minutes.\n\n' +
      `  The token is written to ${configPath()} (mode 0600).\n` +
      '  PRMPT_LOGIN_CODE is read when no argument is given.\n\n' +
      `  Endpoint: $PRMPT_ENDPOINT (default ${DEFAULT_ENDPOINT})\n`,
    );
    process.exit(raw ? 0 : 2);
  }

  const problem = validateCode(raw);
  if (problem) {
    process.stderr.write(`prmpt: invalid install code -- ${problem}\n`);
    process.exit(1);
  }

  const endpoint = (process.env.PRMPT_ENDPOINT || '').trim() || DEFAULT_ENDPOINT;
  const code = normalizeCode(raw);

  let result;
  try {
    result = await exchangeInstallCode({ endpoint, code });
  } catch (err) {
    process.stderr.write(`prmpt: linking failed -- ${err?.message ?? err}\n`);
    process.stderr.write(
      'prmpt: install codes work once and expire in ten minutes. ' +
      'Mint a fresh one in the dashboard and try again.\n',
    );
    process.stderr.write(`prmpt: endpoint was ${endpoint}\n`);
    process.exit(1);
  }

  const installId = result.installId || resolveInstallId();

  let file;
  try {
    file = writeConfig({
      installId,
      token: result.token,
      endpoint,
      solanaWallet: result.solanaWallet ?? undefined,
      // The retired API key, if this config predates JWT auth. Dropping it
      // stops a stale credential sitting on disk forever.
      apiKey: undefined,
    });
  } catch (err) {
    process.stderr.write(`prmpt: could not write config -- ${err?.message ?? err}\n`);
    process.exit(1);
  }

  process.stdout.write(
    'prmpt: linked.\n' +
    `  wallet:     ${result.solanaWallet ?? '(not reported)'}\n` +
    `  install id: ${installId}\n` +
    `  token:      ${maskToken(result.token)}  (stored, not shown)\n` +
    (result.expiresAt ? `  expires:    ${result.expiresAt}\n` : '') +
    `  endpoint:   ${endpoint}\n` +
    `  config:     ${file} (0600)\n\n` +
    'Clicks on ads served from this install now pay 70% of the clearing price\n' +
    'to that wallet in USDC. Set PRMPT_DISABLED=1 to turn serving off.\n\n' +
    'The token cannot be revoked from here or anywhere else -- it is valid until\n' +
    'it expires. Treat the config file as a credential.\n',
  );
}

main().catch((err) => {
  process.stderr.write(`prmpt: ${err?.message ?? err}\n`);
  process.exit(1);
});
