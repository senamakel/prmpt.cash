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
import { spawn } from 'node:child_process';
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
  generateMnemonicWallet,
  walletFromSecret,
  walletFromMnemonic,
} from '../hooks/lib/wallet.mjs';
import { ensureEvmWallet, peekEvmWallet, evmWalletPath } from '../hooks/lib/evm.mjs';
import { loginWithWallet } from '../hooks/lib/login.mjs';
import { currentVersion, pluginRoot } from '../hooks/lib/version.mjs';
import { planUpdate, applyUpdate, updateBlocker } from '../hooks/lib/update.mjs';
import { RELEASE_REPO } from '../hooks/lib/release.mjs';
import { exchangeInstallCode, createWebSession } from '../hooks/lib/api.mjs';
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

  dashboard                  Open the web dashboard signed in as this install.
                             Your keys stay here; the browser gets a two-minute
                             single-use code. Everything configurable -- payout
                             token, earnings, history -- lives there.

  wallet                     Show both addresses (same as 'wallet show').
  wallet new [--force]       Generate a fresh seed phrase and both wallets.
                             Refuses to overwrite one unless --force: there is
                             no undo and the old address keeps any earnings.
  wallet mnemonic            Print the seed phrase. This is the backup.
  wallet import <secret>     Adopt an existing key. Accepts a BIP-39 seed phrase
                             (both chains), or a Solana key as base58 (Phantom
                             and Solflare "export private key") or a
                             solana-keygen JSON array. Pass - to read stdin.
  wallet export [--json]     Print the Solana secret key. Only to back it up --
                             prefer 'wallet mnemonic', which covers both chains.
  wallet path                Where the key files live.

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

One seed phrase holds both chains: a Solana address (SOL, TINY, XAUt0) and a
Base address (USDC, cbBTC, ETH). Which one is paid follows from the token you
choose on the dashboard.

