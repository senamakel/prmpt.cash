#!/bin/sh
# prmpt.click -- one installer for every supported coding agent.
#
#   curl -fsSL https://prmpt.click/install.sh | sh -s -- --code <install-code>
#
# Or, from a checkout:  ./install.sh --code <install-code>
#
# What it does, in order:
#   1. checks Node >= 18                (the hook is plain ESM, no dependencies)
#   2. copies the plugin to a stable directory
#   3. creates a Solana wallet and signs in with it, storing both at mode 0600
#      (or redeems --code instead, if you would rather keep the key elsewhere)
#   4. wires up every agent it finds, using that agent's own documented hook
#
# It is idempotent: run it again to upgrade, re-point, or add an agent. Existing
# config files are backed up before they are touched, and our own hook entry is
# replaced rather than appended, so repeated runs cannot stack duplicates.
#
# POSIX sh on purpose -- this gets piped into whatever /bin/sh the machine has.
set -eu

REPO_URL="https://github.com/senamakel/prmpt.click.git"
TARBALL_URL="https://codeload.github.com/senamakel/prmpt.click/tar.gz/refs/heads/main"
DEFAULT_ENDPOINT="https://api.prmpt.click/graphql"

CODE=""
ENDPOINT=""
AGENTS=""
UNINSTALL=0
NO_LOGIN=0
SCOPE="user"
INSTALL_DIR=""

# ---------------------------------------------------------------- presentation
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m')
  G=$(printf '\033[32m'); Y=$(printf '\033[33m'); E=$(printf '\033[31m')
else
  B=''; D=''; R=''; G=''; Y=''; E=''
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s+%s %s\n' "$G" "$R" "$*"; }
skip() { printf '  %s-%s %s\n' "$D" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$E" "$R" "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
${B}prmpt.click installer${R}

  --code <code>        Redeem a dashboard install code instead of creating a
                       wallet here. Use it when the key must stay off this box.
  --no-login           Install and wire up the agents, but create no wallet
  --agents <list>      Comma-separated: claude,codex,gemini,amp. Default: autodetect
  --endpoint <url>     API endpoint. Default: $DEFAULT_ENDPOINT
  --dir <path>         Where to install. Default: \$XDG_DATA_HOME/prmpt
  --project            Configure ./ (this project) instead of your home directory
  --uninstall          Remove the hooks and the installed copy
  -h, --help           This text

By default this creates a Solana wallet for you and proves it to the backend by
signature -- no browser, no code to paste. The key is written to
~/.config/prmpt/wallet.json at mode 0600 and is the only copy: it is a hot
wallet holding ad revenue, so back it up with 'prmpt wallet export'.

Two other routes, both first-class:

  --code <code>   prove a wallet in the dashboard with a real wallet extension
                  and redeem the one-off code it mints. The key never touches
                  this machine.
  --no-login      install now, decide later:
                    <install-dir>/bin/prmpt.mjs login
                    <install-dir>/bin/prmpt.mjs wallet import <secret-key>
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-login)  NO_LOGIN=1; shift ;;
    --code)      CODE="${2:-}"; shift 2 ;;
    --code=*)    CODE="${1#*=}"; shift ;;
    --agents)    AGENTS="${2:-}"; shift 2 ;;
    --agents=*)  AGENTS="${1#*=}"; shift ;;
    --endpoint)  ENDPOINT="${2:-}"; shift 2 ;;
    --endpoint=*) ENDPOINT="${1#*=}"; shift ;;
    --dir)       INSTALL_DIR="${2:-}"; shift 2 ;;
    --dir=*)     INSTALL_DIR="${1#*=}"; shift ;;
    --project)   SCOPE="project"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$ENDPOINT" ] || ENDPOINT="$DEFAULT_ENDPOINT"
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/prmpt"
fi

# --------------------------------------------------------------- prerequisites
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required and was not found on PATH."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18+ required, found $(node -v 2>/dev/null || echo none)."

