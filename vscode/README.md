# prmpt for VS Code and Cursor

Shows the sponsored line [prmpt](https://prmpt.cash) matched for your last agent
turn, so you get paid for coding you were doing anyway — 70% of the clearing price
for the ad being shown, and 70% again if you click it.

This extension is a **third place** the same decision can appear, alongside the
[two surfaces the CLI plugin drives](../README.md#the-two-surfaces-in-detail): the
end-of-turn line in every host, and Claude Code's status line. All three read one
parked decision, and an impression is claimed exactly once no matter how many of
them are on screen.

This extension is a **display**. It holds no key, makes no network call to our
backend, and decides nothing. The [prmpt CLI plugin](../README.md) hooks the end
of an agent turn, asks the backend whether any campaign matches *that turn's
text*, and parks the answer in `~/.config/prmpt/slot.json`. This extension reads
that file.

So: install the plugin first. Without it there is nothing to show.

```bash
curl -fsSL https://prmpt.cash/install.sh | sh
```

## What you get

| Placement | Where | Needs |
|---|---|---|
| Sidebar card | Explorer → **Sponsored** | nothing |
| Status bar | bottom left | nothing |
| Above the chat input | Cursor only, while the agent is working | your explicit yes — see below |

The first two use only public VS Code API and work in any VS Code-based editor.

## The Cursor chat card

Cursor exposes no extension point anywhere near its chat composer. The only way
to put something there is to add a line to Cursor's own startup file,
`workbench.js`, inside your Cursor installation.

The extension will **ask you once** before doing that, and never does it
silently. If you say no it is remembered, and the sidebar and status bar carry
on working.

What it actually does:

- Backs up `workbench.js` before the first write, and restores from that backup
  rather than by un-editing it.
- Appends one call at the end of the bootstrap. Nothing is repacked, no
  integrity hash is recomputed, and **nothing is re-signed** — unlike patching an
  Electron app's `app.asar`, this is plain unsigned JavaScript on disk.
- Validates the injected script parses before writing it. A syntax error here
  would land in Cursor's startup path, so this check is the difference between
  "no card" and "no editor".
- Fails closed. If a Cursor update moves the code we hook, the patch is refused
  and you are told; the other two placements are unaffected.

Remove it any time with **prmpt: Remove Cursor Chat Card**. A Cursor update will
also revert it — re-run **prmpt: Apply Cursor Chat Card** if you want it back.

Uninstalling the extension deliberately does *not* revert the patch. Silently
rewriting your editor on uninstall is worse than leaving a file you were told
about.

### How the card gets its copy

The card runs in Cursor's renderer, which cannot read your filesystem. The
extension host serves the parked headline over `127.0.0.1` (port 51793 by
default, `prmpt.bridgePort`), loopback only, and the card polls it. The click URL
is deliberately **not** sent to the renderer — clicking asks the extension host
to open it, so every placement attributes a click identically and the renderer
never holds a URL it could navigate to on its own.

## Plain VS Code

The sidebar and status bar work, but VS Code and Copilot give a hook no way to
read the finished turn, so nothing populates the slot from inside VS Code
itself. What does work: running Claude Code, Codex or Cursor's agent on the same
machine — including in VS Code's own terminal — fills the slot, and this
extension renders it.

We would rather say that than infer "the AI is probably working" from file-edit
timing and show an ad against a guess.

## Settings

| Setting | Default | |
|---|---|---|
| `prmpt.showStatusBar` | `true` | Show the current line in the status bar |
| `prmpt.cursorChatCard` | `ask` | `ask`, `on`, or `off` |
| `prmpt.bridgePort` | `51793` | Loopback port; changing it needs the chat patch re-applied |

## Development

```bash
npm install
npm run build      # esbuild → dist/extension.js
npm test           # patch surgery, slot parsing, bridge
npm run package    # → prmpt-<version>.vsix
```

The tests compile `patchText.ts`, `chatInject.ts`, `slot.ts` and `bridge.ts` with
esbuild and run the output, so what is asserted is what ships. They cover the
failure that actually matters — a patched `workbench.js` that does not parse —
along with re-patch idempotence, stale-marker detection, and that the bridge
answers on loopback and nowhere else.

## License

GNU General Public License v3.0 or later, the same as the plugin it renders for.
The full text is in [LICENSE](LICENSE), and it ships inside the `.vsix`.

Copyright (C) 2026 prmpt.cash
