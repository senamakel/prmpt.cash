<#
.SYNOPSIS
  prmpt.cash -- one installer for every supported coding agent, on Windows.

.DESCRIPTION
  The PowerShell twin of install.sh. Same steps, same on-disk result:

    1. checks Node >= 18            (the hook is plain ESM, no dependencies)
    2. copies the plugin to a stable directory
    3. creates a wallet and signs in with it
    4. wires up every agent it finds, using that agent's own documented hook

  Idempotent: run it again to upgrade, re-point, or add an agent. Existing
  config files are backed up before they are touched, and our own hook entry is
  replaced rather than appended, so repeated runs cannot stack duplicates.

  Every JSON edit is delegated to the SAME node one-liners install.sh uses.
  That is deliberate: the merge is the part that can corrupt somebody's agent
  config, and two hand-written implementations would drift. PowerShell's
  ConvertTo-Json also mangles nested structures at default depth, which is
  exactly the wrong tool here.

.EXAMPLE
  # The default: creates a Solana wallet here and proves it by signature.
  .\install.ps1

#>
[CmdletBinding()]
param(
  [switch] $NoLogin,
  [string] $Version  = $env:PRMPT_VERSION,
  [string] $Agents   = $env:PRMPT_AGENTS,
  [string] $Endpoint = $env:PRMPT_ENDPOINT,
  [string] $Dir      = $env:PRMPT_DIR,
  [switch] $Project,
  [switch] $StatusLine,
  [switch] $NoOnboard,
  [switch] $Yes,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

# PRMPT_NO_LOGIN=1 is -NoLogin by environment, for scripted installs that cannot
# easily pass a switch. Without it the installer signs in against the default
# endpoint -- production -- and creates a real publisher behind a throwaway wallet.
if ($env:PRMPT_NO_LOGIN -eq '1') { $NoLogin = [switch]$true }
if ($env:PRMPT_NO_ONBOARD -eq '1') { $NoOnboard = [switch]$true }
if ($env:PRMPT_YES -eq '1') { $Yes = [switch]$true }

$RepoUrl         = 'https://github.com/senamakel/prmpt.cash.git'
$RepoSlug        = 'senamakel/prmpt.cash'
# The fallback only; normal installs come from a published release.
$ZipUrl          = 'https://codeload.github.com/senamakel/prmpt.cash/zip/refs/heads/main'
$DefaultEndpoint = 'https://api.prmpt.cash/graphql'

if (-not $Endpoint) { $Endpoint = $DefaultEndpoint }
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'prmpt' }

# Where the status line the user already had is recorded, so our renderer can
# run it and uninstall can hand it back. Deliberately not config.json, which is
# rewritten by every code path that touches settings.

function Write-Ok   { param($m) Write-Host "  + $m" -ForegroundColor Green }
function Write-Skip { param($m) Write-Host "  - $m" -ForegroundColor DarkGray }
function Write-Warn { param($m) Write-Host "  ! $m" -ForegroundColor Yellow }
function Die        { param($m) Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- prerequisites
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'Node.js 18+ is required and was not found on PATH.' }
# Parsed from `node -v` rather than `node -p '...split(".")...'`. PowerShell does
# not escape quotes that are INSIDE an argument to a native command, so that
# one-liner reached node as `process.versions.node.split(.)[0]` and threw a
# SyntaxError -- which this script then reported as "Node 18+ required, found
# v20". Every Windows install failed at the version check, on every version of
# Node. Nothing here may pass a quote through to a native command.
$nodeVersion = (& node -v)
if ($nodeVersion -notmatch '^v(\d+)\.') { Die "could not read a version from ``node -v`` ($nodeVersion)." }
$major = [int]$Matches[1]
if ($major -lt 18) { Die "Node 18+ required, found $nodeVersion." }
$NodeBin = $node.Source

# Where each agent keeps its config. Windows uses the same dotted directories
# under the user profile as the POSIX hosts do.
$Home_ = $env:USERPROFILE
if (-not $Home_) { $Home_ = $HOME }
$StateFile = Join-Path $Home_ '.config\prmpt\statusline-chain-claude.json'
if ($Project) {
  $ClaudeCfg = '.\.claude\settings.json'
  $CodexCfg  = '.\.codex\hooks.json'
  $GeminiCfg = '.\.gemini\settings.json'
  $AmpDir    = '.\.amp\plugins'
} else {
  $ClaudeCfg = Join-Path $Home_ '.claude\settings.json'
  $CodexCfg  = Join-Path $Home_ '.codex\hooks.json'
  $GeminiCfg = Join-Path $Home_ '.gemini\settings.json'
  $AmpDir    = Join-Path $env:APPDATA 'amp\plugins'
}

