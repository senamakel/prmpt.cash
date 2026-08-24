# adengine

An end-of-turn sponsored slot for coding agents. When your agent finishes a reply, the plugin asks
the ad engine whether any campaign genuinely matches what you just did. Almost always the answer is
no and nothing is printed. On a match it prints three subdued lines. If someone clicks the link,
70% of the clearing price lands in your Solana wallet as USDC, usually within a second.

Zero runtime dependencies, plain ESM, Node 18+. Nothing to install beyond the plugin itself.

## Install

### Claude Code

```
/plugin marketplace add adengine/adengine
/plugin install adengine
```

That registers a `Stop` hook — the event Claude Code fires when it finishes responding.

To run it from a checkout instead, point your settings at the hook directly:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/plugin/hooks/turn-end.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

### Codex

See [`codex/README.md`](codex/README.md).

## Wallet setup

You get paid to a Solana wallet address. Any wallet that can hold an SPL token works — Phantom,
Solflare, Backpack, a CLI keypair. Copy the public address (base58, 32–44 characters) and register:

```
node hooks/register.mjs 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
```

The address is validated locally first (length and base58 alphabet) so a typo fails before it can be
bound to an API key. On success the command writes:

```
~/.config/adengine/config.json     mode 0600
{ "installId": …, "apiKey": …, "endpoint": …, "solanaWallet": … }
```

and prints a masked confirmation. The full key is never echoed, never logged, and never appears in
hook output — it travels only in the `Authorization: Bearer` header of the serve request.

Point at a non-default backend with `ADENGINE_ENDPOINT` (default `http://localhost:8080/graphql`).
See [`.env.example`](.env.example) for every knob.

## What it looks like

At most three lines, clearly labelled, dimmed when the terminal supports it:

```
Sponsored · Flaky CI? Buildkite test-splitting cuts your pipeline to 4 minutes
Auto-detects race-prone suites and isolates them. Free for open source.
http://localhost:8080/c/req_7f3c9a1e
```

The link is the engine's own redirect. It records the click, pays you, and 302s to the advertiser.
The block is never dressed up as something the agent said.

## What leaves your machine

On a turn that clears the length gate, exactly one POST containing:

| Field | What it is |
|---|---|
| `installId` | An opaque hash identifying this install. Not your name, email, or wallet. |
| `sessionId` | Your agent's session id, used only for frequency capping. |
| `turnText` | The agent's own final reply, last ~4000 characters. |
| `repoLanguage` | One word, e.g. `go`, inferred from a marker file in the working directory. |
| `fileTypes` | A few extensions, e.g. `[".go"]`, inferred the same way. |
| `harness` | Which coding agent is running, as one of `claude-code`, `codex`, `cursor`, `unknown`. |
| `harnessVersion` | That agent's version string, e.g. `2.1.241`, when it exposes one. |
| `model` | The model name the agent reported for the turn, when it exposes one. |

**Your IP address.** Not sent by the plugin, but like any HTTP request it is visible to the server,
which resolves it to an approximate location. **The IP itself is never stored** — only the country,
region and city derived from it, and only in aggregate. See the privacy note on the public
transparency dashboard.

**What is published.** Harness and location feed the public dashboard at `/transparency`, but only
as aggregates: any bucket with fewer than a handful of impressions is suppressed, so no row can be
traced back to one user. Nothing identifying you — install id, session id, wallet, turn text —
is ever public.

**What never leaves:** the contents of any file, file paths, your prompts, the agent's reasoning or
thinking blocks, tool calls and their output, environment variables, git remotes, or your API key.
Language detection is a single non-recursive directory listing for marker files like `go.mod` and
`Cargo.toml` — it reads their names, never their contents.

Turns shorter than 80 characters are dropped locally without a request.

## How earning works

- **Revenue share: 70/30.** You keep 70% of the clearing price of each valid click; the platform
  keeps 30%. Impressions alone pay nothing — only clicks do.
- Pricing is a second-price auction, so the clearing price is the runner-up's bid, not the winner's.
- On a click the engine records the event idempotently, computes your 70%, and queues a payout.
- **Settlement: USDC on Solana devnet.** A worker resolves or creates your associated token account,
  signs an SPL transfer from the treasury, and confirms it — typically about a second after the
  click. Each payout is keyed to its click event, so a replayed or refreshed click can never pay
  twice.
- Obvious bot traffic (`HEAD` requests, known bot user agents) is logged as synthetic and pays
  nothing.
- Track your balance and per-transaction explorer links on the `/earnings` page of the dashboard.

Devnet USDC has no monetary value. It exercises the full settlement path ahead of mainnet.

## Turning it off

```
export ADENGINE_DISABLED=1
```

The hook exits immediately: no network call, no output. Unsetting it re-enables serving. Removing
`ADENGINE_API_KEY` from the environment and deleting `~/.config/adengine/config.json` has the same
effect, since the hook does nothing without a key.

## Uninstall

```
# 1. remove the plugin
/plugin uninstall adengine

# 2. remove the stored key and wallet binding
rm -rf ~/.config/adengine

# 3. if you wired the hook by hand, delete the Stop entry from ~/.claude/settings.json
#    (Codex: delete the `notify` line from ~/.codex/config.toml)

# 4. drop any exported vars
unset ADENGINE_API_KEY ADENGINE_ENDPOINT ADENGINE_DISABLED
```

Earnings already settled on chain are yours and are unaffected. To also retire the publisher record
server-side, contact the engine operator — the plugin has no mutation for it.

## Design notes

The hook is **fail-open and silent**, without exception. No API key, opt-out set, a short turn, a
refused connection, an HTTP error, a GraphQL error, malformed JSON, a null decision, or the 1500ms
deadline expiring all produce the same result: exit code 0 and not one byte on stdout or stderr.
An ad engine that interrupts, slows, or breaks a coding session is worth less than no ad engine.

Output routing depends on the host. Under Claude Code stdout is a pipe, and a `Stop` hook's plain
stdout is not the channel the user sees — the documented one is a `systemMessage` field in a JSON
object on stdout, which is what the hook emits there. Attached to a terminal it writes the styled
text directly. `ADENGINE_OUTPUT=text|json` forces either.

## Files

```
.claude-plugin/plugin.json   manifest; points at hooks/hooks.json
hooks/hooks.json             registers turn-end.mjs on the Stop event
hooks/turn-end.mjs           the end-of-turn hook
hooks/register.mjs           CLI: register a wallet, persist the API key
hooks/lib/config.mjs         config, install id, session id, repo fingerprint
hooks/lib/api.mjs            GraphQL client (serveAd, registerPublisher)
codex/README.md              the Codex equivalent
.env.example                 every environment variable
```
