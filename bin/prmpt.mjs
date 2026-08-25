#!/usr/bin/env node
// prmpt -- the wallet and account CLI.
//
//   prmpt login             create a wallet if needed, sign in, store the token
//   prmpt status            what this install is, without revealing anything
//   prmpt wallet ...        new / show / import / export / path
//   prmpt link <code>       the dashboard route, for a key that stays elsewhere
//   prmpt logout            forget the token locally
//
// This is the loud half of the plugin. The hook is silent by contract; every
// command here is run by hand by somebody waiting for an answer, so failures
// are printed in full and the exit code is meaningful.

import process from 'node:process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_ENDPOINT,
  configPath,
  writeConfig,
  readStoredConfig,
  resolveInstallId,
} from '../hooks/lib/config.mjs';
import {
  walletPath,
  loadWallet,
  saveWallet,
  generateWallet,
  walletFromSecret,
} from '../hooks/lib/wallet.mjs';
import { loginWithWallet } from '../hooks/lib/login.mjs';
import { currentVersion, pluginRoot } from '../hooks/lib/version.mjs';
import { planUpdate, applyUpdate, updateBlocker } from '../hooks/lib/update.mjs';
import { RELEASE_REPO } from '../hooks/lib/release.mjs';
import { exchangeInstallCode } from '../hooks/lib/api.mjs';
import { normalizeCode, validateCode } from '../hooks/lib/install-code.mjs';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

class UserError extends Error {}

/** Endpoint resolution matches the hook's: env, then config, then the default. */
function resolveEndpoint() {
  const fromEnv = (process.env.PRMPT_ENDPOINT || '').trim();
  if (fromEnv) return fromEnv;
  const stored = readStoredConfig().endpoint;
  return (typeof stored === 'string' && stored.trim()) || DEFAULT_ENDPOINT;
}

/** Show enough of a secret to recognise it, never enough to use it. */
function mask(value) {
  if (typeof value !== 'string' || !value) return '(none)';
  if (value.length <= 12) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}${'*'.repeat(20)}${value.slice(-4)}`;
}

/** A wallet address, elided in the middle the way explorers show them. */
function shortAddress(address) {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

const HELP = `prmpt -- sponsored lines for coding agents

usage: prmpt <command> [options]

  login [--endpoint <url>]   Create a wallet if there isn't one, prove it to the
                             backend, and store the token. Safe to re-run: it
                             refreshes an expiring token without touching the key.
  status                     Wallet, token and endpoint for this install.
  logout                     Forget the token. The wallet file is left alone.

  wallet                     Show the wallet address (same as 'wallet show').
  wallet new [--force]       Generate a fresh wallet. Refuses to overwrite one
                             unless --force, because there is no undo.
  wallet import <secret>     Adopt an existing key. Accepts base58 (Phantom and
                             Solflare "export private key") or a solana-keygen
                             JSON array. Pass - to read it from stdin.
  wallet export [--json]     Print the secret key. Only ever do this to back it up.
  wallet path                Where the key file lives.

  update [--check]           Update this install to the latest GitHub release.
                             --check reports without changing anything;
                             --version <tag> pins to a specific release, which
                             may be a downgrade; --dry-run says what it would do.
  version                    What is installed here.

  link <code>                The dashboard route: prove the wallet in a browser
                             and redeem the one-off code it mints. Use this when
                             the key must never be on this machine.

  help                       This text.

Environment:
  PRMPT_ENDPOINT        API endpoint (default ${DEFAULT_ENDPOINT})
  PRMPT_TOKEN           Overrides the stored token entirely
  PRMPT_DISABLED        Set to 1 to stop the hook serving anything
  PRMPT_NO_AUTO_UPDATE  Set to 1 to stop this install updating itself
  PRMPT_NO_AUTO_ENROL   Set to 1 to stop it creating a wallet on its own

This install updates itself: once a day the hook detaches a child that checks
${RELEASE_REPO} for a newer release and, if there is one, verifies its
checksum and swaps this directory for it. Your token and wallet key live in
~/.config/prmpt and are never touched by that.