# The node programs are byte-for-byte the ones install.sh uses.
$MergeJs = @'
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
'@

$CleanJs = @'
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
'@

$StatusJs = @'
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
'@

function Invoke-NodeScript {
  param([string] $Script)
  # The program goes through a temp FILE, not through `-e`. PowerShell leaves
  # the double quotes inside an argument unescaped when it hands it to a native
  # program, so `-e $MergeJs` arrived at node with every `"utf8"` collapsed to
  # `utf8`. Passing a path instead means nothing but a path crosses the boundary.
  #
  # The program's inputs arrive in the ENVIRONMENT for the same reason, plus one
  # of its own: PowerShell drops an empty-string argument to a native command,
  # and Claude Code and Codex both pass an empty matcher. On argv that shifted
  # every later value along by one and lost the hook path entirely.
  #
  # Out-Host, not a bare call: in PowerShell any uncaptured output from a
  # function becomes part of its RETURN VALUE, so node printing a line would
  # make this return an array instead of the exit code, and every `-eq 0`
  # check below would silently stop meaning what it says.
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("prmpt-" + [guid]::NewGuid() + ".js")
  try {
    [System.IO.File]::WriteAllText($tmp, $Script)
    & $NodeBin $tmp | Out-Host
    return $LASTEXITCODE
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }
}

# ------------------------------------------------------------------- uninstall
if ($Uninstall) {
  Write-Host 'Removing prmpt' -ForegroundColor White
  foreach ($f in @($ClaudeCfg, $CodexCfg, $GeminiCfg)) {
    if (Test-Path $f) {
      $env:PRMPT_CFG = $f
      $env:PRMPT_STATE = $StateFile
      if ((Invoke-NodeScript -Script $CleanJs) -eq 0) {
        Write-Ok "cleaned $f (backup: $f.bak)"
      }
    }
  }
  foreach ($f in @((Join-Path $AmpDir 'prmpt.ts'))) {
    if (Test-Path $f) { Remove-Item -Force $f; Write-Ok "removed $f" }
  }
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir; Write-Ok "removed $Dir" }
  Write-Host ''
  Write-Host "Your token and wallet key under $env:USERPROFILE\.config\prmpt\ were"
  Write-Host 'both left alone -- on purpose. wallet.json is the only copy of the key,'
  Write-Host 'and removing an ad plugin is not a reason to destroy it. Export it first'
  Write-Host 'if you want it, then delete the directory.'
  Write-Host ''
  Write-Host 'Deleting the token does not revoke it: nothing can, and it stays valid'
  Write-Host 'until it expires.'
  exit 0
}

# ------------------------------------------------------------------ get source
Write-Host 'prmpt.cash' -ForegroundColor White
Write-Host ''

