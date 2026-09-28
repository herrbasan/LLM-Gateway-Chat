# Sync the nDB prebuilt binaries from GitHub releases.
#
# Why this exists: nDB publishes its native module (napi .node) and CLI
# (ndb.exe) as GitHub release assets, each with a `.sha256` sidecar. This
# script installs the version pinned in lib/vendor.json's `nDB` entry and
# verifies every artifact against its sidecar BEFORE it reaches the load path
# -- the same guarantee nDB's own napi/vendor.js gives a consumer, but pinned
# to one explicit release instead of "whatever the checkout's package.json
# says". A binary that fails verification is never written.
#
# Relationship to the submodule: lib/ndb is a git submodule whose committed
# prebuilt is the zero-setup path. Running this script at the pinned tag
# installs a byte-identical binary and changes nothing. Running it at a
# DIFFERENT tag (e.g. -Tag v1.4.0, the documented rollback) deliberately
# overrides the submodule's binary; lib/ndb then shows as modified -- that is
# the expected, visible signal of the override. `bin/` is gitignored upstream,
# so the CLI never dirties the submodule.
#
# Every install ends with a real load probe (lib/ndb-load-probe.js): a
# verified binary that the wrapper cannot load, or a wrapper/binary version
# mismatch, fails loudly instead of at first request.
#
# Usage:
#   .\sync-ndb.ps1                 # install the pinned version
#   .\sync-ndb.ps1 -CheckOnly      # report installed vs pinned, change nothing
#   .\sync-ndb.ps1 -Tag v1.4.0     # install a specific release (rollback)
#
# Wrapper: double-click sync-ndb.cmd

param(
    [string]$Tag = '',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Get-Url([string]$Url, [string]$Destination) {
    curl.exe -sSL -f -o $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }
    if (-not (Test-Path -LiteralPath $Destination)) { throw "download produced no file: $Url" }
}

$exitCode = 0
try {
    # The nDB release matrix is Windows x64 only (see nDB AGENTS.md, "Release
    # Path"). Any other platform must build from source -- fail loud rather
    # than install a wrong-arch binary.
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw "nDB prebuilt binaries are win32-x64 only (this process: $env:PROCESSOR_ARCHITECTURE). Build from source: node lib/ndb/napi/setup.js"
    }

    $vendorJsonPath = Join-Path $PSScriptRoot 'lib\vendor.json'
    if (-not (Test-Path -LiteralPath $vendorJsonPath)) { throw 'Missing lib/vendor.json manifest' }

    $entry = (Get-Content -LiteralPath $vendorJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).nDB
    if (-not $entry) { throw "lib/vendor.json has no 'nDB' entry" }
    if (-not $entry.repo) { throw 'nDB.repo is missing from lib/vendor.json' }
    if (-not $entry.tag) { throw 'nDB.tag is missing from lib/vendor.json' }
    if (-not $entry.assets) { throw 'nDB.assets is missing from lib/vendor.json' }

    $pinTag = $entry.tag
    $targetTag = if ($Tag) { $Tag } else { $pinTag }
    if ($targetTag -notmatch '^v') { $targetTag = "v$targetTag" }

    $base = "https://github.com/$($entry.repo)/releases/download/$targetTag"
    Write-Host "nDB vendor: target $targetTag (pin: $pinTag)"

    $plan = @()
    $anyDrift = $false
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ndb-vendor-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    try {
        # Resolve every artifact first: download, verify, compare. Nothing is
        # written to a destination path until all of them have passed.
        foreach ($prop in $entry.assets.PSObject.Properties) {
            $assetName = $prop.Name
            $destRel = $prop.Value
            $destFull = Join-Path $PSScriptRoot $destRel
            $binTmp = Join-Path $tempDir $assetName
            $shaTmp = Join-Path $tempDir "$assetName.sha256"

            Get-Url "$base/$assetName" $binTmp
            Get-Url "$base/$assetName.sha256" $shaTmp

            $expected = ((Get-Content -LiteralPath $shaTmp -Raw -Encoding UTF8) -split '\s+')[0].Trim().ToLower()
            if ($expected -notmatch '^[0-9a-f]{64}$') {
                throw "malformed sha256 sidecar for ${assetName}: '$expected'"
            }

            $actual = Get-Sha256 $binTmp
            if ($actual -ne $expected) {
                throw "SHA-256 mismatch for ${assetName}: release says $expected, downloaded $actual. Refusing to install an unverified binary."
            }

            $installed = $null
            if (Test-Path -LiteralPath $destFull) { $installed = Get-Sha256 $destFull }
            if ($installed -ne $expected) { $anyDrift = $true }

            $plan += [pscustomobject]@{
                Dest      = $destRel
                DestFull  = $destFull
                Source    = $binTmp
                Expected  = $expected
                Installed = $installed
                UpToDate  = ($installed -eq $expected)
            }
        }

        $verb = if ($CheckOnly) { 'DRIFT  ' } else { 'install' }
        foreach ($p in $plan) {
            if ($p.UpToDate) {
                Write-Host ('  up to date   {0}' -f $p.Dest) -ForegroundColor DarkGray
                continue
            }
            $have = if ($p.Installed) { $p.Installed.Substring(0, 12) } else { 'missing' }
            Write-Host ('  {0}   {1}   {2} -> {3}' -f $verb, $p.Dest, $have, $p.Expected.Substring(0, 12)) -ForegroundColor Yellow

            if (-not $CheckOnly) {
                $destDir = Split-Path $p.DestFull -Parent
                if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
                $staged = "$($p.DestFull).download"
                Copy-Item -LiteralPath $p.Source -Destination $staged -Force
                Move-Item -LiteralPath $staged -Destination $p.DestFull -Force
            }
        }

        if ($CheckOnly) {
            if ($anyDrift) {
                Write-Host "nDB binaries differ from $targetTag - run .\sync-ndb.ps1 to install." -ForegroundColor Yellow
                $exitCode = 1
            } else {
                Write-Host "nDB binaries match $targetTag." -ForegroundColor Green
            }
        } else {
            $nodeAsset = $plan | Where-Object { $_.Dest -like '*.node' } | Select-Object -First 1
            if ($nodeAsset) {
                & node (Join-Path $PSScriptRoot 'lib\ndb-load-probe.js') (Split-Path $nodeAsset.DestFull -Parent)
                if ($LASTEXITCODE -ne 0) { throw 'installed nDB binary failed the load probe (see output above)' }
            }
            if ($Tag -and ($targetTag -ne $pinTag)) {
                Write-Host "Override installed. lib/vendor.json still pins $pinTag - edit it to make $targetTag permanent." -ForegroundColor Yellow
            }
            Write-Host "nDB $targetTag in place." -ForegroundColor Green
        }
    } finally {
        if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    }
} finally {
    Pop-Location
}

exit $exitCode
