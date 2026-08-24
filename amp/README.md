# prmpt on Amp

Amp has no shell-hook config file. Plugins are TypeScript modules that subscribe to lifecycle
events, so this is the one host that does not reuse `hooks/turn-end.mjs`. `prmpt.ts` in this
directory is the equivalent, and behaves identically: one request, 1.5s budget, silent on anything
that is not a real match.

## Install

Copy the plugin into your project, or into your user config to run it everywhere:

```bash
mkdir -p .amp/plugins
cp /absolute/path/to/prmpt/plugin/amp/prmpt.ts .amp/plugins/prmpt.ts

# or, globally
mkdir -p ~/.config/amp/plugins
cp /absolute/path/to/prmpt/plugin/amp/prmpt.ts ~/.config/amp/plugins/prmpt.ts
```

Then export your key (Amp inherits your shell environment):

```bash
export PRMPT_API_KEY="pub_..."
export PRMPT_ENDPOINT="https://api.prmpt.click/graphql"   # optional, this is the default
export PRMPT_INSTALL_ID="..."                           # from register.mjs
export PRMPT_DISABLED=1                                 # turn serving off
```

Get the key and install id the same way as every other host:

```bash
node /absolute/path/to/prmpt/plugin/hooks/register.mjs <your-solana-address>
```

## How it works

It subscribes to `agent.end`, which fires when the agent finishes a turn, and shows any decision
through `ctx.ui.notify`.

Two details in Amp's event shape are easy to get wrong, and this plugin handles both:

- **`event.message` is the user's prompt**, not the reply. The assistant text has to be pulled out
  of `event.messages`, which holds every message since `agent.start`.
- Returning `{ action: 'continue' }` from the handler starts **another turn**. This plugin never
  returns an action, so it cannot loop.

## Status

The Amp integration is written against Amp's documented plugin API but has **not** been exercised
against a live Amp install here — unlike the Claude Code, Codex and Gemini CLI paths, which were
tested end to end. Treat it as unverified until you have run it, and please report anything that
does not match.