$selfDir = if ($PSScriptRoot) { $PSScriptRoot } else { '' }
if ($selfDir -and (Test-Path (Join-Path $selfDir 'hooks\turn-end.mjs'))) {
  if ($selfDir -ne $Dir) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    foreach ($item in @('bin','hooks','amp','codex','gemini','.claude-plugin','package.json','README.md','install.sh','install.ps1')) {
      $src = Join-Path $selfDir $item
      if (Test-Path $src) { Copy-Item -Recurse -Force $src (Join-Path $Dir $item) }
    }
    Write-Ok "installed from this checkout to $Dir"
  } else {
    Write-Ok "using $Dir"
  }
} else {
  # Normal installs come from a published release, so what lands here is a
  # specific, checksummed version rather than whatever main happened to be.
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("prmpt-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  $api = if ($Version) {
    "https://api.github.com/repos/$RepoSlug/releases/tags/$Version"
  } else {
    "https://api.github.com/repos/$RepoSlug/releases/latest"
  }

  $rel = $null
  try {
    $rel = Invoke-RestMethod -UseBasicParsing -Uri $api -Headers @{
      'User-Agent' = 'prmpt-install'; 'Accept' = 'application/vnd.github+json'
    }
  } catch { $rel = $null }

  $tarAsset  = $null
  $sumsAsset = $null
  if ($rel) {
    $tag     = [string]$rel.tag_name
    $relVer  = $tag -replace '^v', ''
    $assetNm = "prmpt-$relVer.tar.gz"
    $tarAsset  = $rel.assets | Where-Object { $_.name -eq $assetNm }  | Select-Object -First 1
    $sumsAsset = $rel.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
  }

  if ($tarAsset -and $sumsAsset) {
    $tarPath  = Join-Path $tmp $tarAsset.name
    $sumsPath = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri $tarAsset.browser_download_url  -OutFile $tarPath
    Invoke-WebRequest -UseBasicParsing -Uri $sumsAsset.browser_download_url -OutFile $sumsPath

    # Verify before unpacking, never after: an unverified archive must not be
    # written over an install directory.
    $expected = $null
    foreach ($line in (Get-Content $sumsPath)) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and
          [System.IO.Path]::GetFileName($Matches[2]) -eq $tarAsset.name) {
        $expected = $Matches[1].ToLower()
      }
    }
    if (-not $expected) { Die "$($tarAsset.name) is not listed in SHA256SUMS for $tag" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tarPath).Hash.ToLower()
    if ($actual -ne $expected) {
      Die "checksum mismatch for $($tarAsset.name)`n  expected $expected`n  got      $actual"
    }

    # tar.exe has shipped in Windows since build 17063; every supported host has it.
    $unpack = Join-Path $tmp 'unpack'
    New-Item -ItemType Directory -Force -Path $unpack | Out-Null
    & tar xzf $tarPath -C $unpack
    if ($LASTEXITCODE -ne 0) { Die "could not unpack $($tarAsset.name)" }

    $root = $unpack
    if (-not (Test-Path (Join-Path $root 'hooks\turn-end.mjs'))) {
      $inner = Get-ChildItem -Path $unpack -Directory | Select-Object -First 1
      if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName 'hooks\turn-end.mjs'))) {
        Die "$($tarAsset.name) does not contain a plugin"
      }
      $root = $inner.FullName
    }

    if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $root '*') $Dir
    Remove-Item -Recurse -Force $tmp
    Write-Ok "installed $tag to $Dir (sha256 verified)"
  } elseif ($Version) {
    Die "no release $Version with an installable tarball. See https://github.com/$RepoSlug/releases"
  } else {
    # No release yet, or the API is unreachable. Fall back to main so a first
    # install still works before the first tag is cut, and say so plainly.
    Write-Warn 'no published release found; falling back to main (not checksummed)'
    $zip = Join-Path $tmp 'prmpt.zip'
    Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $inner) { Die 'the downloaded archive was empty.' }
    if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $inner.FullName '*') $Dir
    Remove-Item -Recurse -Force $tmp
    Write-Ok "downloaded main to $Dir"
  }
}

$Hook = Join-Path $Dir 'hooks\turn-end.mjs'
if (-not (Test-Path $Hook)) { Die "the hook is missing at $Hook -- the install did not complete." }
# The status-line surface: one hook to fetch a decision when the user presses
# enter, and one command to render it in the footer while the model works.
$PromptHook = Join-Path $Dir 'hooks\prompt-start.mjs'
$StatusHook = Join-Path $Dir 'hooks\statusline.mjs'

# ------------------------------------------------------------------- selection
# The same picker install.sh draws, and under the same rule: it runs ONLY when
# nothing already decided the answer and there is a console to read a key from.
# -Agents, -Yes, PRMPT_YES=1 or a non-interactive host all take the old path.
function Test-HostPresent {
  param([string] $Name)
  switch ($Name) {
    'claude'     { return [bool](Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $Home_ '.claude')) }
    'statusline' { return (Test-HostPresent 'claude') }
    'codex'      { return [bool](Get-Command codex  -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $Home_ '.codex')) }
    'gemini'     { return [bool](Get-Command gemini -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $Home_ '.gemini')) }
    'amp'        { return [bool](Get-Command amp    -ErrorAction SilentlyContinue) -or (Test-Path $AmpDir) }
  }
  return $false
}

