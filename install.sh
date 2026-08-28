#!/bin/sh
# prmpt.cash -- one installer for every supported coding agent.
#
#   curl -fsSL https://prmpt.cash/install.sh | sh
#
# What it does, in order:
#   1. checks Node >= 18                (the hook is plain ESM, no dependencies)
#   2. copies the plugin to a stable directory
#   3. creates a Solana wallet and signs in with it, storing both at mode 0600
#   4. wires up every agent it finds, using that agent's own documented hook
#
# It is idempotent: run it again to upgrade, re-point, or add an agent. Existing
# config files are backed up before they are touched, and our own hook entry is
# replaced rather than appended, so repeated runs cannot stack duplicates.
#
# POSIX sh on purpose -- this gets piped into whatever /bin/sh the machine has.
set -eu

REPO_SLUG="senamakel/prmpt.cash"
REPO_URL="https://github.com/$REPO_SLUG.git"
# The fallback only. Normal installs come from a published release, so that what
# lands here is a specific, checksummed version rather than whatever main was
# at the moment you ran curl.
TARBALL_URL="https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/main"
DEFAULT_ENDPOINT="https://api.prmpt.cash/graphql"
VERSION=""

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
${B}prmpt.cash installer${R}

  --no-login           Install and wire up the agents, but create no wallet
                       (PRMPT_NO_LOGIN=1 does the same, for scripted installs)
  --version <tag>      Install a specific release, e.g. v0.2.0 (default: latest)
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

To use an existing wallet, install first and then import its seed phrase or
private key locally:

                    <install-dir>/bin/prmpt.mjs wallet import -

One other route is available:

  --no-login      install now, decide later:
                    <install-dir>/bin/prmpt.mjs login
                    <install-dir>/bin/prmpt.mjs wallet import <secret-key>
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-login)  NO_LOGIN=1; shift ;;
    --version)   VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
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

