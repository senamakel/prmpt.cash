#!/bin/sh
# prmpt.cash -- one installer for every supported coding agent.
#
#   curl -fsSL https://prmpt.cash/install.sh | sh
#
# What it does, in order:
#   1. checks Node >= 18                (the hook is plain ESM, no dependencies)
#   2. copies the plugin to a stable directory
#   3. asks where to install itself, on a terminal; --agents or -y skips it
#   4. creates a Solana wallet and signs in with it, storing both at mode 0600
#   5. wires up every agent it chose, using that agent's own documented hook
#   6. opens the setup page on the web, signed in (--no-onboard skips it)
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
NO_ONBOARD=0
ASSUME_YES=0
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
  --no-onboard         Do not open the setup page in a browser at the end
                       (PRMPT_NO_ONBOARD=1 does the same)
  -y, --yes            Skip the picker and wire up every host that is present,
                       without the status line or the editor extensions. This is
                       also what happens when there is no terminal to draw on
  --version <tag>      Install a specific release, e.g. v0.2.0 (default: latest)
  --agents <list>      Comma-separated: claude,codex,gemini,amp. Default: autodetect
  --endpoint <url>     API endpoint. Default: $DEFAULT_ENDPOINT
  --dir <path>         Where to install. Default: \$XDG_DATA_HOME/prmpt
  --project            Configure ./ (this project) instead of your home directory
  --editor             Also install the VS Code / Cursor extension, if one of
                       them is on your PATH (--no-editor to skip the offer)
  --statusline         Also show the ad on Claude Code's status line, above your
                       prompt. OPT-IN: Claude Code hides most of its footer key
                       hints -- including "esc to interrupt" -- whenever a custom
                       status line is set, so this is never wired up for you
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
    --no-onboard) NO_ONBOARD=1; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    --version)   VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --agents)    AGENTS="${2:-}"; shift 2 ;;
    --agents=*)  AGENTS="${1#*=}"; shift ;;
    --editor)    EDITOR_EXT=1; shift ;;
    --no-editor) EDITOR_EXT=0; shift ;;
    --statusline) STATUSLINE=1; shift ;;
    --no-statusline) STATUSLINE=0; shift ;;
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
[ "${PRMPT_NO_ONBOARD:-}" = "1" ] && NO_ONBOARD=1
[ "${PRMPT_YES:-}" = "1" ] && ASSUME_YES=1
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/prmpt"
fi

# Where the status line the user already had is recorded, so it can be run by
# ours and handed back on uninstall. Deliberately NOT config.json: that file is
# rewritten by every code path that touches settings, and losing somebody's
# footer to an unrelated write would be a poor trade.
#
# The same file, in the same shape, as the one hooks/lib/statusline-install.mjs
# writes for 'prmpt statusline install'. There are two ways to wire this surface
# up and one renderer reading the result, so a second format would mean an
# install done one way could not be undone the other.
STATE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/prmpt/statusline-chain-claude.json"

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
    if PRMPT_CFG="$f" PRMPT_STATE="$STATE_FILE" "$NODE_BIN" -e '
      const fs=require("fs"), p=process.env.PRMPT_CFG, state=process.env.PRMPT_STATE;
      const OURS=["turn-end.mjs","prompt-start.mjs"];
      let j; try { j=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,"")); } catch { process.exit(1); }
      let hit=false;
      for (const ev of Object.keys(j.hooks||{})) {
        const groups=j.hooks[ev];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (!Array.isArray(g.hooks)) continue;
          const before=g.hooks.length;
          g.hooks=g.hooks.filter(h=>!(typeof h?.command==="string" && OURS.some(n=>h.command.includes(n))));
          if (g.hooks.length!==before) hit=true;
        }
        j.hooks[ev]=groups.filter(g=>Array.isArray(g.hooks) ? g.hooks.length>0 : true);
        if (j.hooks[ev].length===0) delete j.hooks[ev];
      }
      if (j.hooks && Object.keys(j.hooks).length===0) delete j.hooks;
      // Give the status line back. Whatever was there before we arrived was
      // recorded at install time; without this the user is left with a footer
      // that runs a script we just deleted.
      // Ours, told apart from anybody else by the DIRECTORY as well as the
      // name. A bare "statusline.mjs" also matches a their-statusline.mjs that
      // somebody wrote themselves, and mistaking theirs for ours means either
      // deleting it or forking a copy of the renderer on every render.
      const MINE=/hooks[\/\\]statusline\.mjs/;
      const sl=j.statusLine;
      if (sl && typeof sl.command==="string" && MINE.test(sl.command)) {
        // Their whole setting goes back, not just the command: padding and any
        // other key they set were theirs, and restoring the command into OUR
        // object would hand them a merge of the two.
        let chain=null;
        try { const c=JSON.parse(fs.readFileSync(state,"utf8")); if (c && typeof c==="object") chain=c; } catch {}
        if (chain) j.statusLine=chain; else delete j.statusLine;
        try { fs.rmSync(state,{force:true}); } catch {}
        hit=true;
      }
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
# The status-line surface: one hook to fetch a decision when the user presses
# enter, and one command to render it in the footer while the model works.
PROMPT_HOOK="$HOOK_DIR/hooks/prompt-start.mjs"
STATUS_HOOK="$HOOK_DIR/hooks/statusline.mjs"

