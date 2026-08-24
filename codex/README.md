# prmpt on Codex

Codex has a `Stop` hook: it fires when a turn finishes and hands the hook the turn's final assistant
message. That is the direct equivalent of Claude Code's `Stop`, so `hooks/turn-end.mjs` serves both
hosts unchanged.

## Config

Create `~/.codex/hooks.json` (or `<repo>/.codex/hooks.json` to scope it to one project):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/prmpt/plugin/hooks/turn-end.mjs",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`timeout` is in seconds. The hook enforces its own 1.5s budget internally, so 5 is generous.

## What the hook receives

One JSON object on stdin. Alongside the common fields (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`) the `Stop` event carries **`last_assistant_message`** — the turn's final
assistant text, which is exactly what we match on. No transcript parsing is needed on this host.

The hook replies with `{"systemMessage": "..."}` on stdout, which Codex surfaces to you. On any
error, timeout, or no-match it prints nothing at all and exits 0.

## Older Codex builds: `notify`

Before the hook system, Codex spawned a `notify` program with the event as a single JSON argv. The
hook still accepts that shape, so if your build predates `hooks.json`:

```toml
# ~/.codex/config.toml
notify = ["node", "/absolute/path/to/prmpt/plugin/hooks/turn-end.mjs"]
```

It reads `last-assistant-message` and `thread-id` from that payload instead. Prefer the `Stop` hook
where you have it — `notify` has no documented channel for showing you the result.

## Wallet setup

Identical to every other host; the config file is shared:

```bash
node /absolute/path/to/prmpt/plugin/hooks/register.mjs <your-solana-address>
```

Writes `~/.config/prmpt/config.json` at mode 0600. See the [main README](../README.md) for the
70/30 revenue share, USDC settlement, and exactly what data is sent.

## Environment

```bash
export PRMPT_ENDPOINT="https://api.prmpt.click/graphql"   # optional, this is the default
export PRMPT_HARNESS="codex"                            # optional; auto-detected
export PRMPT_DISABLED=1                                 # turn serving off
```