# PRMPT_NO_LOGIN=1 is --no-login by environment. It exists so an automated
# install -- a Dockerfile, a provisioning script, this project's own smoke suite
# -- can be stopped from signing in without having to remember the flag at every
# call site. Forgetting it is not a harmless mistake: without it the installer
# signs in against the DEFAULT endpoint, which is production, and creates a real
# publisher account behind a wallet that dies with the machine.
[ "${PRMPT_NO_LOGIN:-}" = "1" ] && NO_LOGIN=1
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
  say "${B}Removing prmpt.cash${R}"
  for f in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.gemini/settings.json" \
           "./.claude/settings.json" "./.codex/hooks.json" "./.gemini/settings.json"; do
    [ -f "$f" ] || continue
    if PRMPT_CFG="$f" "$NODE_BIN" -e '
      const fs=require("fs"), p=process.env.PRMPT_CFG;
      let j; try { j=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,"")); } catch { process.exit(1); }
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
    ' 2>/dev/null; then ok "cleaned $f (backup: $f.bak)"; fi
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
say "${B}prmpt.cash${R}"
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
  command -v curl >/dev/null 2>&1 || die "curl is required to download a release."
  command -v tar  >/dev/null 2>&1 || die "tar is required to unpack a release."

  # Ask the API which release to take. `releases/latest` excludes prereleases
  # and drafts, so an rc is never picked up by an install that did not name it.
  if [ -n "$VERSION" ]; then
    API="https://api.github.com/repos/$REPO_SLUG/releases/tags/$VERSION"
  else
    API="https://api.github.com/repos/$REPO_SLUG/releases/latest"
  fi

  # Parsed with node, which is already a hard requirement above. Pulling a
  # download URL out of JSON with grep and sed is how you end up installing
  # whatever a crafted release name happens to contain.
  meta=$("$NODE_BIN" -e '
    const url = process.argv[1];
    const headers = { "user-agent": "prmpt-install", accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.authorization = "Bearer " + process.env.GITHUB_TOKEN;
    fetch(url, { headers }).then(async (r) => {
      if (!r.ok) process.exit(3);
      const j = await r.json();
      const tag = j.tag_name || "";
      const version = tag.replace(/^v/i, "");
      const assets = Array.isArray(j.assets) ? j.assets : [];
      const pick = (n) => assets.find((a) => a && a.name === n);
      const tarball = pick(`prmpt-${version}.tar.gz`);
      const sums = pick("SHA256SUMS");
      if (!tarball || !sums) process.exit(4);
      process.stdout.write([tag, tarball.name, tarball.browser_download_url, sums.browser_download_url].join("\n"));
    }).catch(() => process.exit(3));
  ' "$API" 2>/dev/null) || meta=""

  if [ -n "$meta" ]; then
    TAG=$(printf '%s\n' "$meta" | sed -n 1p)
    ASSET=$(printf '%s\n' "$meta" | sed -n 2p)
    ASSET_URL=$(printf '%s\n' "$meta" | sed -n 3p)
    SUMS_URL=$(printf '%s\n' "$meta" | sed -n 4p)

    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/$ASSET" "$ASSET_URL" || die "could not download $ASSET"
    curl -fsSL -o "$tmp/SHA256SUMS" "$SUMS_URL" || die "could not download SHA256SUMS"

    # Verify before unpacking, not after. An unverified archive must never be
    # written over an install directory, even a fresh one.
    expected=$(sed -n "s/^\([0-9a-f]\{64\}\) [ *]*$ASSET$/\1/p" "$tmp/SHA256SUMS" | head -n 1)
    [ -n "$expected" ] || die "$ASSET is not listed in SHA256SUMS for $TAG"
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$tmp/$ASSET" | cut -d" " -f1)
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$tmp/$ASSET" | cut -d" " -f1)
    else
      actual=$("$NODE_BIN" -e '
        const c=require("crypto"),f=require("fs");
        process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"));
      ' "$tmp/$ASSET")
    fi
    [ "$actual" = "$expected" ] || die "checksum mismatch for $ASSET
  expected $expected
  got      $actual"

    unpack=$(mktemp -d)
    tar xzf "$tmp/$ASSET" -C "$unpack"
    # The release tarball is flat; a source tarball has one wrapping directory.
    [ -f "$unpack/hooks/turn-end.mjs" ] || {
      inner=$(find "$unpack" -maxdepth 2 -name turn-end.mjs -path '*/hooks/*' | head -n 1)
      [ -n "$inner" ] || die "$ASSET does not contain a plugin"
      unpack=$(dirname "$(dirname "$inner")")
    }
    rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
    (cd "$unpack" && tar cf - .) | (cd "$INSTALL_DIR" && tar xf -)
    rm -rf "$tmp" "$unpack"
    ok "installed $TAG to $INSTALL_DIR ${D}(sha256 verified)${R}"
  elif [ -n "$VERSION" ]; then
    die "no release $VERSION with an installable tarball. See https://github.com/$REPO_SLUG/releases"
  else
    # No release yet, or the API is unreachable. Fall back to main so a first
    # install still works before the first tag is cut -- and say so, because an
    # unverified snapshot is not the same thing as a release.
    warn "no published release found; falling back to main (not checksummed)"
    mkdir -p "$INSTALL_DIR"
    if command -v git >/dev/null 2>&1; then
      rm -rf "$INSTALL_DIR"
      git clone -q --depth 1 "$REPO_URL" "$INSTALL_DIR"
      ok "cloned main to $INSTALL_DIR"
    else
      tmp=$(mktemp -d)
      curl -fsSL "$TARBALL_URL" | tar xz -C "$tmp" --strip-components=1
      rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
      (cd "$tmp" && tar cf - .) | (cd "$INSTALL_DIR" && tar xf -)
      rm -rf "$tmp"
      ok "downloaded main to $INSTALL_DIR"
    fi
  fi
fi

# On Windows the installer runs under Git Bash, but every agent that will read
# the config is a native Windows program. It cannot resolve an MSYS path like
# /c/Users/foo, so the path recorded in the config must be converted first --
# otherwise the install looks perfect and the hook never once runs.
HOOK_DIR="$INSTALL_DIR"
if command -v cygpath >/dev/null 2>&1; then
  HOOK_DIR=$(cygpath -m "$INSTALL_DIR" 2>/dev/null || printf '%s' "$INSTALL_DIR")
fi

HOOK="$HOOK_DIR/hooks/turn-end.mjs"
[ -f "$HOOK" ] || die "the hook is missing at $HOOK -- the install did not complete."

# ------------------------------------------------------------------------ link
CLI="$INSTALL_DIR/bin/prmpt.mjs"
say ""
if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/prmpt/config.json" ]; then
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
  # Values reach the program through the ENVIRONMENT, never argv. install.ps1
  # runs the identical program, and PowerShell drops an empty-string argument to
  # a native command outright -- Claude Code and Codex pass an empty matcher, so
  # every later argument shifted by one and the hook path went missing. The
  # environment preserves an empty value and needs no quoting on either side.
  PRMPT_CFG="$file" PRMPT_EVENT="$event" PRMPT_TIMEOUT="$timeout" \
  PRMPT_MATCHER="$matcher" PRMPT_HOOK="$HOOK" \
  "$NODE_BIN" -e '
    const fs=require("fs");
    const p=process.env.PRMPT_CFG, event=process.env.PRMPT_EVENT;
    const timeout=process.env.PRMPT_TIMEOUT, matcher=process.env.PRMPT_MATCHER||"";
    const hook=process.env.PRMPT_HOOK;
    let j={};
    // Strip a BOM before parsing: Windows tooling writes them, JSON.parse rejects
    // them, and refusing to touch the file would leave the user silently unwired.
    const raw = fs.existsSync(p) ? fs.readFileSync(p,"utf8").replace(/^\uFEFF/,"").trim() : "";
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
    // Quoted, because the install dir routinely contains a space: macOS puts
    // it under "Application Support" and Windows under "C:/Users/Jane Smith".
    // An unquoted path there produces a config that parses and never runs.
    const entry = { type:"command", command:`node ${JSON.stringify(hook)}`, timeout:Number(timeout) };
    if (matcher) entry.name = "prmpt";
    const group = matcher ? { matcher, hooks:[entry] } : { hooks:[entry] };
    j.hooks[event] = groups.filter(g => Array.isArray(g.hooks) ? g.hooks.length>0 : true).concat([group]);
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  '
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
# The login above already printed a signed-in link, but that code lives two
# minutes -- long dead by the time somebody reads this and comes back. So the
# durable instruction is the command, not the link.
say "  ${D}Finish setup:${R} $NODE_BIN $CLI onboard"
say "                  Connect a GitHub or X account to lift the daily earnings"
say "                  cap, and pick which token you are paid in."
say ""
say "  ${D}Turn it off:${R}  export PRMPT_DISABLED=1"
if [ -f "$INSTALL_DIR/install.sh" ]; then
  say "  ${D}Remove it:${R}    $INSTALL_DIR/install.sh --uninstall"
else
  # $0 is "sh" when this was piped from curl, so it is not a runnable path.
  say "  ${D}Remove it:${R}    curl -fsSL https://prmpt.cash/install.sh | sh -s -- --uninstall"
fi