# ------------------------------------------------------------------- selection
# What gets installed where, chosen by the person installing it.
#
# The picker is additive, never a new requirement: it runs ONLY when nothing on
# the command line already decided the answer AND there is a terminal to draw it
# on. A Dockerfile, CI, a provisioning script or `--agents ...` all take exactly
# the path they took before, unprompted.
#
# It reads /dev/tty rather than stdin, and that is the whole reason it works at
# all: the canonical install is `curl ... | sh`, where stdin IS the script. A
# `read` from stdin there would eat the rest of the installer.
detected() { command -v "$1" >/dev/null 2>&1; }

# The same test the autodetect path uses -- a binary on PATH, or the config
# directory the host leaves behind. Kept in one place so the picker cannot
# disagree with what an unattended install would have done.
host_present() {
  case "$1" in
    claude)     detected claude || [ -d "$HOME/.claude" ] ;;
    statusline) host_present claude ;;
    codex)      detected codex  || [ -d "$HOME/.codex" ] ;;
    gemini)     detected gemini || [ -d "$HOME/.gemini" ] ;;
    amp)        detected amp    || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/amp" ] ;;
    cursor)     detected cursor ;;
    code)       detected code ;;
    *)          return 1 ;;
  esac
}

pick_label() {
  case "$1" in
    claude)     printf '%s' "Claude Code   ${D}Stop -- the line at the end of a turn${R}" ;;
    statusline) printf '%s' "  status line ${D}the same ad above your prompt while it thinks${R}" ;;
    codex)      printf '%s' "Codex         ${D}Stop -- the line at the end of a turn${R}" ;;
    gemini)     printf '%s' "Gemini CLI    ${D}AfterAgent -- the line at the end of a turn${R}" ;;
    amp)        printf '%s' "Amp           ${D}agent.end -- unverified against a live install${R}" ;;
    cursor)     printf '%s' "Cursor        ${D}editor extension: sidebar card + chat card${R}" ;;
    code)       printf '%s' "VS Code       ${D}editor extension: sidebar card${R}" ;;
  esac
}

PICK_ROWS="claude statusline codex gemini amp cursor code"

pick_get()    { eval "printf '%s' \"\$PICK_$1\""; }
pick_set()    { eval "PICK_$1=$2"; }
pick_toggle() { if [ "$(pick_get "$1")" = 1 ]; then pick_set "$1" 0; else pick_set "$1" 1; fi; }

# Everything starts ticked, including hosts that are not installed yet: pressing
# Enter is the whole install, and a host wired before it exists simply works the
# day it arrives. Detection decides the "(not found)" note, not the box.
#
# The status line is the one row with a cost attached -- Claude Code hides most
# of its footer key hints while any custom status line is set -- so it is ticked
# but the cost is spelled out under the list, where somebody can untick it
# BEFORE it happens rather than wondering afterwards where their hints went.
for _k in $PICK_ROWS; do pick_set "$_k" 1; done

pick_render() {
  say ""
  say "${B}Where should prmpt install itself?${R}"
  say ""
  _n=0
  for _k in $PICK_ROWS; do
    _n=$((_n + 1))
    if [ "$(pick_get "$_k")" = 1 ]; then _box="${G}[x]${R}"; else _box="${D}[ ]${R}"; fi
    if host_present "$_k"; then _note=""; else _note="  ${D}(not found)${R}"; fi
    printf '  %s %s. %s%s\n' "$_box" "$_n" "$(pick_label "$_k")" "$_note"
  done
  say ""
  say "  ${D}A host that is not there yet is still wired up, so it works the day you"
  say "  install it. A status line hides most of Claude Code's footer key hints,"
  say "  including \"esc to interrupt\" -- that is Claude Code behaviour, not prmpt's."
  say "  Untick 2 to keep them.${R}"
  say ""
}

