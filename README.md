# prmpt.click

**Get paid for using your coding agent.**

When your agent finishes a reply, this hook asks whether any advertiser genuinely
matches what you just did. Almost always the answer is no and nothing prints. On a
match you get one clearly-labelled line. If someone clicks it, **70% of the clearing
price lands in your Solana wallet as USDC**, usually within a second.

Zero runtime dependencies. Plain ESM. Node 18+. Works with Claude Code, Codex,
Gemini CLI and Amp.

---

## Install

**macOS / Linux**

```sh
curl -fsSL https://prmpt.click/install.sh | sh -s -- --code <install-code>
```

**Windows (PowerShell)**

```powershell
$env:PRMPT_CODE = "<install-code>"; irm https://prmpt.click/install.ps1 | iex
```

A piped script cannot take parameters, hence the environment variable. To pass
them properly, run it as a scriptblock instead:

```powershell
& ([scriptblock]::Create((irm https://prmpt.click/install.ps1))) -Code <install-code>
```

That detects the agents you have, wires each one up using *its own* documented
hook, redeems your install code, and stores the resulting token at mode 0600.
Restart your agent and carry on working.

Get the code from the dashboard: sign in with your wallet, then choose "Link a
plugin install". It works once and expires in ten minutes.

Prefer to read it first? It is one POSIX shell file — [`install.sh`](install.sh).

```sh
git clone https://github.com/senamakel/prmpt.click
./prmpt.click/install.sh --code <install-code>
```

<details>
<summary>Options</summary>

```
--code <code>        one-off install code from the dashboard
--agents <list>      claude,codex,gemini,amp   (default: autodetect)
--endpoint <url>     point at your own deployment
--dir <path>         where to install (default: $XDG_DATA_HOME/prmpt)
--project            configure ./ instead of your home directory
--uninstall          remove the hooks and the installed copy
```
</details>

Re-running is safe — it upgrades in place, and replaces its own hook entry rather
than appending, so you cannot end up with duplicates.

## Getting paid

Any wallet that can hold an SPL token works: Phantom, Solflare, Backpack.

Your wallet **signs** a one-line message in the dashboard to prove it is yours.
It authorises no transaction and moves no funds. That signature is what binds
the address to your account — before it existed, an address was merely typed in,
so anyone could have claimed yours and been paid into it.

A terminal cannot open a wallet prompt, which is why the browser hands you a
one-off code instead and the plugin redeems that:

```sh
node ~/.local/share/prmpt/hooks/link.mjs <install-code>
```

The code works once and expires in ten minutes. On success:

```
~/.config/prmpt/config.json          mode 0600
{ "installId": …, "token": …, "endpoint": …, "solanaWallet": … }
```

The token is never echoed, never logged, and never appears in hook output — it
travels only in the `Authorization: Bearer` header of the serve request.

It is also long-lived and **cannot be revoked**: it stays valid until it
expires, so treat that config file as the credential it is. Deleting it stops
this install serving; it does not invalidate a copy taken beforehand.

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

## Development

```sh
node --test test/*.test.mjs      # 77 tests, no network, no dependencies
```

Point at a local backend:

```sh
export PRMPT_ENDPOINT=http://localhost:8080/graphql
```

## Uninstall

```sh
~/.local/share/prmpt/install.sh --uninstall
```

Your hook entries are removed and each touched config is backed up next to
itself as `.bak`. The token at `~/.config/prmpt/config.json` is left alone —
delete it too to stop this install serving. Note that deleting it does not
revoke the token: nothing can, and a copy taken beforehand keeps working until
it expires.

## License

MIT
