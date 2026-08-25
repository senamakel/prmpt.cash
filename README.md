# prmpt.click

**Get paid for using your coding agent.**

When your agent finishes a reply, this hook asks whether any advertiser genuinely
matches what you just did. Almost always the answer is no and nothing prints. On a
match you get one clearly-labelled line. If someone clicks it, **70% of the clearing
price lands in your Solana wallet as USDC**, usually within a second.

It creates the wallet itself, so installing is one command with nothing to sign
up for. Zero runtime dependencies. Plain ESM. Node 18+. Works with Claude Code,
Codex, Gemini CLI and Amp.

---

## Install

**macOS / Linux**

```sh
curl -fsSL https://prmpt.click/install.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://prmpt.click/install.ps1 | iex
```

That downloads the latest **release**, verifies its SHA-256 against the
`SHA256SUMS` published alongside it, detects the agents you have, wires each one
up using *its own* documented hook, **creates a Solana wallet for you**, proves
it to the backend by signature and stores both at mode 0600. Restart your agent
and carry on working. There is no account to make and no code to paste.

Pin a version with `--version v0.2.0`; releases are at
[github.com/senamakel/prmpt.click/releases](https://github.com/senamakel/prmpt.click/releases).

Already have a wallet you would rather be paid into? Import it, then sign in:

```sh
prmpt wallet import <secret-key>   # Phantom / Solflare export, or a solana-keygen id.json
prmpt login
```

And if you would rather the key never touched this machine at all, the dashboard
route still works exactly as before — prove your wallet there with a real wallet
extension and redeem the one-off code it mints:

```sh
curl -fsSL https://prmpt.click/install.sh | sh -s -- --code <install-code>
```

Prefer to read it first? It is one POSIX shell file — [`install.sh`](install.sh).

```sh
git clone https://github.com/senamakel/prmpt.click
./prmpt.click/install.sh
```

<details>
<summary>Options</summary>

```
--code <code>        redeem a dashboard install code instead of creating a
                     wallet here — use it to keep the key off this machine
--no-login           install and wire up the agents, but create no wallet
--version <tag>      install a specific release, e.g. v0.2.0 (default: latest)
--agents <list>      claude,codex,gemini,amp   (default: autodetect)
--endpoint <url>     point at your own deployment
--dir <path>         where to install (default: $XDG_DATA_HOME/prmpt)
--project            configure ./ instead of your home directory
--uninstall          remove the hooks and the installed copy
```
</details>

Re-running is safe — it upgrades in place, and replaces its own hook entry rather
than appending, so you cannot end up with duplicates.

## The wallet

The plugin holds its own Solana keypair and signs in with it. That is what makes
first run self-service: Sign-In With Solana asks the server for a one-time
challenge, signs the exact message it minted, and gets back a publisher JWT.
First sign-in is signup, so nothing has to exist beforehand.

```sh
prmpt login                     # create a wallet if there isn't one, and sign in
prmpt status                    # wallet, token, expiry, endpoint — nothing secret
prmpt wallet                    # print the address
prmpt wallet new [--force]      # generate a fresh key
prmpt wallet import <secret>    # adopt a key you already have (- reads stdin)
prmpt wallet export [--json]    # print the secret key, to back it up
prmpt link <install-code>       # the dashboard route
prmpt logout                    # forget the token; the key is left alone
```

The hook also enrols itself: an install with no token detaches a `prmpt login`
child on the first turn and serves normally from the next one. It is never on
the turn's own clock — two round trips against a cold backend is many times the
1.5s budget. `PRMPT_NO_AUTO_ENROL=1` turns that off.

### Say the quiet part out loud

**A generated wallet is a hot wallet.** The key sits in cleartext at mode 0600:

```
~/.config/prmpt/wallet.json          mode 0600, the only copy
{ "address": …, "secretKey": …, "imported": false, "createdAt": … }
```

Anyone who can read that file can sign as you and move anything the address
holds. It is sized for ad revenue, not savings. Three consequences worth acting
on:

- **Back it up.** `prmpt wallet export` prints a base58 key that Phantom,
  Solflare and Backpack all import; `--json` prints the `solana-keygen` array
  form. Lose the file without a backup and the earnings paid to that address are
  gone with it. Neither `--uninstall` deletes it, on purpose.
- **Or bring your own.** `prmpt wallet import` takes any of those formats, so
  payouts can land in a wallet you already control and already back up.
- **Or keep the key off the box entirely.** `prmpt link <code>` still works. The
  dashboard is the only place a real wallet prompt can open, and an install
  linked that way never has a local key at all.

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

The token is never echoed, never logged, and never appears in hook output — it
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
  genuine — anyone who could publish a release could publish a matching sum.
  That trust is anchored in GitHub and in who holds release permission on the
  repository. Detached signing is what would change that, and is not done yet.
- **Nothing is unpacked before it verifies.** Checksum first, then extract, then
  a check that the archive actually contains a plugin. Any failure leaves the
  install exactly as it was.
- **The swap is a rename, with the old tree kept until the new one lands.** If
  the second rename fails, the old one goes back.
- **Your credentials are never in the blast radius.** The token and wallet key
  live in `~/.config/prmpt`, not in the install directory, so no update — or
  failed update — can touch them. There is a test that asserts exactly this.
- **A git checkout is never touched.** If you are developing the plugin, update
  it with git; the auto-updater refuses outright and does not even check.

## What it looks like

```
Sponsored · Stop re-running flaky tests until green
Quarantine detects flaky tests from your CI history and isolates them
https://prmpt.click/7q
```

The headline is rewritten for *your* turn, not boilerplate. The link is our own
redirect: it records the click, pays you, and 302s to the advertiser.

## It cannot break your session

This is the part worth checking yourself, in [`hooks/turn-end.mjs`](hooks/turn-end.mjs):

- **One request, hard 1.5s budget, fail-open.** On any error, timeout, non-match
  or missing key it prints nothing and exits 0.
- Gemini CLI runs hooks *synchronously inside the agent loop*, so a slow hook
  would stall your turn. That is exactly why the budget exists.
- **Signing in is never on the turn's clock.** Self-enrolment detaches a child
  and returns immediately; the turn that triggers it serves nothing and takes
  about as long as an exit.
- **Neither is updating.** The daily update check costs the turn a `stat()` and
  a `spawn()`. The download happens in a detached child, or not at all.
- Nothing is installed but the plugin itself. No dependencies to audit.

Turn it off without uninstalling:

```sh
export PRMPT_DISABLED=1
```

## What is sent

The agent's **final message for that turn**, plus a session id, an install id
derived from your machine, and the agent name. That is what the match runs
against.

Not sent: your prompts, your code, your file contents, your repo name, your IP
(the server derives a coarse country at request time and discards the address).

See [`.env.example`](.env.example) for every knob.

## Supported agents

| Agent | Event | Config |
|---|---|---|
| Claude Code | `Stop` | `~/.claude/settings.json` — timeout in **seconds** |
| Codex | `Stop` | `~/.codex/hooks.json` — timeout in **seconds** |
| Gemini CLI | `AfterAgent` | `~/.gemini/settings.json` — timeout in **milliseconds** |
| Amp | `agent.end` | a TypeScript plugin, not a hook — see [`amp/`](amp/README.md) |

Those units and event names are not interchangeable; the installer handles each
correctly. Per-host detail lives in [`codex/`](codex/README.md),
[`gemini/`](gemini/README.md) and [`amp/`](amp/README.md).

**Cursor and Windsurf are deliberately absent.** Both can hand a hook the
finished turn, but neither documents a way for that hook to show you anything —
so an ad could be matched and never displayed, and you would earn nothing from
it. We would rather leave them out than take the impression.

**The Windows installer is unverified.** `install.ps1` mirrors `install.sh`
step for step and delegates every JSON edit to the same Node one-liners, so the
merge behaviour is identical by construction rather than reimplemented — but it
has not been run against a real Windows install here. Treat it as unverified
and please report anything that does not match. `install.sh` works under WSL if
you would rather stay on a tested path.

**The Amp integration is unverified.** It is written against Amp's documented
plugin API but has not been run against a live Amp install. The Claude Code,
Codex and Gemini CLI paths were tested end to end.

## Releasing

Releases are cut by tag. `.github/workflows/release.yml` is the only supported
way to publish one — the installer and the updater both look for an asset named
exactly `prmpt-<version>.tar.gz` plus a `SHA256SUMS`, and a hand-rolled release
without them is invisible to both.

```sh
# 1. bump the version in package.json, commit it
# 2. tag it — the tag must match package.json exactly
git tag v0.2.0 && git push origin v0.2.0
```

The workflow refuses a tag that disagrees with `package.json`. That check is
load-bearing: `prmpt update` compares the version baked into `package.json`
against the release tag, so a mismatch leaves every install either re-updating
forever or never updating again.

It then runs the tests, builds the tarball from an explicit file list (no tests,
no workflows, no `.git`), verifies the archive unpacks and runs, publishes it,
and finally installs from the published release for real — which is the only
place the download-and-verify path in `install.sh` is exercised, since CI
otherwise runs the installer from a checkout.

## Development

```sh
node --test test/*.test.mjs      # no network, no dependencies
```

The suite spawns the real hook and the real CLI as subprocesses against stub
servers on ephemeral ports, so it exercises exit codes, streams and the wire
rather than internal functions. The stub verifies SIWS signatures the same way
`backend/internal/auth/siws.go` does — against the exact message it minted — so
a client that rebuilt the message locally fails there rather than in production.

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

Deleting the token stops this install serving. It does not revoke it — nothing
can, and a copy taken beforehand keeps working until it expires.

## License

MIT