if [ "$ASSUME_YES" -eq 0 ] && [ -z "$AGENTS" ] && [ -t 1 ] && [ -r /dev/tty ]; then
  while :; do
    pick_render
    printf '  %sNumber to toggle%s, %sa%s all, %sn%s none, %sEnter%s to install, %sq%s to quit: ' \
      "$B" "$R" "$B" "$R" "$B" "$R" "$B" "$R" "$B" "$R"
    if ! IFS= read -r _reply < /dev/tty; then say ""; break; fi
    # Commas are what people type when a prompt shows a list; accept them.
    _reply=$(printf '%s' "$_reply" | tr ',' ' ')
    case "$_reply" in
      ''|y|Y|yes|YES) break ;;
      q|Q|quit) say ""; say "  nothing was installed."; exit 0 ;;
      a|A|all)  for _k in $PICK_ROWS; do pick_set "$_k" 1; done ;;
      n|N|none) for _k in $PICK_ROWS; do pick_set "$_k" 0; done ;;
      *)
        for _tok in $_reply; do
          case "$_tok" in
            ''|*[!0-9]*) warn "not a number: $_tok"; continue ;;
          esac
          _n=0; _hit=0
          for _k in $PICK_ROWS; do
            _n=$((_n + 1))
            if [ "$_n" = "$_tok" ]; then pick_toggle "$_k"; _hit=1; break; fi
          done
          [ "$_hit" -eq 1 ] || warn "no such option: $_tok"
        done ;;
    esac
  done

  # The status line lives inside Claude Code's settings file and is wired up as
  # part of wiring Claude Code. Asking for it without the host it draws in is a
  # request that could only ever do nothing, so it selects the host too rather
  # than being silently dropped.
  if [ "$(pick_get statusline)" = 1 ] && [ "$(pick_get claude)" = 0 ]; then
    pick_set claude 1
    warn "the status line is drawn by Claude Code -- selecting Claude Code too."
  fi

  AGENTS=""
  for _k in claude codex gemini amp; do
    if [ "$(pick_get "$_k")" = 1 ]; then AGENTS="${AGENTS:+$AGENTS,}$_k"; fi
  done
  if [ "$(pick_get statusline)" = 1 ]; then STATUSLINE=1; else STATUSLINE=0; fi
  if [ "$(pick_get cursor)" = 1 ]; then EDITOR_CURSOR=1; else EDITOR_CURSOR=0; fi
  if [ "$(pick_get code)" = 1 ]; then EDITOR_CODE=1; else EDITOR_CODE=0; fi

  [ -n "$AGENTS" ] || die "nothing selected -- nothing was installed."
fi