# Interactive means: a console we can read a line from, and a user who did not
# already say what they wanted. Host.UI.RawUI is absent under a non-interactive
# runspace, which is what makes this safe in CI.
$interactive = (-not $Yes) -and (-not $Agents) -and $Host.UI -and $Host.UI.RawUI -and -not [Console]::IsInputRedirected

if ($interactive) {
  $rows = @(
    @{ Key='claude';     Label='Claude Code   Stop -- the line at the end of a turn' },
    @{ Key='statusline'; Label='  status line the same ad above your prompt while it thinks' },
    @{ Key='codex';      Label='Codex         Stop -- the line at the end of a turn' },
    @{ Key='gemini';     Label='Gemini CLI    AfterAgent -- the line at the end of a turn' },
    @{ Key='amp';        Label='Amp           agent.end -- unverified against a live install' }
  )
  # Defaults are what an unattended run would have done: every host present,
  # nothing that is not. The status line stays off even with Claude Code -- it
  # costs the user their footer key hints, so it is asked for, never assumed.
  $picked = @{}
  foreach ($r in $rows) { $picked[$r.Key] = (Test-HostPresent $r.Key) }
  $picked['statusline'] = $false

  while ($true) {
    Write-Host ''
    Write-Host 'Where should prmpt install itself?' -ForegroundColor White
    Write-Host ''
    for ($i = 0; $i -lt $rows.Count; $i++) {
      $r = $rows[$i]
      $box = if ($picked[$r.Key]) { '[x]' } else { '[ ]' }
      $note = if (Test-HostPresent $r.Key) { '' } else { '  (not found)' }
      Write-Host ("  {0} {1}. {2}{3}" -f $box, ($i + 1), $r.Label, $note)
    }
    Write-Host ''
    Write-Host '  A status line hides most of Claude Code''s footer key hints, including' -ForegroundColor DarkGray
    Write-Host '  "esc to interrupt". That is Claude Code behaviour, not prmpt''s.' -ForegroundColor DarkGray
    Write-Host ''
    $reply = Read-Host '  Number to toggle, a all, n none, Enter to install, q to quit'
    $reply = ($reply -replace ',', ' ').Trim()
    if ($reply -eq '' -or $reply -match '^(y|yes)$') { break }
    if ($reply -match '^(q|quit)$') { Write-Host ''; Write-Host '  nothing was installed.'; exit 0 }
    if ($reply -match '^(a|all)$')  { foreach ($r in $rows) { $picked[$r.Key] = $true };  continue }
    if ($reply -match '^(n|none)$') { foreach ($r in $rows) { $picked[$r.Key] = $false }; continue }
    foreach ($tok in ($reply -split '\s+')) {
      if ($tok -notmatch '^[0-9]+$') { Write-Warn "not a number: $tok"; continue }
      $n = [int] $tok
      if ($n -lt 1 -or $n -gt $rows.Count) { Write-Warn "no such option: $tok"; continue }
      $k = $rows[$n - 1].Key
      $picked[$k] = -not $picked[$k]
    }
  }

  # The status line is drawn by Claude Code and wired up as part of wiring it.
  # Asking for it alone could only ever do nothing, so it selects the host too.
  if ($picked['statusline'] -and -not $picked['claude']) {
    $picked['claude'] = $true
    Write-Warn 'the status line is drawn by Claude Code -- selecting Claude Code too.'
  }

  $Agents = (@('claude','codex','gemini','amp') | Where-Object { $picked[$_] }) -join ','
  $StatusLine = [switch] $picked['statusline']
  if (-not $Agents) { Die 'nothing selected -- nothing was installed.' }
}

# ------------------------------------------------------------------------ link
Write-Host ''
$cfgFile = Join-Path $Home_ '.config\prmpt\config.json'
$Cli = Join-Path $Dir 'bin\prmpt.mjs'
if (Test-Path $cfgFile) {
  Write-Skip 'already linked'
} elseif ($NoLogin) {
  Write-Warn '-NoLogin: the hook will stay silent until you run'
  Write-Warn "  node $Cli login"
} else {
  # The default: the plugin creates its own Solana wallet and signs the SIWS
  # challenge with it, so there is no browser step. A failure is not fatal --
  # the agents still get wired up, and the hook retries in the background.
  Write-Host 'Creating a wallet and signing in' -ForegroundColor White
  $env:PRMPT_ENDPOINT = $Endpoint
  # --no-onboard: the setup link is minted at the END of this run instead. It
  # is single-use and lives two minutes -- dead long before the user has read
  # past the agent wiring that still has to happen.
  & $NodeBin $Cli login --no-onboard
  if ($LASTEXITCODE -ne 0) {
    Write-Warn 'sign-in failed -- the agents are still being wired up.'
    Write-Warn 'the hook retries in the background, or run it yourself:'
    Write-Warn "  node $Cli login"
  }
}