It is a hot wallet: a cleartext key at mode 0600 under your home directory. It
holds ad revenue, not savings. Back up the phrase with 'wallet mnemonic', and
prefer 'wallet import' if you would rather be paid into a wallet you already
have.`;

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
    out(`  Solana  ${result.wallet.address}`);
    out(`  Base    ${result.evm.address}`);
    out('');
    out('  Both come from one seed phrase, stored in cleartext at');
    out(`  ${walletPath()} (mode 0600). It is the only copy.`);
    out("  Write it down now:  prmpt wallet mnemonic");
    out('  If you lose it, the earnings paid to those addresses are gone with it.');
    out('');
  } else if (before) {
    out(`prmpt: signed in as ${result.wallet.address}`);
  }

  out('prmpt: linked.');
  out(`  solana:     ${result.wallet.address}`);
  out(`  base:       ${result.evm.address}${result.evmLinked ? '' : '  (NOT LINKED)'}`);
  out(`  install id: ${result.installId}`);
  out(`  token:      ${mask(result.token)}  (stored, not shown)`);
  if (result.expiresAt) out(`  expires:    ${result.expiresAt}`);
  out(`  endpoint:   ${result.endpoint}`);
  out(`  config:     ${result.configFile} (0600)`);
  if (result.payoutToken) {
    out(`  paid in:    ${result.payoutToken}${result.payoutChain ? ` on ${result.payoutChain}` : ''}`);
  }
  out('');

  // A failed Base link is reported rather than swallowed: the install still
  // works and still earns, but only in the Solana-settled currencies, and the
  // default token is not one of them.
  if (!result.evmLinked) {
    err(`prmpt: warning -- could not link the Base address: ${result.evmError}`);
    err('  Solana payouts (SOL, TINY, XAUt0) still work. ERC-20 earnings will');
    err("  accrue but cannot be sent until this succeeds. Re-run 'prmpt login'.");
    err('');
  }

  out('Clicks on ads served from this install now pay 70% of the clearing price');
  out('to your wallet, in whichever token you choose. Change it, and see what you');
  out("have earned, with 'prmpt dashboard'. Set PRMPT_DISABLED=1 to stop serving.");
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
      // peek, not ensure: printing an address must not create one.
      const found = peekEvmWallet(wallet);
      out(`solana  ${wallet.address}`);
      out(`base    ${found ? found.wallet.address : "not created yet -- run 'prmpt login'"}`);
      const stored = found?.stored ?? false;
      if (!wallet.mnemonic) {
        // A raw-key install has two unrelated secrets, and the Base one was
        // generated here rather than derived. Saying so is the difference
        // between backing up one file and losing the other.
        err('');
        err('prmpt: this install has no seed phrase -- its two keys are unrelated.');
        err(`  Solana key: ${walletPath()}`);
        if (stored) err(`  Base key:   ${evmWalletPath()}  (generated, back it up separately)`);
      }
      return;
    }

    case 'mnemonic':
    case 'phrase': {
      const wallet = loadWallet();
      if (!wallet) throw new UserError("no wallet yet -- run 'prmpt login' or 'prmpt wallet new'");
      if (!wallet.mnemonic) {
        throw new UserError(
          'this wallet has no seed phrase behind it -- it was imported as a raw key, or\n' +
          '  created before phrases existed. There is no phrase that derives it, so back\n' +
          `  up ${walletPath()} and ${evmWalletPath()} instead.`,
        );
      }
      out(wallet.mnemonic);
      err('');
      err('prmpt: those twelve words ARE your wallet, on both chains.');
      err('Anyone who reads them can take everything the addresses hold. Write them');
      err('on paper; do not put them in a password manager you also lose access to.');
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
      const wallet = generateMnemonicWallet();
      const file = saveWallet(wallet);
      const { wallet: evm } = ensureEvmWallet(wallet);
      out(`prmpt: new wallet`);
      out(`  solana:   ${wallet.address}`);
      out(`  base:     ${evm.address}`);
      out(`  key file: ${file} (0600)`);
      if (existing) out(`  replaced: ${existing.address}`);
      out('');
      out("Write the phrase down now:  prmpt wallet mnemonic");
      out("Then run 'prmpt login' to prove it to the backend and start earning.");
      return;
    }

    case 'import': {
      const source = rest.length > 0 ? rest.join(' ') : '';
      if (!source) throw new UserError("usage: prmpt wallet import <secret-key|seed phrase>  (or - for stdin)");
      const secret = source === '-' ? fs.readFileSync(0, 'utf8') : source;

      // A multi-word input is a seed phrase, which imports BOTH chains; a
      // single token is a bare Solana key, which can only ever be the one.
      // Deciding by shape rather than by a flag means the user pastes what they
      // have and it works.
      const looksLikeMnemonic = secret.trim().split(/\s+/u).length > 1;
      const wallet = looksLikeMnemonic ? walletFromMnemonic(secret) : walletFromSecret(secret);
      const existing = safeLoadWallet();
      if (existing && existing.address === wallet.address) {
        out(`prmpt: ${wallet.address} is already the wallet here; nothing changed.`);
        return;
      }
      const file = saveWallet(wallet, { imported: true });
      const { wallet: evm } = ensureEvmWallet(wallet);
      out(`prmpt: imported ${wallet.address}`);
      out(`  solana:   ${wallet.address}`);
      out(`  base:     ${evm.address}${wallet.mnemonic ? '' : '  (generated -- a raw key derives no Base address)'}`);
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
      throw new UserError(`unknown wallet command: ${sub}\n  try: show | new | mnemonic | import | export | path`);
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

/**
 * Open the dashboard signed in as this install.
 *
 * The whole point of the split: the plugin holds keys, and everything a person
 * might want to CHANGE -- which token they are paid in, what they have earned,
 * which ads they were shown -- lives on the web where it can have a real
 * interface. A terminal is a bad place to render an earnings history and a
 * worse place to pick from a list of six currencies.
 *
 * A plugin-generated key has no wallet extension anywhere, so the dashboard's
 * connect button cannot sign it in. This mints a single-use two-minute code
 * from the token already on disk and opens the browser at it. The key does not
 * move and is not exposed to the page.
 */
async function cmdDashboard(args) {
  const stored = readStoredConfig();
  const envToken = (process.env.PRMPT_TOKEN || process.env.PRMPT_API_KEY || '').trim();
  const token = envToken || (typeof stored.token === 'string' ? stored.token.trim() : '');
  if (!token) {
    throw new UserError("this install has no token yet -- run 'prmpt login' first");
  }

  const endpoint = resolveEndpoint();
  const session = await createWebSession({ endpoint, token });

  out('prmpt: opening the dashboard.');
  out('');
  out(`  ${session.url}`);
  out('');
  out('That link signs in as this install. It is single use and expires in two');
  out('minutes -- treat it like a password until you have opened it.');

  if (args.includes('--no-open')) return;
  if (!openInBrowser(session.url)) {
    out('');
    out('Could not open a browser here. Paste the link above into one.');
  }
}

/**
 * Best-effort browser launch.
 *
 * Detached and fully ignored, so the CLI exits immediately rather than blocking
 * on a browser that may run in the foreground, and so a browser that writes to
 * stderr does not scribble over our output. Returns whether the spawn itself
 * worked -- not whether a page actually opened, which is unknowable from here.
 */
function openInBrowser(url) {
  const [command, ...args] =
    process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
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
    case 'dashboard':
    case 'web':        return cmdDashboard(args);
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