# Every JSON edit below goes through node. Hand-editing an agent's settings file
# with sed is how you corrupt somebody's whole config over an ad plugin.
NODE_BIN=$(command -v node)

# ------------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  say "${B}Removing prmpt.click${R}"
  for f in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.gemini/settings.json" \
           "./.claude/settings.json" "./.codex/hooks.json" "./.gemini/settings.json"; do
    [ -f "$f" ] || continue
    if "$NODE_BIN" -e '
      const fs=require("fs"), p=process.argv[1];
      let j; try { j=JSON.parse(fs.readFileSync(p,"utf8")); } catch { process.exit(1); }
      let hit=false;
      for (const ev of Object.keys(j.hooks||{})) {
        const groups=j.hooks[ev];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (!Array.isArray(g.hooks)) continue;
          const before=g.hooks.length;
          g.hooks=g.hooks.filter(h=>!(typeof h?.command==="string" && h.command.includes("turn-end.mjs")));
          if (g.hooks.length!==before) hit=true;
        }
        j.hooks[ev]=groups.filter(g=>Array.isArray(g.hooks) ? g.hooks.length>0 : true);
        if (j.hooks[ev].length===0) delete j.hooks[ev];
      }
      if (j.hooks && Object.keys(j.hooks).length===0) delete j.hooks;
      if (!hit) process.exit(2);
      fs.copyFileSync(p, p+".bak");
      fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
    ' "$f" 2>/dev/null; then ok "cleaned $f (backup: $f.bak)"; fi
  done
  for f in "$HOME/.config/amp/plugins/prmpt.ts" "./.amp/plugins/prmpt.ts"; do
    [ -f "$f" ] && rm -f "$f" && ok "removed $f"
  done
  [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR" && ok "removed $INSTALL_DIR"
  say ""
  say "Your token at ${D}~/.config/prmpt/config.json${R} and your wallet key at"
  say "${D}~/.config/prmpt/wallet.json${R} were both left alone -- on purpose. The key"
  say "is the only copy, and removing an ad plugin is not a reason to destroy it."
  say "Export it first if you want it, then delete the directory."
  say ""
  say "Note that deleting the token does not revoke it: nothing can, and it stays"
  say "valid until it expires."
  exit 0
fi

# ------------------------------------------------------------------ get source
say "${B}prmpt.click${R}"
say ""

# Running from a checkout? Use it. Otherwise fetch.
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/hooks/turn-end.mjs" ]; then
  if [ "$SELF_DIR" != "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    # -R over cp -a: BusyBox cp has no -a.
    (cd "$SELF_DIR" && tar cf - bin hooks amp codex gemini .claude-plugin package.json README.md install.sh 2>/dev/null) \
      | (cd "$INSTALL_DIR" && tar xf -)
    ok "installed from this checkout to $INSTALL_DIR"
  else
    ok "using $INSTALL_DIR"
  fi
else
  mkdir -p "$INSTALL_DIR"
  if command -v git >/dev/null 2>&1; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      (cd "$INSTALL_DIR" && git fetch -q origin main && git reset -q --hard origin/main)
      ok "updated $INSTALL_DIR"
    else
      rm -rf "$INSTALL_DIR"
      git clone -q --depth 1 "$REPO_URL" "$INSTALL_DIR"
      ok "cloned to $INSTALL_DIR"
    fi
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    tmp=$(mktemp -d)
    curl -fsSL "$TARBALL_URL" | tar xz -C "$tmp" --strip-components=1
    rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
    (cd "$tmp" && tar cf - .) | (cd "$INSTALL_DIR" && tar xf -)
    rm -rf "$tmp"
    ok "downloaded to $INSTALL_DIR"
  else
    die "need git, or curl and tar, to fetch the plugin."
  fi
fi

HOOK="$INSTALL_DIR/hooks/turn-end.mjs"
[ -f "$HOOK" ] || die "the hook is missing at $HOOK -- the install did not complete."

# ------------------------------------------------------------------------ link
CLI="$INSTALL_DIR/bin/prmpt.mjs"
say ""
if [ -n "$CODE" ]; then
  say "${B}Linking this install${R}"
  PRMPT_ENDPOINT="$ENDPOINT" "$NODE_BIN" "$CLI" link "$CODE" \
    || die "linking failed -- nothing was wired up. Fix the above and re-run."
elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/prmpt/config.json" ]; then
  skip "already linked (${D}~/.config/prmpt/config.json${R})"
elif [ "$NO_LOGIN" -eq 1 ]; then
  warn "--no-login: the hook will stay silent until you run"
  warn "  $NODE_BIN $CLI login"
else
  # The default path, and the reason this installer no longer needs a dashboard
  # visit: the plugin holds its own key and signs the SIWS challenge itself.
  #
  # A failure here is NOT fatal. The box may be offline, or behind a proxy, and
  # the hook enrols itself in the background on a later turn anyway. Wiring up
  # the agents is the part that has to happen while the installer is running.
  say "${B}Creating a wallet and signing in${R}"
  if PRMPT_ENDPOINT="$ENDPOINT" "$NODE_BIN" "$CLI" login; then
    :
  else
    warn "sign-in failed -- the agents are still being wired up."
    warn "the hook retries in the background, or run it yourself:"
    warn "  $NODE_BIN $CLI login"
  fi
fi

# ---------------------------------------------------------------- wire agents
# Each host gets its OWN documented event and its own timeout unit. These are
# not interchangeable and must not be "unified":
#   Claude Code  Stop        ~/.claude/settings.json    timeout SECONDS
#   Codex        Stop        ~/.codex/hooks.json        timeout SECONDS
#   Gemini CLI   AfterAgent  ~/.gemini/settings.json    timeout MILLISECONDS
#   Amp          agent.end   a TypeScript plugin file, not a hook at all
merge_hook() {
  file="$1"; event="$2"; timeout="$3"; matcher="$4"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || printf '{}\n' > "$file"
  "$NODE_BIN" -e '
    const fs=require("fs");
    const [p,event,timeout,matcher,hook]=process.argv.slice(1);
    let j={};
    const raw = fs.existsSync(p) ? fs.readFileSync(p,"utf8").trim() : "";
    if (raw) {
      try { j=JSON.parse(raw); }
      catch (e) { console.error("  unparseable JSON, leaving it alone: "+p); process.exit(3); }
    }
    // Back up before the first modification, never after.
    if (raw) fs.copyFileSync(p, p+".bak");

    j.hooks = j.hooks || {};
    const groups = Array.isArray(j.hooks[event]) ? j.hooks[event] : [];
    // Drop any previous entry of ours so re-running cannot stack duplicates.
    for (const g of groups) {
      if (Array.isArray(g.hooks)) {
        g.hooks = g.hooks.filter(h => !(typeof h?.command === "string" && h.command.includes("turn-end.mjs")));
      }
    }
    const entry = { type:"command", command:`node ${JSON.stringify(hook).slice(1,-1)}`, timeout:Number(timeout) };
    if (matcher) entry.name = "prmpt";
    const group = matcher ? { matcher, hooks:[entry] } : { hooks:[entry] };
    j.hooks[event] = groups.filter(g => Array.isArray(g.hooks) ? g.hooks.length>0 : true).concat([group]);
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  ' "$file" "$event" "$timeout" "$matcher" "$HOOK"
}

want() {
  [ -z "$AGENTS" ] && return 1          # empty means autodetect, handled by caller
  case ",$AGENTS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}
detected() { command -v "$1" >/dev/null 2>&1; }

if [ "$SCOPE" = "project" ]; then
  CLAUDE_CFG="./.claude/settings.json"; CODEX_CFG="./.codex/hooks.json"
  GEMINI_CFG="./.gemini/settings.json"; AMP_DIR="./.amp/plugins"
else
  CLAUDE_CFG="$HOME/.claude/settings.json"; CODEX_CFG="$HOME/.codex/hooks.json"
  GEMINI_CFG="$HOME/.gemini/settings.json"
  AMP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins"
fi

say ""
say "${B}Wiring up agents${R} ${D}($SCOPE scope)${R}"
CONFIGURED=0

# Claude Code -- Stop, timeout in seconds.
if { [ -n "$AGENTS" ] && want claude; } || { [ -z "$AGENTS" ] && { detected claude || [ -d "$HOME/.claude" ]; }; }; then
  if merge_hook "$CLAUDE_CFG" "Stop" 5 ""; then
    ok "Claude Code  $CLAUDE_CFG  ${D}(Stop)${R}"; CONFIGURED=$((CONFIGURED+1))
  fi
else skip "Claude Code not found"; fi

# Codex -- Stop, timeout in seconds. Same event name as Claude Code; the hook
# tells them apart by CLAUDECODE=1 at runtime.
if { [ -n "$AGENTS" ] && want codex; } || { [ -z "$AGENTS" ] && { detected codex || [ -d "$HOME/.codex" ]; }; }; then
  if merge_hook "$CODEX_CFG" "Stop" 5 ""; then
    ok "Codex        $CODEX_CFG  ${D}(Stop)${R}"; CONFIGURED=$((CONFIGURED+1))
  fi
else skip "Codex not found"; fi

# Gemini CLI -- AfterAgent, timeout in MILLISECONDS, and it wants a matcher.
if { [ -n "$AGENTS" ] && want gemini; } || { [ -z "$AGENTS" ] && { detected gemini || [ -d "$HOME/.gemini" ]; }; }; then
  if merge_hook "$GEMINI_CFG" "AfterAgent" 5000 "*"; then
    ok "Gemini CLI   $GEMINI_CFG  ${D}(AfterAgent, ms)${R}"; CONFIGURED=$((CONFIGURED+1))
  fi
else skip "Gemini CLI not found"; fi

# Amp -- a TypeScript plugin, not a hook. Unverified against a live install.
if { [ -n "$AGENTS" ] && want amp; } || { [ -z "$AGENTS" ] && { detected amp || [ -d "$HOME/.config/amp" ]; }; }; then
  if [ -f "$INSTALL_DIR/amp/prmpt.ts" ]; then
    mkdir -p "$AMP_DIR" && cp "$INSTALL_DIR/amp/prmpt.ts" "$AMP_DIR/prmpt.ts"
    ok "Amp          $AMP_DIR/prmpt.ts  ${D}(agent.end, unverified)${R}"
    CONFIGURED=$((CONFIGURED+1))
  fi
else skip "Amp not found"; fi

# ----------------------------------------------------------------------- done
say ""
if [ "$CONFIGURED" -eq 0 ]; then
  warn "no agents were configured."
  warn "pass --agents claude,codex,gemini,amp to wire one up anyway."
  exit 1
fi

if [ "$ENDPOINT" != "$DEFAULT_ENDPOINT" ]; then
  say "${Y}note${R} endpoint is $ENDPOINT -- export PRMPT_ENDPOINT to match in your shell."
fi

say "${B}Done.${R} $CONFIGURED agent(s) configured."
say ""
say "  Restart your agent, then just work. Most turns match nothing and print"
say "  nothing. On a match you get one labelled line; a click pays 70% of the"
say "  clearing price to your wallet in USDC."
say ""
say "  ${D}Turn it off:${R}  export PRMPT_DISABLED=1"
if [ -f "$INSTALL_DIR/install.sh" ]; then
  say "  ${D}Remove it:${R}    $INSTALL_DIR/install.sh --uninstall"
else
  # $0 is "sh" when this was piped from curl, so it is not a runnable path.
  say "  ${D}Remove it:${R}    curl -fsSL https://prmpt.click/install.sh | sh -s -- --uninstall"
fi
