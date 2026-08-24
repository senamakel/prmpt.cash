#!/usr/bin/env node
// adengine -- publisher registration.
//
//   node hooks/register.mjs <solana-wallet-address>
//
// Validates the wallet locally, registers it with the backend, and persists
// {installId, apiKey, endpoint} to ~/.config/adengine/config.json at mode 0600.
//
// This is the one place in the plugin that is allowed to be loud: it is run by
// hand, and a silent failure here would leave the publisher wondering why they
// are never paid.

import process from 'node:process';

import { DEFAULT_ENDPOINT, writeConfig, configPath, resolveInstallId } from './lib/config.mjs';
import { registerPublisher } from './lib/api.mjs';

// Base58 as Solana uses it: no 0, O, I or l.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Client-side wallet check.
 *
 * Length and alphabet only -- a real ed25519 curve check is the backend's job.
 * The point is to catch a typo or a pasted transaction signature before we
 * mint a key against an address that can never receive USDC.
 */
export function validateWallet(wallet) {
  if (typeof wallet !== 'string') return 'wallet must be a string';
  const w = wallet.trim();
  if (w.length < 32 || w.length > 44) {
    return `wallet must be 32-44 characters, got ${w.length}`;
  }
  if (!BASE58.test(w)) {
    return 'wallet must be base58 (no 0, O, I or l)';
  }
  return null;
}

/** Show enough of the key to identify it, never enough to use it. */
function maskKey(apiKey) {
  if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 4)}${'*'.repeat(Math.min(24, apiKey.length - 8))}${apiKey.slice(-4)}`;
}

async function main() {
  const [wallet] = process.argv.slice(2);

  if (!wallet || wallet === '-h' || wallet === '--help') {
    process.stderr.write(
      'usage: node hooks/register.mjs <solana-wallet-address>\n\n' +
      '  Registers your wallet as an adengine publisher and writes the API key\n' +
      `  to ${configPath()} (mode 0600).\n\n` +
      `  Endpoint: $ADENGINE_ENDPOINT (default ${DEFAULT_ENDPOINT})\n`,
    );
    process.exit(wallet ? 0 : 2);
  }

  const problem = validateWallet(wallet);
  if (problem) {
    process.stderr.write(`adengine: invalid Solana wallet -- ${problem}\n`);
    process.exit(1);
  }

  const endpoint = (process.env.ADENGINE_ENDPOINT || '').trim() || DEFAULT_ENDPOINT;
  const solanaWallet = wallet.trim();

  let result;
  try {
    result = await registerPublisher({ endpoint, solanaWallet });
  } catch (err) {
    process.stderr.write(`adengine: registration failed -- ${err?.message ?? err}\n`);
    process.stderr.write(`adengine: endpoint was ${endpoint}\n`);
    process.exit(1);
  }

  const installId = result.installId || resolveInstallId();

  let file;
  try {
    file = writeConfig({ installId, apiKey: result.apiKey, endpoint, solanaWallet });
  } catch (err) {
    process.stderr.write(`adengine: could not write config -- ${err?.message ?? err}\n`);
    process.exit(1);
  }

  process.stdout.write(
    'adengine: registered.\n' +
    `  wallet:     ${solanaWallet}\n` +
    `  install id: ${installId}\n` +
    `  api key:    ${maskKey(result.apiKey)}  (stored, not shown)\n` +
    `  endpoint:   ${endpoint}\n` +
    `  config:     ${file} (0600)\n\n` +
    'Clicks on ads served from this install now pay 70% of the clearing price\n' +
    'to that wallet in USDC. Set ADENGINE_DISABLED=1 to turn serving off.\n',
  );
}

main().catch((err) => {
  process.stderr.write(`adengine: ${err?.message ?? err}\n`);
  process.exit(1);
});
