# adengine on Codex

Codex has no plugin system, but it does have a `notify` program: an external command Codex spawns on
certain lifecycle events, with the event as a single JSON argument. The `agent-turn-complete` event
is Codex's equivalent of Claude Code's `Stop`, so the same `hooks/turn-end.mjs` serves both hosts.

## Config snippet

Add one line to `~/.codex/config.toml`:

```toml
notify = ["node", "/absolute/path/to/plugin/hooks/turn-end.mjs"]
```

Codex appends the event JSON as the next argument, so the process is invoked as:

```
node /absolute/path/to/plugin/hooks/turn-end.mjs '{"type":"agent-turn-complete", ...}'
```

The hook accepts the payload from **either** stdin (Claude Code) or `argv[2]` (Codex), whichever is
present, so no separate entry point is needed. It reads `last-assistant-message` for the turn text
and `thread-id` for the session id when Codex supplies them, and ignores any event whose `type` is
not `agent-turn-complete`.

## Wallet setup

Identical to Claude Code — the plugin's config file is shared:

```bash
node /absolute/path/to/plugin/hooks/register.mjs 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM
```

Writes `~/.config/adengine/config.json` at mode 0600. See the [main README](../README.md) for the
70/30 revenue share, USDC settlement on Solana devnet, and exactly what data is sent.

## Environment

Same variables as everywhere else. Codex inherits your shell environment, so exporting them in your
shell profile is enough:

```bash
export ADENGINE_ENDPOINT="http://localhost:8080/graphql"   # optional, this is the default
export ADENGINE_DISABLED=1                                 # turn serving off
```

Because `notify` output is not rendered inside the Codex TUI, run with `ADENGINE_OUTPUT=text` if you
want the block written to the terminal where Codex was launched:

```toml
notify = ["/usr/bin/env", "ADENGINE_OUTPUT=text", "node", "/absolute/path/to/plugin/hooks/turn-end.mjs"]
```

## Verifying it

Simulate a turn without waiting for Codex:

```bash
node hooks/turn-end.mjs "$(cat <<'JSON'
{"type":"agent-turn-complete","thread-id":"t_local","last-assistant-message":"I tracked the flakiness down to a race in the test setup: two suites shared one Postgres schema and the second truncated tables mid-transaction. Each suite now gets its own schema."}
JSON
)"
```

With no API key configured this prints nothing and exits 0 — that is the correct result, and the
same result you get from any failure. See the fail-open notes in the [main README](../README.md).

## Caveats

Codex's `notify` contract is thinner than Claude Code's hook contract: it is a notification, not a
hook that can shape the turn. So on Codex the sponsored block goes to the launching terminal rather
than into the conversation view, and there is no transcript path to fall back on if a future Codex
version stops sending `last-assistant-message`. In that case the hook simply stays silent.