# Per-editor flags fall back to the single --editor flag, so the non-interactive
# behaviour is unchanged: --editor means both, --no-editor means neither.
: "${EDITOR_CURSOR:=${EDITOR_EXT:-}}"
: "${EDITOR_CODE:=${EDITOR_EXT:-}}"

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
  # --no-onboard: the setup link is minted at the very END of this run instead.
  # The code lives two minutes, and there are still agents to wire and a
  # screenful of output to print between here and the user reading anything.
  if PRMPT_ENDPOINT="$ENDPOINT" "$NODE_BIN" "$CLI" login --no-onboard; then
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
#
# Claude Code gets two more, because it is the only host with a status line:
# UserPromptSubmit to fetch, and the statusLine setting to render. Codex and
# Gemini CLI have no equivalent footer, so inventing one for them would wire up
# a hook that could never display anything.
merge_hook() {
  file="$1"; event="$2"; timeout="$3"; matcher="$4"; hookpath="$5"; backup="${6:-1}"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || printf '{}\n' > "$file"
  # Values reach the program through the ENVIRONMENT, never argv. install.ps1
  # runs the identical program, and PowerShell drops an empty-string argument to
  # a native command outright -- Claude Code and Codex pass an empty matcher, so
  # every later argument shifted by one and the hook path went missing. The
  # environment preserves an empty value and needs no quoting on either side.
  PRMPT_CFG="$file" PRMPT_EVENT="$event" PRMPT_TIMEOUT="$timeout" \
  PRMPT_MATCHER="$matcher" PRMPT_HOOK="$hookpath" PRMPT_BACKUP="$backup" \
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
    // Back up before the FIRST modification, never after. Claude Code takes
    // three passes over one file -- two hooks and the status line -- and a
    // backup per pass would leave a .bak of our own half-finished work rather
    // than of what the user actually had. PRMPT_BACKUP=0 says somebody already
    // took it this run; unset means take it, so a standalone run still does.
    if (raw && process.env.PRMPT_BACKUP !== "0") fs.copyFileSync(p, p+".bak");

    j.hooks = j.hooks || {};
    const groups = Array.isArray(j.hooks[event]) ? j.hooks[event] : [];
    // Drop any previous entry of ours so re-running cannot stack duplicates.
    // Keyed on the script being installed rather than on one hard-coded name:
    // there are two hooks now, on two different events, and a filter naming
    // only the first would stack a duplicate of the second on every run.
    const name = hook.split(/[\\/]/).pop();
    for (const g of groups) {
      if (Array.isArray(g.hooks)) {
        g.hooks = g.hooks.filter(h => !(typeof h?.command === "string" && h.command.includes(name)));
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

# The status line is a Claude Code surface and only Claude Code has one. It is
# NOT a hook: it is a settings key holding a command, so it gets its own merge.
#
# The rule that matters here is that we WRAP rather than replace. Most people
# who will install this already have a status line they built, and silently
# taking it away over an ad plugin is the fastest way to be uninstalled.
merge_statusline() {
  file="$1"; hookpath="$2"; backup="${3:-1}"
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || printf '{}\n' > "$file"
  # Through the environment, never argv -- same reason as merge_hook.
  PRMPT_CFG="$file" PRMPT_HOOK="$hookpath" PRMPT_STATE="$STATE_FILE" PRMPT_BACKUP="$backup" \
  "$NODE_BIN" -e '
    const fs=require("fs"), path=require("path");
    const p=process.env.PRMPT_CFG, hook=process.env.PRMPT_HOOK, state=process.env.PRMPT_STATE;
    let j={};
    const raw = fs.existsSync(p) ? fs.readFileSync(p,"utf8").replace(/^\uFEFF/,"").trim() : "";
    if (raw) {
      try { j=JSON.parse(raw); }
      catch (e) { console.error("  unparseable JSON, leaving it alone: "+p); process.exit(3); }
    }
    if (raw && process.env.PRMPT_BACKUP !== "0") fs.copyFileSync(p, p+".bak");
    const prev = (j.statusLine && typeof j.statusLine === "object") ? j.statusLine : {};
    const prevCmd = typeof prev.command === "string" ? prev.command : "";
    // Record theirs so our renderer can run it and uninstall can hand it back.
    // Never record OUR OWN command: a re-install would otherwise make every
    // render fork a fresh copy of the renderer, forever.
    // Ours, told apart from anybody else by the DIRECTORY as well as the
    // name -- see the uninstall program above.
    if (prevCmd && !/hooks[\/\\]statusline\.mjs/.test(prevCmd)) {
      fs.mkdirSync(path.dirname(state), { recursive:true, mode:0o700 });
      fs.writeFileSync(state, JSON.stringify(prev, null, 2)+"\n", { mode:0o600 });
      fs.chmodSync(state, 0o600);
    }
    // Their other statusLine keys (padding and friends) are display preferences
    // and are kept; only the command becomes ours.
    j.statusLine = { ...prev, type:"command", command:`node ${JSON.stringify(hook)}` };
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  '
}

want() {
  [ -z "$AGENTS" ] && return 1          # empty means autodetect, handled by caller
  case ",$AGENTS," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# Why a host was passed over. With an explicit list -- from --agents or from the
# picker -- "not found" would be a lie about a host that is sitting right there
# and was simply not asked for.
passed_over() {
  if [ -n "$AGENTS" ]; then skip "$1 not selected"; else skip "$1 not found"; fi
}

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

# Claude Code -- Stop, timeout in seconds, plus the OPT-IN status-line surface.
#
# The status line is never wired up for you, and that is a deliberate product
# decision rather than caution. Claude Code drops most of its footer keyboard
# hints -- "esc to interrupt" among them -- the moment any custom status line
# exists. Taking a keybinding hint away from somebody who only asked for an ad
# at the end of a turn is not a trade this installer makes on their behalf, and
# on an upgrade it would take it away from every existing install at once.
#
# UserPromptSubmit is gated with it, not separately. That hook exists ONLY to
# fetch a decision for the status line, so wiring it without somewhere to draw
# the result would spend a request -- and send keywords derived from what the
# user typed -- for an ad that could never appear.
if { [ -n "$AGENTS" ] && want claude; } || { [ -z "$AGENTS" ] && { detected claude || [ -d "$HOME/.claude" ]; }; }; then
  if merge_hook "$CLAUDE_CFG" "Stop" 5 "" "$HOOK"; then
    ok "Claude Code  $CLAUDE_CFG  ${D}(Stop)${R}"; CONFIGURED=$((CONFIGURED+1))
    if [ "${STATUSLINE:-0}" = "1" ]; then
      if merge_hook "$CLAUDE_CFG" "UserPromptSubmit" 5 "" "$PROMPT_HOOK" 0; then
        ok "             ${D}+ UserPromptSubmit (fetches the status-line slot)${R}"
      fi
      if merge_statusline "$CLAUDE_CFG" "$STATUS_HOOK" 0; then
        if [ -f "$STATE_FILE" ]; then
          ok "             ${D}+ statusLine (wrapping the one you already had)${R}"
        else
          ok "             ${D}+ statusLine${R}"
        fi
      fi
    else
      skip "status line not installed -- see below to turn it on"
    fi
  fi
else passed_over "Claude Code"; fi

# Codex -- Stop, timeout in seconds. Same event name as Claude Code; the hook
# tells them apart by CLAUDECODE=1 at runtime.
if { [ -n "$AGENTS" ] && want codex; } || { [ -z "$AGENTS" ] && { detected codex || [ -d "$HOME/.codex" ]; }; }; then
  if merge_hook "$CODEX_CFG" "Stop" 5 "" "$HOOK"; then
    ok "Codex        $CODEX_CFG  ${D}(Stop)${R}"; CONFIGURED=$((CONFIGURED+1))
  fi
else passed_over "Codex"; fi

# Gemini CLI -- AfterAgent, timeout in MILLISECONDS, and it wants a matcher.
if { [ -n "$AGENTS" ] && want gemini; } || { [ -z "$AGENTS" ] && { detected gemini || [ -d "$HOME/.gemini" ]; }; }; then
  if merge_hook "$GEMINI_CFG" "AfterAgent" 5000 "*" "$HOOK"; then
    ok "Gemini CLI   $GEMINI_CFG  ${D}(AfterAgent, ms)${R}"; CONFIGURED=$((CONFIGURED+1))
  fi
else passed_over "Gemini CLI"; fi

# Amp -- a TypeScript plugin, not a hook. Unverified against a live install.
if { [ -n "$AGENTS" ] && want amp; } || { [ -z "$AGENTS" ] && { detected amp || [ -d "$HOME/.config/amp" ]; }; }; then
  if [ -f "$INSTALL_DIR/amp/prmpt.ts" ]; then
    mkdir -p "$AMP_DIR" && cp "$INSTALL_DIR/amp/prmpt.ts" "$AMP_DIR/prmpt.ts"
    ok "Amp          $AMP_DIR/prmpt.ts  ${D}(agent.end, unverified)${R}"
    CONFIGURED=$((CONFIGURED+1))
  fi
else passed_over "Amp"; fi

# ------------------------------------------------------------ editor extension
# The extension is a DISPLAY for what the hook already matched -- it is what
# gives Cursor somewhere to put an ad at all, since a Cursor hook can read a
# turn but has nowhere to show the result. Offered, never forced: it is a
# separate artifact with its own uninstall, and an installer that silently adds
# things to somebody's editor is not one people should pipe into sh.
install_editor_ext() {
  _bin="$1"; _name="$2"

  # A checkout or an unpacked release may carry the built vsix beside it; a
  # normal install downloads it from the same release as the tarball, so the
  # two can never be from different versions.
  _vsix=""
  for _cand in "$INSTALL_DIR"/vscode/prmpt-vscode-*.vsix "$INSTALL_DIR"/vscode/*.vsix; do
    [ -f "$_cand" ] && { _vsix="$_cand"; break; }
  done

  if [ -z "$_vsix" ]; then
    _ver=$(node -p "require('$INSTALL_DIR/package.json').version" 2>/dev/null) || return 1
    [ -n "$_ver" ] || return 1
    _tmp=$(mktemp -d)
    _vsix="$_tmp/prmpt-vscode-$_ver.vsix"
    _url="https://github.com/$REPO_SLUG/releases/download/v$_ver/prmpt-vscode-$_ver.vsix"
    curl -fsSL "$_url" -o "$_vsix" 2>/dev/null || { rm -rf "$_tmp"; return 1; }
  fi

  if "$_bin" --install-extension "$_vsix" --force >/dev/null 2>&1; then
    ok "$_name extension installed  ${D}(reload the window)${R}"
    return 0
  fi
  return 1
}

offer_editor_ext() {
  _bin="$1"; _name="$2"; _want="$3"
  command -v "$_bin" >/dev/null 2>&1 || return 0
  if [ "$_want" = "1" ]; then
    install_editor_ext "$_bin" "$_name" \
      || warn "$_name found but the extension could not be installed."
  elif [ "$_want" != "0" ]; then
    skip "$_name found -- re-run with --editor to add the sidebar card"
  fi
}

offer_editor_ext cursor Cursor "${EDITOR_CURSOR:-}"
offer_editor_ext code "VS Code" "${EDITOR_CODE:-}"

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
if [ "${STATUSLINE:-0}" = "1" ]; then
  if [ -f "$STATE_FILE" ]; then
    say ""
    say "  ${D}Your status line still runs; ours is drawn on the row beneath it,"
    say "  and --uninstall gives yours back exactly as it was.${R}"
  fi
else
  # Said whether or not Claude Code is present: the trade-off is the reason
  # this is off, and somebody deciding to turn it on deserves to know the cost
  # before they do, not after their key hints have gone.
  say ""
  say "  ${D}Not installed: the status line.${R} The same ad can also sit on the row"
  say "  above your prompt while the model works, refreshed from the prompt you"
  say "  just typed. It is off because Claude Code hides most of its footer key"
  say '  hints -- including "esc to interrupt" -- whenever a custom status line'
  say "  is set. That is Claude Code behaviour, not something prmpt chooses."
  say ""
  say "  ${D}Turn it on:${R}   $NODE_BIN $CLI statusline install"
  say "                  ${D}(or re-run this installer with --statusline)${R}"
fi
say ""
# Finishing setup on the web is part of installing, not a second command to
# remember: the payout token and the account links that lift the daily earnings
# cap both live there, and an install that never gets there earns at a cap it
# was never told about.
#
# It runs HERE, last, rather than inside `login`, because the code is single-use
# and expires in two minutes -- minted before the agents were wired it would be
# dead on arrival. It runs on a re-install too, where there is no login step at
# all and the old code path printed nothing.
#
# Best effort, exactly like the Base link: the token is already on disk and the
# hooks are already wired, so a failed round trip here must not turn a good
# install into a bad exit code. The fallback is the command.
PRMPT_CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/prmpt/config.json"
if [ "$NO_ONBOARD" -eq 1 ] || [ ! -f "$PRMPT_CONFIG_FILE" ]; then
  say "  ${D}Finish setup:${R} $NODE_BIN $CLI onboard"
  say "                  Connect a GitHub or X account to lift the daily earnings"
  say "                  cap, and pick which token you are paid in."
else
  say "${B}Finishing setup on the web${R}"
  say "  ${D}Connect a GitHub or X account to lift the daily earnings cap, and"
  say "  pick which token you are paid in.${R}"
  say ""
  # No terminal means nobody is sitting here to see a browser window, and an
  # unattended install must not pop one. The link is printed either way.
  if [ -t 1 ]; then _onboard_open=""; else _onboard_open="--no-open"; fi
  if PRMPT_ENDPOINT="$ENDPOINT" "$NODE_BIN" "$CLI" onboard $_onboard_open; then
    :
  else
    warn "could not open the setup page. Run it yourself when you are ready:"
    warn "  $NODE_BIN $CLI onboard"
  fi
fi
say ""
say "  ${D}Turn it off:${R}  export PRMPT_DISABLED=1"
if [ -f "$INSTALL_DIR/install.sh" ]; then
  say "  ${D}Remove it:${R}    $INSTALL_DIR/install.sh --uninstall"
else
  # $0 is "sh" when this was piped from curl, so it is not a runnable path.
  say "  ${D}Remove it:${R}    curl -fsSL https://prmpt.cash/install.sh | sh -s -- --uninstall"
fi