# ----------------------------------------------------------------- wire agents
# Each host keeps its OWN event and its own timeout unit. These are not
# interchangeable:
#   Claude Code  Stop        timeout SECONDS
#   Codex        Stop        timeout SECONDS
#   Gemini CLI   AfterAgent  timeout MILLISECONDS, and wants a matcher
#   Amp          agent.end   a TypeScript plugin, not a hook at all
#
# Claude Code can have two more, because it is the only host with a status line:
# UserPromptSubmit to fetch, and the statusLine setting to render. Both are
# OPT-IN behind -StatusLine, and gated together -- see install.sh for why.
Write-Host ''
$scope = if ($Project) { 'project' } else { 'user' }
Write-Host "Wiring up agents ($scope scope)" -ForegroundColor White

$wanted = @()
if ($Agents) { $wanted = $Agents.Split(',') | ForEach-Object { $_.Trim().ToLower() } }
function Test-Wanted {
  param([string] $Name, [string] $ProbeCmd, [string] $ProbeDir)
  if ($wanted.Count -gt 0) { return $wanted -contains $Name }
  if (Get-Command $ProbeCmd -ErrorAction SilentlyContinue) { return $true }
  return (Test-Path $ProbeDir)
}

$configured = 0
$targets = @(
  @{ Name='claude'; Label='Claude Code'; Cfg=$ClaudeCfg; Event='Stop';       Timeout=5;    Matcher=''; Probe='claude'; Dir=(Join-Path $Home_ '.claude') },
  @{ Name='codex';  Label='Codex';       Cfg=$CodexCfg;  Event='Stop';       Timeout=5;    Matcher=''; Probe='codex';  Dir=(Join-Path $Home_ '.codex') },
  @{ Name='gemini'; Label='Gemini CLI';  Cfg=$GeminiCfg; Event='AfterAgent'; Timeout=5000; Matcher='*';Probe='gemini'; Dir=(Join-Path $Home_ '.gemini') }
)

foreach ($t in $targets) {
  if (-not (Test-Wanted -Name $t.Name -ProbeCmd $t.Probe -ProbeDir $t.Dir)) {
    Write-Skip "$($t.Label) not found"; continue
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t.Cfg) | Out-Null
  # WriteAllText, not Set-Content -Encoding utf8: on Windows PowerShell 5.1 that
  # switch writes a UTF-8 BOM, and the merge below then refused to touch its own
  # freshly created file ("unparseable JSON, leaving it alone"). A fresh install
  # wired up nothing and still exited 0. This overload writes UTF-8 with no BOM.
  if (-not (Test-Path $t.Cfg)) { [System.IO.File]::WriteAllText($t.Cfg, "{}") }
  $env:PRMPT_CFG     = $t.Cfg
  $env:PRMPT_EVENT   = $t.Event
  $env:PRMPT_TIMEOUT = "$($t.Timeout)"
  $env:PRMPT_MATCHER = $t.Matcher
  $env:PRMPT_HOOK    = $Hook
  $env:PRMPT_BACKUP  = '1'
  $rc = Invoke-NodeScript -Script $MergeJs
  if ($rc -eq 0) {
    Write-Ok "$($t.Label)  $($t.Cfg)  ($($t.Event))"
    $configured++

    # Claude Code only, and only when asked for. Two further passes over the
    # SAME file, so neither takes a backup: the one above already captured what
    # the user actually had, and a second would overwrite it with our own
    # half-finished work.
    if ($t.Name -eq 'claude' -and $StatusLine) {
      $env:PRMPT_EVENT   = 'UserPromptSubmit'
      $env:PRMPT_TIMEOUT = '5'
      $env:PRMPT_MATCHER = ''
      $env:PRMPT_HOOK    = $PromptHook
      $env:PRMPT_BACKUP  = '0'
      if ((Invoke-NodeScript -Script $MergeJs) -eq 0) {
        Write-Ok "             + UserPromptSubmit (fetches the status-line slot)"
      }

      $env:PRMPT_CFG    = $t.Cfg
      $env:PRMPT_HOOK   = $StatusHook
      $env:PRMPT_STATE  = $StateFile
      $env:PRMPT_BACKUP = '0'
      if ((Invoke-NodeScript -Script $StatusJs) -eq 0) {
        if (Test-Path $StateFile) {
          Write-Ok "             + statusLine (wrapping the one you already had)"
        } else {
          Write-Ok "             + statusLine"
        }
      }
    }
  }
}

