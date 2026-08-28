# prmpt on Codex

**Codex earns you the end-of-turn line, and nothing else.** Of the
[two surfaces](../README.md#the-two-surfaces-in-detail) prmpt can pay you on, Codex
supports one: a labelled block printed under the finished reply, on by default. The
status line is Claude Code only — see [below](#there-is-no-codex-status-line).

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
`hook_event_name`, `model`) the `Stop` event carries **`last_assistant_message`**, the turn's final
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
where you have it, because `notify` has no documented channel for showing you the result.

## There is no Codex status line

Codex's `[tui] status_line` takes identifiers from a **closed set of built-in items**
— `model-with-reasoning`, `current-dir`, `git-branch`, `context-used` and so on. It
cannot run a command, so there is no way to draw an ad there. Verified against the
`codex 0.150.1` binary, which reports *"configuration contains unknown item
identifiers"* for anything else; `status_line_timeout_ms`, a key a competing ad
plugin writes into that file, does not exist in the binary at all.

[openai/codex#17827](https://github.com/openai/codex/issues/17827) is the open
feature request for command-backed status lines. Until it ships, config written
there produces startup warnings and renders nothing, so we do not write any. **Do
not paste a status-line block for Codex from anywhere, including from us.**

Codex still parks its decision in `~/.config/prmpt/slot.json`, which means the
[editor extension](../vscode/README.md) can render a Codex turn in VS Code or Cursor
even though Codex itself has nowhere to put it.

## Importing your wallet

Import a seed phrase or private key into the shared local wallet, then sign in:

```bash
prmpt wallet import -
prmpt login
```

Writes wallet and config files under `~/.config/prmpt/` at mode 0600. See the
[main README](../README.md) for how the money works — 70% of the clearing price on
both the impression and the click, which tokens a payout can settle in, the daily
earnings cap and how to lift it, and exactly what data is sent.

## Environment

```bash
export PRMPT_ENDPOINT="https://api.prmpt.cash/graphql"   # optional, this is the default
export PRMPT_HARNESS="codex"                            # optional; auto-detected
export PRMPT_DISABLED=1                                 # turn serving off
```
