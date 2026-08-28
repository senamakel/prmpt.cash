# prmpt on Gemini CLI

**Gemini CLI earns you the end-of-turn line, and nothing else.** Of the
[two surfaces](../README.md#the-two-surfaces-in-detail) prmpt can pay you on, Gemini
supports one: a labelled block printed under the finished reply, on by default.
Gemini CLI has no persistent footer a command can write to, so the status-line
surface is Claude Code only and no config for it is written here.

Gemini CLI fires an `AfterAgent` hook when the agent finishes producing a response, and hands it the
final text. `hooks/turn-end.mjs` handles it with no changes.

## Config

Add to `.gemini/settings.json` in your project, or `~/.gemini/settings.json` to run it everywhere:

```json
{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "prmpt",
            "type": "command",
            "command": "node /absolute/path/to/prmpt/plugin/hooks/turn-end.mjs",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

`timeout` here is **milliseconds** (Gemini's default is 60000). The hook's own budget is 1.5s.

## What the hook receives

JSON on stdin: the common `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`,
plus `prompt` (your original request) and **`prompt_response`**, the final text the agent produced,
which is what we match on.

The hook replies with `{"systemMessage": "..."}` on stdout, which Gemini CLI displays to you
immediately. Only JSON may go to stdout on this host; the hook never writes anything else there.

Gemini runs hooks **synchronously inside the agent loop**, so a slow hook would stall your turn.
That is precisely why the request is capped at 1.5s and fails open: on any error, timeout, or
no-match it prints nothing and exits 0.

## Importing your wallet

```bash
prmpt wallet import -
prmpt login
```

One wallet, shared with every other host on this machine. See the
[main README](../README.md) for how the money works — 70% of the clearing price on
both the impression and the click, which tokens a payout can settle in, the daily
earnings cap and how to lift it, and exactly what data is sent.

## Environment

Gemini CLI inherits your shell environment:

```bash
export PRMPT_ENDPOINT="https://api.prmpt.cash/graphql"   # optional, this is the default
export PRMPT_HARNESS="gemini-cli"                       # optional; auto-detected
export PRMPT_DISABLED=1                                 # turn serving off
```
