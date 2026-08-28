# prmpt.cash

**Earn free crypto for the replies your coding agent already writes.**

When your agent finishes a reply, this hook asks whether any advertiser actually
matches what you just did. Almost always the answer is no and nothing prints. Once
in a while it is yes, and you get one clearly-labelled line. **Click it and you get
paid**, straight to your wallet, usually within a second, in whichever token you
picked.

In Claude Code there is a second place it can appear: a short segment appended to
your **status line**, the footer that renders while the model is working. It is
appended to the status line you already have, never in place of it, and it is
capped at 60 characters. See [Two places an ad can appear](#two-places-an-ad-can-appear).

You never had to sell anything, watch anything or click anything. Advertisers are
paying for the moment a real problem is on your screen, and this is your share of it.

| Token   | Chain  | What it is                                                  |
| ------- | ------ | ----------------------------------------------------------- |
| `TINY`  | Solana | Tiny Humans. The most memeable mascot on the list, with an active community behind it |
| `BTC`   | Base   | Bitcoin, one to one. Coinbase Wrapped BTC (`cbBTC`) on chain |
| `ETH`   | Base   | Native ether                                                |
| `SOL`   | Solana | Native lamports, no token account in the way                |
| `USDC`  | Base   | A dollar that stays a dollar. The default, and the stable answer |
| `XAUT`  | Solana | Tether Gold, if you would rather your terminal habit bought bullion. `XAUt0` on chain |

Pick one at <https://prmpt.cash/earnings>. The balance is kept in dollars and
converted only when a payout settles, at the price right then, so switching changes
what the next payout arrives as and nothing that has already been paid.

It creates the wallet itself, so installing is one command with nothing to sign
up for. Zero runtime dependencies. Plain ESM. Node 18+. Works with Claude Code,
Codex, Gemini CLI and Amp.

---

## Install

**macOS / Linux**

```sh
curl -fsSL https://prmpt.cash/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://prmpt.cash/install.ps1 | iex
```

That downloads the latest **release**, verifies its SHA-256 against the
`SHA256SUMS` published alongside it, detects the agents you have, wires each one
up using *its own* documented hook, **creates a Solana wallet for you**, proves
it to the backend by signature and stores both at mode 0600. Restart your agent
and carry on working. There is no account to make and no code to paste.

Pin a version with `--version v0.2.0`; releases are at
[github.com/senamakel/prmpt.cash/releases](https://github.com/senamakel/prmpt.cash/releases).

Already have a wallet you would rather be paid into? Import its seed phrase or
private key locally, then sign in:

```sh
prmpt wallet import -              # reads the phrase or private key from stdin
prmpt login
```

**In Claude Code** you can install it as a plugin instead:

```
/plugin marketplace add senamakel/prmpt.cash
/plugin install prmpt@prmpt
```

Prefer to read it first? It is one POSIX shell file, [`install.sh`](install.sh).

```sh
git clone https://github.com/senamakel/prmpt.cash
./prmpt.cash/install.sh
```

<details>
<summary>Options</summary>

```
--no-login           install and wire up the agents, but create no wallet
--version <tag>      install a specific release, e.g. v0.2.0 (default: latest)
--agents <list>      claude,codex,gemini,amp   (default: autodetect)
--endpoint <url>     point at your own deployment
--dir <path>         where to install (default: $XDG_DATA_HOME/prmpt)
--project            configure ./ instead of your home directory
--uninstall          remove the hooks and the installed copy
```
</details>

Re-running is safe. It upgrades in place, and replaces its own hook entry rather
than appending, so you cannot end up with duplicates.

## The wallet

**One seed phrase, two chains.** The plugin generates a BIP-39 mnemonic and
derives both addresses from it: Solana at `m/44'/501'/0'/0'` and Base at
`m/44'/60'/0'/0/0`, the same paths Phantom and MetaMask use. Twelve words are
one thing to write down, and they import into either wallet unchanged.

It signs in with those keys itself, which is what makes first run self-service:
Sign-In With Solana asks the server for a one-time challenge, signs the exact
message it minted, and gets back a publisher JWT. The Base address is then
proven the same way with Sign-In With Ethereum and linked to the same account.
First sign-in is signup, so nothing has to exist beforehand.

Which address gets paid follows from the token you choose: ERC-20s settle on
Base, and SOL, TINY and XAUT on Solana. You choose on the dashboard.

```sh
prmpt login                     # create a wallet if there isn't one, and sign in
prmpt dashboard                 # open the web dashboard, signed in as this install
prmpt status                    # wallet, token, expiry, endpoint; nothing secret
prmpt wallet                    # print both addresses
prmpt wallet mnemonic           # print the seed phrase; this is the backup
prmpt wallet new [--force]      # generate a fresh phrase and both keys
prmpt wallet import <secret>    # adopt a phrase, or a Solana key (- reads stdin)
prmpt wallet export [--json]    # print the Solana secret key
prmpt logout                    # forget the token; the keys are left alone
```

**The plugin holds keys; the web holds settings.** `prmpt dashboard` mints a
single-use two-minute code from the token already on disk and opens it in your
browser, with no wallet extension needed and the key never leaving the machine.
Everything worth configuring, and every number worth reading, lives there.

The hook also enrols itself: an install with no token detaches a `prmpt login`
child on the first turn and serves normally from the next one. It is never on
the turn's own clock, because two round trips against a cold backend is many times the
1.5s budget. `PRMPT_NO_AUTO_ENROL=1` turns that off.

### Say the quiet part out loud

**A generated wallet is a hot wallet.** The key sits in cleartext at mode 0600:

```
~/.config/prmpt/wallet.json          mode 0600, the only copy
{ "address": …, "mnemonic": …, "secretKey": …, "imported": false, "createdAt": … }
```

Anyone who can read that file can sign as you and move anything the address
holds. It is sized for ad revenue, not savings. Three consequences worth acting
on:

- **Back it up.** `prmpt wallet mnemonic` prints the twelve words, which restore
  both chains in Phantom, Solflare, Backpack or MetaMask. (`prmpt wallet export`
  still prints the Solana key alone, in base58 or `solana-keygen` array form.)
  Lose the file without a backup and the earnings paid to those addresses are
  gone with it. No `--uninstall` deletes it, on purpose.
- **Or bring your own.** `prmpt wallet import` takes either a seed phrase,
  which brings both chains, or a bare Solana key, so payouts can land in a
  wallet you already control and already back up. An imported raw key has no phrase behind
  it, so a separate Base key is generated and stored in `evm.json`; back that up
  too, or import a phrase instead and avoid the second file entirely.
`prmpt wallet export` writes the key to stdout and its warning to stderr, so
`prmpt wallet export > key.txt` captures exactly the key.

### The token

```
~/.config/prmpt/config.json          mode 0600
{ "installId": …, "token": …, "endpoint": …, "solanaWallet": … }
```

Deliberately a different file from the key: config.json is rewritten by every
code path that touches settings, and it is the file people paste into bug
reports. The key stays out of both blast radii.

The status-line surface keeps two more files there, neither of them secret:
`statusline.json`, holding the status-line command the installer displaced so it
can be run and later handed back, and `slot-<session>.json` plus `pending.jsonl`,
which are one pending decision and the list of ads that have actually been drawn
and not yet reported. All 0600.

The token is never echoed, never logged, and never appears in hook output. It
travels only in the `Authorization: Bearer` header of the serve request.

It is also long-lived and **cannot be revoked**: it stays valid until it
expires, so treat that config file as the credential it is. `prmpt logout`
forgets it locally; it does not invalidate a copy taken beforehand.

## It keeps itself up to date

Once a day the hook detaches a child that asks GitHub for the latest release.
If there is a newer one it downloads it, checks the SHA-256 against the release's
`SHA256SUMS`, unpacks it beside the install and swaps the two by rename. Your
agent picks it up on its next restart.

```sh
prmpt update --check              # what would happen, changing nothing
prmpt update                      # do it now
prmpt update --version v0.2.0     # pin a release (may be a downgrade)
export PRMPT_NO_AUTO_UPDATE=1     # never update on its own
```

Being honest about what that does and does not guarantee:

- **The checksum proves integrity, not authenticity.** `SHA256SUMS` ships as an
  asset of the same release as the tarball, so verifying it catches a truncated
  download or a proxy serving the wrong bytes. It does not prove the release is
  genuine, because anyone who could publish a release could publish a matching sum.
  That trust is anchored in GitHub and in who holds release permission on the
  repository. Detached signing is what would change that, and is not done yet.
- **Nothing is unpacked before it verifies.** Checksum first, then extract, then
  a check that the archive actually contains a plugin. Any failure leaves the
  install exactly as it was.
- **The swap is a rename, with the old tree kept until the new one lands.** If
  the second rename fails, the old one goes back.
- **Your credentials are never in the blast radius.** The token and wallet key
  live in `~/.config/prmpt`, not in the install directory, so neither an update
  nor a failed update can touch them. There is a test that asserts exactly this.
- **A git checkout is never touched.** If you are developing the plugin, update
  it with git; the auto-updater refuses outright and does not even check.

## Two places an ad can appear

| Surface | When | Where | Hosts |
|---|---|---|---|
| End of turn | once, when the reply finishes | its own labelled block | Claude Code, Codex, Gemini CLI, Amp |
| Status line | while the model is working | one dim row above your prompt | **Claude Code only** |

**The status line is Claude Code only, on purpose.** Codex and Gemini CLI have no
equivalent footer, and inventing config for them would wire up something that
could never display anything. Cursor and Windsurf are absent for the same
reason they always were. (Codex's `[tui] status_line` accepts identifiers from a
fixed list of built-in items and cannot run a command — see
[openai/codex#17827](https://github.com/openai/codex/issues/17827). Codex is
otherwise unaffected: its `Stop` hook still matches your turns, still prints the
end-of-turn line, and still parks a slot the editor extension can render.)

### The status line has two fillers

They write the same file, `~/.config/prmpt/slot.json`, and whichever wrote last
is what you see. They are not the same thing, and the difference is what you are
charged in privacy for:

- **The parked ad.** When a turn ends and matches, that decision is *already*
  served and already paid for. It is parked, and the status line keeps showing
  it while you read the answer and type the next prompt, until it ages out after
  30 minutes. **This sends nothing new** — the request already happened — and it
  earns you nothing new either: it is the same impression, still on screen.
- **The prompt-fetched ad.** When you press enter, a detached child asks for a
  decision matched to *this* prompt and parks that instead. It is fresher, it is
  its own impression on its own surface, and it is billed once — the first time
  it is actually drawn. This is the path that sends keywords derived from your
  prompt; see [What is sent](#what-is-sent), which does not soften it.

A fetch that misses, or does not come back in time, writes nothing at all, so
the parked ad is still there and the row does not go blank.

**It wraps the status line you already have.** If `statusLine` in
`~/.claude/settings.json` already points at a command, the installer records it
and ours runs it, keeps its output above ours, and puts our row closest to the
prompt. Your command is handed the same JSON on stdin that Claude Code would
have given it. On a host that renders only one row, yours wins and nothing of
ours is drawn. `--uninstall`, and `prmpt statusline uninstall`, give your
original command back exactly as it was.

Three more things worth knowing:

- The renderer **makes no network call, ever.** Claude Code re-runs a status-line
  command continuously and watches it for slowness. Both fillers write a small
  file from somewhere else; the renderer reads that file and prints one row.
- **Claude Code hides most of its footer key hints while a custom status line is
  set** — including `esc to interrupt`. That is Claude Code's behaviour, not
  ours. Removing the status line brings them back.
- The `/plugin install` route wires the hooks but **not** the status line.
  `statusLine` is a settings key rather than a hook, and a Claude Code plugin can
  only declare hooks, so the footer needs `install.sh`, `install.ps1`, or:

```sh
$ prmpt statusline install     # also: status, preview, uninstall
```

## What it looks like

```
Sponsored · Stop re-running flaky tests until green
Quarantine detects flaky tests from your CI history and isolates them
https://prmpt.cash/7q
```

and, in the status line, one dim row directly above your prompt, beneath
whatever status line you already had:

```
my-repo (main) Opus | 41% left
Sponsored · Quarantine flaky tests — detects flakes from CI history ↗
```

The click URL is attached as a terminal hyperlink rather than printed, so the
row stays short; it is clickable in iTerm2, Kitty and WezTerm and is plain text
everywhere else.

The headline is rewritten for *your* turn, not boilerplate. The link is our own
redirect: it records the click, pays you in your chosen token, and 302s to the
advertiser. Every payout is a real on-chain transaction, listed with its
signature at <https://prmpt.cash/earnings> and counted on the public
[analytics page](https://prmpt.cash/analytics).

## It cannot break your session

This is the part worth checking yourself, in [`hooks/turn-end.mjs`](hooks/turn-end.mjs):

- **One request, hard 1.5s budget, fail-open.** On any error, timeout, non-match
  or missing key it prints nothing and exits 0.
- Gemini CLI runs hooks *synchronously inside the agent loop*, so a slow hook
  would stall your agent. That is exactly why the budget exists.
- **Signing in is never on the turn's clock.** Self-enrolment detaches a child
  and returns immediately; the turn that triggers it serves nothing and takes
  about as long as an exit.
- **Neither is updating.** The daily update check costs the turn a `stat()` and
  a `spawn()`. The download happens in a detached child, or not at all.
- **`UserPromptSubmit` blocks you**, so it does no network work at all: it
  derives keywords, hands them to a detached child and exits. Measured at well
  under a tenth of a second.
- **The status-line command never touches the network.** It reads one small file
  and prints one line. If your own status-line command is slow, it is given a
  two-second budget and then whatever it produced is used.
- Nothing is installed but the plugin itself. No dependencies to audit.

Turn it off without uninstalling:

```sh
export PRMPT_DISABLED=1
```

## What is sent

**At the end of a turn:** the agent's **final message for that turn**, plus a
session id, an install id derived from your machine, and the agent name. That is
what the match runs against.

**For the parked ad on the status line: nothing at all.** It is the decision the
end-of-turn request already returned, re-displayed from a local file. No second
request is made and no new data leaves the machine.

**For the prompt-fetched ad on the status line:** there is no reply yet — the ad
renders while the model is still working — so the match runs against a handful of
keywords derived from your prompt **on your machine**, by
[`hooks/lib/tokens.mjs`](hooks/lib/tokens.mjs). What is transmitted is that list
and nothing else.

Read that file if this matters to you; it is forty lines. Before anything is
split into words it removes, whole: fenced code blocks, inline code spans, URLs,
filesystem paths (POSIX and Windows) and email addresses. What is left is
lowercased, stripped of stopwords, de-duplicated, filtered of anything that
looks like a hash or a credential, capped at 32 words — and **sorted
alphabetically**, so word order, the last thing that makes a set of words into
prose, is gone before the request is built. `fix the nightingale acquisition
timeout` leaves as `["acquisition", "fix", "nightingale", "timeout"]`.

**Not sent: your prompts**, your code, your file contents, your repo name, your
IP (the server derives a coarse country at request time and discards the
address). The status-line surface sends derived keywords; it does not send the
text you typed, and there is a test that asserts a phrase from the prompt is
nowhere in the request body.

That is a real reduction, not anonymity: individual words you typed do leave the
machine. If that is not a trade you want, `PRMPT_DISABLED=1` turns everything
off, and removing the `UserPromptSubmit` entry from `~/.claude/settings.json`
turns off only the prompt-fetched path, leaving the end-of-turn line — and the
parked ad on the status line, which sends nothing — working.

See [`.env.example`](.env.example) for every knob.

## Supported agents

| Agent | Event | Config |
|---|---|---|
| Claude Code | `Stop` | `~/.claude/settings.json`, timeout in **seconds** |
| Claude Code | `UserPromptSubmit` | same file — fetches the status-line slot |
| Claude Code | `statusLine` | same file — renders it. Wraps an existing command |
| Codex | `Stop` | `~/.codex/hooks.json`, timeout in **seconds** |
| Gemini CLI | `AfterAgent` | `~/.gemini/settings.json`, timeout in **milliseconds** |
| Amp | `agent.end` | a TypeScript plugin, not a hook. See [`amp/`](amp/README.md) |
| Cursor | `afterAgentResponse` | plus the editor extension for display. See [`vscode/`](vscode/README.md) |

Those units and event names are not interchangeable; the installer handles each
correctly. Per-host detail lives in [`codex/`](codex/README.md),
[`gemini/`](gemini/README.md) and [`amp/`](amp/README.md).

**Windsurf is deliberately absent.** It can hand a hook the finished turn, but
documents no way for that hook to show you anything. An ad could be matched and
never displayed, and you would earn nothing from it. We would rather leave it
out than take the impression.

**Cursor needs the editor extension.** Same problem — the hook sees the turn and
has nowhere to put the result — solved by giving it somewhere: see
[`vscode/`](vscode/README.md).

**The Windows installer is tested, not battle-tested.** `install.ps1` mirrors
`install.sh` step for step and delegates every JSON edit to the same Node
one-liners, so the merge behaviour is identical by construction rather than
reimplemented. CI runs both of them on a Windows runner, covering install,
re-install, uninstall and executing the recorded command through `cmd.exe`, and
checks the two installers write the same entry. What is still unverified is a hook
firing inside a real Windows agent session, which needs credentials CI does not
have. `install.sh` works under WSL if you would rather stay on the path with the
most mileage.

**The Amp integration is unverified.** It is written against Amp's documented
plugin API but has not been run against a live Amp install. The Claude Code,
Codex and Gemini CLI paths were tested end to end.

## Releasing

Releases are cut by tag. `.github/workflows/release.yml` is the only supported
way to publish one, because the installer and the updater both look for an asset named
exactly `prmpt-<version>.tar.gz` plus a `SHA256SUMS`, and a hand-rolled release
without them is invisible to both.

```sh
# 1. bump the version in package.json, commit it
# 2. tag it. The tag must match package.json exactly
git tag v0.2.0 && git push origin v0.2.0
```

The workflow refuses a tag that disagrees with `package.json`. That check is
load-bearing: `prmpt update` compares the version baked into `package.json`
against the release tag, so a mismatch leaves every install either re-updating
forever or never updating again.

It then runs the tests, builds the tarball from an explicit file list (no tests,
no workflows, no `.git`), verifies the archive unpacks and runs, publishes it,
and finally installs from the published release for real. That is the only
place the download-and-verify path in `install.sh` is exercised, since CI
otherwise runs the installer from a checkout.

## Development

```sh
npm test           # the hook's own behaviour: fast, no network, no dependencies
npm run test:smoke # installation: the installer against real agents, on this OS
npm run test:all   # both
```

`npm test` spawns the real hook and the real CLI as subprocesses against stub
servers on ephemeral ports, so it exercises exit codes, streams and the wire
rather than internal functions. The stub verifies SIWS signatures the same way
`backend/internal/auth/siws.go` does, against the exact message it minted, so
a client that rebuilt the message locally fails there rather than in production.

`npm run test:smoke` covers the step before that one, which is easy to get wrong
and impossible to notice: running the installer for real, then executing the
exact command string it wrote into each agent's config, on the platform that
would have to execute it. Everything it has found so far installed cleanly,
reported success, and never ran:

- an unquoted hook path, so any install directory containing a space broke it
  (`Application Support`, or a Windows user named `Jane Smith`);
- a Git Bash install recording an MSYS path (`/c/Users/...`) that no native
  Windows agent can resolve;
- `install.ps1` failing its own Node version check on every version of Node,
  because PowerShell does not escape quotes inside an argument to a native
  command, so it had never worked;
- `Set-Content -Encoding utf8` writing a BOM, after which the merge step refused
  to touch its own freshly created file and wired up nothing;
- PowerShell dropping an empty-string argument, which shifted every later value
  along by one and lost the hook path entirely.

CI runs it on Linux, macOS and Windows, and a second job installs Claude Code,
Codex and Gemini CLI from npm and runs the installer next to them. All three
install unauthenticated, so everything short of a live turn is testable:
autodetection, `claude plugin validate --strict`, and the hook serving a real
sponsored block through each host's documented payload. What CI cannot do is
watch a hook fire inside a real session; that needs credentials, and the suite
says so rather than implying otherwise.

The smoke suite skips any agent that is not installed, so it is useful locally
with only the agents you happen to have. In CI a skip is a failure.

Point at a local backend:

```sh
export PRMPT_ENDPOINT=http://localhost:8080/graphql
```

## Uninstall

```sh
~/.local/share/prmpt/install.sh --uninstall
```

Your hook entries are removed and each touched config is backed up next to
itself as `.bak`.

**Neither your token nor your wallet key is deleted**, on purpose:
`~/.config/prmpt/wallet.json` is the only copy of a key that may hold money, and
removing an ad plugin is not a reason to destroy it. Export it first if you want
it, then delete the directory yourself.

Deleting the token stops this install serving. It does not revoke it. Nothing
can, and a copy taken beforehand keeps working until it expires.

## License

MIT