# Amp: a TypeScript plugin. Unverified against a live Amp install.
if (Test-Wanted -Name 'amp' -ProbeCmd 'amp' -ProbeDir $AmpDir) {
  $ampSrc = Join-Path $Dir 'amp\prmpt.ts'
  if (Test-Path $ampSrc) {
    New-Item -ItemType Directory -Force -Path $AmpDir | Out-Null
    Copy-Item -Force $ampSrc (Join-Path $AmpDir 'prmpt.ts')
    Write-Ok "Amp          $AmpDir\prmpt.ts  (agent.end, unverified)"
    $configured++
  }
} else {
  Write-Skip 'Amp not found'
}

# ----------------------------------------------------------------------- done
Write-Host ''
if ($configured -eq 0) {
  Write-Warn 'no agents were configured.'
  Write-Warn 'pass -Agents claude,codex,gemini,amp to wire one up anyway.'
  exit 1
}
if ($Endpoint -ne $DefaultEndpoint) {
  Write-Host "note endpoint is $Endpoint -- set `$env:PRMPT_ENDPOINT to match." -ForegroundColor Yellow
}

Write-Host "Done. $configured agent(s) configured." -ForegroundColor White
Write-Host ''
Write-Host '  Restart your agent, then just work. Most turns match nothing and print'
Write-Host '  nothing. On a match you get one labelled line; a click pays 70% of the'
Write-Host '  clearing price to your wallet in USDC.'
Write-Host ''
# Mirrors install.sh: finishing setup on the web is part of installing, not a
# second command to remember. It runs here, last, because the code is single-use
# and expires in two minutes. Best effort -- the token is already on disk and
# the hooks are already wired, so a failed round trip must not fail the install.
if ($NoOnboard -or -not (Test-Path $cfgFile)) {
  Write-Host "  Finish setup: node $Cli onboard"
  Write-Host '                Connect a GitHub or X account to lift the daily earnings'
  Write-Host '                cap, and pick which token you are paid in.'
} else {
  Write-Host 'Finishing setup on the web' -ForegroundColor White
  Write-Host '  Connect a GitHub or X account to lift the daily earnings cap, and'
  Write-Host '  pick which token you are paid in.' 
  Write-Host ''
  $env:PRMPT_ENDPOINT = $Endpoint
  & $NodeBin $Cli onboard
  if ($LASTEXITCODE -ne 0) {
    Write-Warn 'could not open the setup page. Run it yourself when you are ready:'
    Write-Warn "  node $Cli onboard"
  }
}
Write-Host ''
if (-not $StatusLine) {
  # Mirrors install.sh: the trade-off is the reason this is off, and somebody
  # deciding to turn it on deserves to know the cost before they do.
  Write-Host '  Not installed: the status line. The same ad can also sit on the row'
  Write-Host '  above your prompt while the model works, refreshed from the prompt you'
  Write-Host '  just typed. It is off because Claude Code hides most of its footer key'
  Write-Host '  hints -- including "esc to interrupt" -- whenever a custom status line'
  Write-Host '  is set. That is Claude Code behaviour, not something prmpt chooses.'
  Write-Host ''
  Write-Host "  Turn it on:   node $Cli statusline install"
  Write-Host "                (or re-run this installer with -StatusLine)"
  Write-Host ''
}
Write-Host "  Turn it off:  `$env:PRMPT_DISABLED = '1'"
Write-Host "  Remove it:    $Dir\install.ps1 -Uninstall"