The wallet is a hot wallet: a cleartext key at mode 0600 under your home
directory. It holds ad revenue, not savings. Back it up, and prefer
'wallet import' if you would rather be paid into a wallet you already have.`;

// --- commands ---------------------------------------------------------------

async function cmdLogin(args) {
  const flagIndex = args.indexOf('--endpoint');
  const endpoint = flagIndex !== -1 ? args[flagIndex + 1] : resolveEndpoint();
  if (!endpoint) throw new UserError('--endpoint needs a URL');

  const before = loadWallet();
  const result = await loginWithWallet({ endpoint });

  if (result.walletCreated) {
    out('prmpt: created a wallet for this install.');
    out('');
    out(`  ${result.wallet.address}`);
    out('');
    out(`  The key is at ${walletPath()} (mode 0600) and is the only copy.`);
    out("  Back it up with 'prmpt wallet export' -- if you lose it, the earnings");
    out('  paid to that address are gone with it.');
    out('');
  } else if (before) {
    out(`prmpt: signed in as ${result.wallet.address}`);
  }

  out('prmpt: linked.');
  out(`  wallet:     ${result.wallet.address}`);
  out(`  install id: ${result.installId}`);
  out(`  token:      ${mask(result.token)}  (stored, not shown)`);
  if (result.expiresAt) out(`  expires:    ${result.expiresAt}`);
  out(`  endpoint:   ${result.endpoint}`);
  out(`  config:     ${result.configFile} (0600)`);
  out('');
  out('Clicks on ads served from this install now pay 70% of the clearing price');
  out('to that wallet in USDC. Set PRMPT_DISABLED=1 to turn serving off.');
  out('');
  out('The token cannot be revoked from here or anywhere else -- it is valid until');
  out('it expires. Treat the config file as a credential.');
}

function cmdStatus() {
  const stored = readStoredConfig();
  const envToken = (process.env.PRMPT_TOKEN || process.env.PRMPT_API_KEY || '').trim();
  const token = envToken || (typeof stored.token === 'string' ? stored.token.trim() : '');

  let wallet = null;
  let walletError = null;
  try {
    wallet = loadWallet();
  } catch (e) {
    walletError = e.message;
  }

  out('prmpt status');
  out('');
  if (walletError) {
    out(`  wallet:     ${walletError}`);
  } else if (!wallet) {
    out("  wallet:     none yet -- run 'prmpt login' to create one");
  } else {
    out(`  wallet:     ${wallet.address}${wallet.imported ? '  (imported)' : ''}`);
    out(`  key file:   ${walletPath()}`);
    if (wallet.addressMismatch) {
      out(`  WARNING:    the file records address ${wallet.addressMismatch}, which this`);
      out('              key does not derive. The key wins. Check the file.');
    }
  }

  if (!token) {
    out("  token:      none -- this install serves nothing. Run 'prmpt login'.");
  } else {
    out(`  token:      ${mask(token)}${envToken ? '  (from PRMPT_TOKEN)' : ''}`);
    // The token is a JWT and carries its own expiry; read that rather than the
    // expiresAt we happened to record, which a hand-edited config could contradict.
    const exp = jwtExpiry(token);
    if (exp) {
      const days = Math.round((exp.getTime() - Date.now()) / 86400000);
      const state = days < 0 ? 'EXPIRED' : `${days} day${days === 1 ? '' : 's'} left`;
      out(`  expires:    ${exp.toISOString()}  (${state})`);
    }
  }

  // The wallet the backend pays, which is not necessarily the local key: an
  // install linked by dashboard code has a token for a wallet this machine
  // cannot sign for at all, and that is a legitimate setup, not a fault.
  const payee = typeof stored.solanaWallet === 'string' ? stored.solanaWallet : '';
  if (payee && (!wallet || payee !== wallet.address)) {
    out(`  paid to:    ${payee}  (not the local key)`);
  }

  out(`  install id: ${stored.installId || resolveInstallId(stored)}`);
  out(`  endpoint:   ${resolveEndpoint()}`);
  out(`  config:     ${configPath()}`);
  out(`  serving:    ${process.env.PRMPT_DISABLED === '1' ? 'off (PRMPT_DISABLED=1)' : 'on'}`);
}

/** Read the `exp` claim of a JWT without verifying it -- display only. */
function jwtExpiry(token) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

function cmdLogout() {
  const stored = readStoredConfig();
  if (!stored.token) {
    out('prmpt: no stored token; nothing to forget.');
    return;
  }
  // undefined is dropped by JSON.stringify, so this removes the field rather
  // than storing a null a later reader would have to special-case.
  writeConfig({ token: undefined });
  out(`prmpt: forgot the token in ${configPath()}.`);
  out('');
  out('Nothing was revoked -- the backend keeps no session, so that token stays');
  out('valid until it expires no matter what this machine does. Your wallet key');
  out(`at ${walletPath()} was left alone; 'prmpt login' signs in again.`);
}

function cmdWallet(args) {
  const [sub = 'show', ...rest] = args;

  switch (sub) {
    case 'show':
    case 'address': {
      const wallet = loadWallet();
      if (!wallet) throw new UserError("no wallet yet -- run 'prmpt login' or 'prmpt wallet new'");
      out(wallet.address);
      return;
    }

    case 'path':
      out(walletPath());
      return;

    case 'new': {
      const force = rest.includes('--force');
      const existing = safeLoadWallet();
      if (existing && !force) {
        throw new UserError(
          `a wallet already exists (${shortAddress(existing.address)}) at ${walletPath()}.\n` +
          "  Back it up first with 'prmpt wallet export', then pass --force.\n" +
          '  Replacing it abandons anything the old address has earned.',
        );
      }
      const wallet = generateWallet();
      const file = saveWallet(wallet);
      out(`prmpt: new wallet ${wallet.address}`);
      out(`  key file: ${file} (0600)`);
      if (existing) out(`  replaced: ${existing.address}`);
      out('');
      out("Run 'prmpt login' to prove it to the backend and start earning.");
      return;
    }

    case 'import': {
      const [source] = rest;
      if (!source) throw new UserError("usage: prmpt wallet import <secret-key>  (or - for stdin)");
      const secret = source === '-' ? fs.readFileSync(0, 'utf8') : source;

      const wallet = walletFromSecret(secret);
      const existing = safeLoadWallet();
      if (existing && existing.address === wallet.address) {
        out(`prmpt: ${wallet.address} is already the wallet here; nothing changed.`);
        return;
      }
      const file = saveWallet(wallet, { imported: true });
      out(`prmpt: imported ${wallet.address}`);
      out(`  key file: ${file} (0600)`);
      if (existing) out(`  replaced: ${existing.address}`);
      out('');
      out("Run 'prmpt login' to prove it to the backend. Earnings from here on go");
      out('to the imported address.');
      return;
    }

    case 'export': {
      const wallet = loadWallet();
      if (!wallet) throw new UserError('no wallet to export');
      if (rest.includes('--json')) {
        // The solana-keygen id.json shape: a 64 number array, seed then public
        // key. What `solana-keygen recover` and the wallet CLIs read back.
        const bytes = Array.from(Buffer.concat([
          Buffer.from(wallet.seed),
          Buffer.from(wallet.publicKey),
        ]));
        out(JSON.stringify(bytes));
      } else {
        out(wallet.secretKey);
      }
      // Guidance on stderr so `prmpt wallet export > key.txt` captures the key
      // alone, and a person watching still gets told what they just did.
      err('');
      err(`prmpt: that is the private key for ${wallet.address}.`);
      err('Anyone holding it can sign as you and move anything the address holds.');
      return;
    }

    default:
      throw new UserError(`unknown wallet command: ${sub}\n  try: show | new | import | export | path`);
  }
}

/** loadWallet, but a corrupt keystore is "no usable wallet" rather than a throw. */
function safeLoadWallet() {
  try {
    return loadWallet();
  } catch {
    return null;
  }
}

async function cmdLink(args) {
  const [raw] = args;
  if (!raw) throw new UserError('usage: prmpt link <install-code>');
  const problem = validateCode(raw);
  if (problem) throw new UserError(`invalid install code -- ${problem}`);

  const endpoint = resolveEndpoint();
  const result = await exchangeInstallCode({ endpoint, code: normalizeCode(raw) });
  const installId = result.installId || resolveInstallId();
  const file = writeConfig({
    installId,
    token: result.token,
    endpoint,
    solanaWallet: result.solanaWallet ?? undefined,
    apiKey: undefined,
  });

  out('prmpt: linked.');
  out(`  wallet:     ${result.solanaWallet ?? '(not reported)'}`);
  out(`  install id: ${installId}`);
  out(`  token:      ${mask(result.token)}  (stored, not shown)`);
  if (result.expiresAt) out(`  expires:    ${result.expiresAt}`);
  out(`  endpoint:   ${endpoint}`);
  out(`  config:     ${file} (0600)`);
}

async function cmdUpdate(args) {
  const quiet = args.includes('--quiet');
  const dryRun = args.includes('--dry-run');
  const check = args.includes('--check');
  const tagIndex = args.indexOf('--version');
  const tag = tagIndex !== -1 ? args[tagIndex + 1] : undefined;
  if (tagIndex !== -1 && !tag) throw new UserError('--version needs a release tag, e.g. v0.2.0');

  // --quiet is for the background child: it must be silent about routine
  // outcomes but must still fail loudly enough to show up in an exit code.
  const say = quiet ? () => {} : out;

  const root = pluginRoot();
  const blocker = updateBlocker(root);
  if (blocker && !check) {
    if (quiet) process.exit(0);
    throw new UserError(`refusing to update -- ${blocker}\n  installed at ${root}`);
  }

  const plan = await planUpdate({ root, tag });

  if (check || dryRun) {
    out(`installed: ${plan.current}`);
    if (!plan.release) {
      out(`latest:    unknown (${plan.reason})`);
      return;
    }
    out(`latest:    ${plan.release.version}  (${plan.release.tag})`);
    out(plan.action === 'none'
      ? `nothing to do: ${plan.reason}`
      : `would ${plan.action === 'pin' ? 'pin to' : 'update to'} ${plan.release.version}`);
    if (blocker) out(`but: ${blocker}`);
    if (plan.release.notesUrl) out(`notes:     ${plan.release.notesUrl}`);
    return;
  }

  if (plan.action === 'none') {
    say(`prmpt: ${plan.reason} (${plan.current})`);
    return;
  }

  const result = await applyUpdate({ root, tag, plan });
  if (!result.updated) {
    say(`prmpt: ${result.reason}`);
    return;
  }
  say(`prmpt: updated ${result.from} -> ${result.to}`);
  if (result.notesUrl) say(`  notes: ${result.notesUrl}`);
  say('  Restart your agent to pick it up.');
}

// --- dispatch ---------------------------------------------------------------

export async function run(argv) {
  const [command = 'help', ...args] = argv;

  switch (command) {
    case 'login':      return cmdLogin(args);
    case 'status':     return cmdStatus();
    case 'logout':     return cmdLogout();
    case 'wallet':     return cmdWallet(args);
    case 'link':       return cmdLink(args);
    case 'update':     return cmdUpdate(args);
    case 'help':
    case '-h':
    case '--help':     out(HELP); return;
    case 'version':
    case '-v':
    case '--version':  out(currentVersion()); return;
    default:
      throw new UserError(`unknown command: ${command}\n  try 'prmpt help'`);
  }
}

// Only run when invoked as a program, so the tests can import `run` directly.
// pathToFileURL, not string concatenation: a home directory with a space in it
// produces a URL that never matches import.meta.url, and the CLI silently does
// nothing at all.
const invokedDirectly = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(process.argv.slice(2)).catch((e) => {
    err(`prmpt: ${e?.message ?? e}`);
    if (!(e instanceof UserError) && e?.stack && process.env.PRMPT_DEBUG === '1') {
      err(e.stack);
    }
    process.exit(1);
  });
}
