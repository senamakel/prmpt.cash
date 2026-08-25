<#
.SYNOPSIS
  prmpt.click -- one installer for every supported coding agent, on Windows.

.DESCRIPTION
  The PowerShell twin of install.sh. Same steps, same on-disk result:

    1. checks Node >= 18            (the hook is plain ESM, no dependencies)
    2. copies the plugin to a stable directory
    3. redeems your install code and stores the token
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

.EXAMPLE
  # Or redeem a dashboard code, keeping the key off this machine entirely.
  .\install.ps1 -Code K3H9F-2QPRS

.EXAMPLE
  # Piping from the web cannot take parameters, so pass the code by
  # environment variable:
  $env:PRMPT_CODE = "K3H9F-2QPRS"; irm https://prmpt.click/install.ps1 | iex

.EXAMPLE
  # Or run it as a scriptblock, which can:
  & ([scriptblock]::Create((irm https://prmpt.click/install.ps1))) -Code K3H9F-2QPRS
#>
[CmdletBinding()]
param(
  [string] $Code     = $env:PRMPT_CODE,
  [switch] $NoLogin,
  [string] $Agents   = $env:PRMPT_AGENTS,
  [string] $Endpoint = $env:PRMPT_ENDPOINT,
  [string] $Dir      = $env:PRMPT_DIR,
  [switch] $Project,
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$RepoUrl         = 'https://github.com/senamakel/prmpt.cash.git'
$ZipUrl          = 'https://codeload.github.com/senamakel/prmpt.cash/zip/refs/heads/main'
$DefaultEndpoint = 'https://api.prmpt.click/graphql'

if (-not $Endpoint) { $Endpoint = $DefaultEndpoint }
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'prmpt' }

function Write-Ok   { param($m) Write-Host "  + $m" -ForegroundColor Green }
function Write-Skip { param($m) Write-Host "  - $m" -ForegroundColor DarkGray }
function Write-Warn { param($m) Write-Host "  ! $m" -ForegroundColor Yellow }
function Die        { param($m) Write-Host "error: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- prerequisites
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die 'Node.js 18+ is required and was not found on PATH.' }
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { Die "Node 18+ required, found $(& node -v)." }
$NodeBin = $node.Source

# Where each agent keeps its config. Windows uses the same dotted directories
# under the user profile as the POSIX hosts do.
$Home_ = $env:USERPROFILE
if (-not $Home_) { $Home_ = $HOME }
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
const [p,event,timeout,matcher,hook]=process.argv.slice(1);
let j={};
const raw = fs.existsSync(p) ? fs.readFileSync(p,"utf8").trim() : "";
if (raw) {
  try { j=JSON.parse(raw); }
  catch (e) { console.error("  unparseable JSON, leaving it alone: "+p); process.exit(3); }
}
if (raw) fs.copyFileSync(p, p+".bak");
j.hooks = j.hooks || {};
const groups = Array.isArray(j.hooks[event]) ? j.hooks[event] : [];
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
'@

$CleanJs = @'
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
'@

function Invoke-NodeScript {
  param([string] $Script, [string[]] $Arguments)
  # -e with the program on argv, so nothing is quoted through cmd.exe.
  #
  # Out-Host, not a bare call: in PowerShell any uncaptured output from a
  # function becomes part of its RETURN VALUE, so node printing a line would
  # make this return an array instead of the exit code, and every `-eq 0`
  # check below would silently stop meaning what it says.
  & $NodeBin -e $Script @Arguments | Out-Host
  return $LASTEXITCODE
}

# ------------------------------------------------------------------- uninstall
if ($Uninstall) {
  Write-Host 'Removing prmpt' -ForegroundColor White
  foreach ($f in @($ClaudeCfg, $CodexCfg, $GeminiCfg)) {
    if (Test-Path $f) {
      if ((Invoke-NodeScript -Script $CleanJs -Arguments @($f)) -eq 0) {
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
Write-Host 'prmpt.click' -ForegroundColor White
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
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $Dir '.git')) {
    & git -C $Dir fetch -q origin main
    & git -C $Dir reset -q --hard origin/main
    Write-Ok "updated $Dir"
  } else {
    if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
    & git clone -q --depth 1 $RepoUrl $Dir
    Write-Ok "cloned to $Dir"
  }
} else {
  # No git: fall back to the zipball.
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("prmpt-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'prmpt.zip'
  Invoke-WebRequest -UseBasicParsing -Uri $ZipUrl -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  if (-not $inner) { Die 'the downloaded archive was empty.' }
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $inner.FullName '*') $Dir
  Remove-Item -Recurse -Force $tmp
  Write-Ok "downloaded to $Dir"
}

$Hook = Join-Path $Dir 'hooks\turn-end.mjs'
if (-not (Test-Path $Hook)) { Die "the hook is missing at $Hook -- the install did not complete." }

# ------------------------------------------------------------------------ link
Write-Host ''
$cfgFile = Join-Path $Home_ '.config\prmpt\config.json'
$Cli = Join-Path $Dir 'bin\prmpt.mjs'
if ($Code) {
  Write-Host 'Linking this install' -ForegroundColor White
  $env:PRMPT_ENDPOINT = $Endpoint
  & $NodeBin $Cli link $Code
  if ($LASTEXITCODE -ne 0) { Die 'linking failed -- nothing was wired up. Fix the above and re-run.' }
} elseif (Test-Path $cfgFile) {
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
  & $NodeBin $Cli login
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
  if (-not (Test-Path $t.Cfg)) { Set-Content -Path $t.Cfg -Value '{}' -Encoding utf8 }
  $rc = Invoke-NodeScript -Script $MergeJs -Arguments @($t.Cfg, $t.Event, "$($t.Timeout)", $t.Matcher, $Hook)
  if ($rc -eq 0) {
    Write-Ok "$($t.Label)  $($t.Cfg)  ($($t.Event))"
    $configured++
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
Write-Host "  Turn it off:  `$env:PRMPT_DISABLED = '1'"
Write-Host "  Remove it:    $Dir\install.ps1 -Uninstall"
