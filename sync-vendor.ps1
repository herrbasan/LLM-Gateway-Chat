# Sync vendored SDKs (nVoice, nSpeech) from upstream GitHub releases or tags.
#
# Usage:
#   .\sync-vendor.ps1                  # Check & sync to latest nVoice SDK release
#   .\sync-vendor.ps1 -CheckOnly       # Only report if an update is available
#   .\sync-vendor.ps1 -Tag sdk-v1.1.0  # Sync specific tag
#
# Wrapper: double-click sync-vendor.cmd

param(
    [string]$Tag = "",
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot

# Deterministic 4-space JSON for the flat string-map manifest (repo/tag/files...).
# Values are strings or one level of nested object, which is all this file holds.
function ConvertTo-VendorJson($obj, [int]$indent = 0) {
    $pad = ' ' * $indent
    $pad2 = ' ' * ($indent + 4)
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        $props = @($obj.PSObject.Properties)
        $out = @('{')
        for ($i = 0; $i -lt $props.Count; $i++) {
            $comma = if ($i -lt $props.Count - 1) { ',' } else { '' }
            $value = ConvertTo-VendorJson $props[$i].Value ($indent + 4)
            $out += "$pad2`"$($props[$i].Name)`": $value$comma"
        }
        $out += "$pad}"
        return ($out -join "`n")
    }
    return "`"$obj`""
}

try {
    $vendorJsonPath = Join-Path $PSScriptRoot "lib\vendor.json"
    if (-not (Test-Path $vendorJsonPath)) {
        throw "Missing lib/vendor.json manifest"
    }

    $vendorConfig = Get-Content $vendorJsonPath -Raw | ConvertFrom-Json
    $currentTag = $vendorConfig.nVoice.tag
    $currentVer = $vendorConfig.nVoice.version
    $repo = $vendorConfig.nVoice.repo
    if (-not $repo) { $repo = "herrbasan/nVoice" }

    Write-Host "Checking upstream releases for $repo (current: $currentTag)..."

    $targetTag = $Tag
    if (-not $targetTag) {
        try {
            $headers = @{ "User-Agent" = "LLM-Gateway-Chat-VendorSync" }
            $apiUrl = "https://api.github.com/repos/$repo/releases"
            $releases = Invoke-RestMethod -Uri $apiUrl -Headers $headers -TimeoutSec 10
            $sdkReleases = @($releases | Where-Object { $_.tag_name -like "sdk-*" })
            if ($sdkReleases.Count -gt 0) {
                $targetTag = $sdkReleases[0].tag_name
            } else {
                $targetTag = $releases[0].tag_name
            }
        } catch {
            Write-Warning "Could not query GitHub Releases API ($($_.Exception.Message)). Falling back to configured tag $currentTag."
            $targetTag = $currentTag
        }
    }

    Write-Host "Target tag: $targetTag"

    if ($CheckOnly) {
        if ($targetTag -ne $currentTag) {
            Write-Host "Update available: $currentTag -> $targetTag" -ForegroundColor Yellow
            exit 1
        } else {
            Write-Host "Vendored SDK is up to date ($currentTag)." -ForegroundColor Green
            exit 0
        }
    }

    $rawBase = "https://raw.githubusercontent.com/$repo/$targetTag"
    $files = $vendorConfig.nVoice.files.PSObject.Properties

    $updatedAny = $false
    foreach ($prop in $files) {
        $srcPath = $prop.Name
        $dstRelPath = $prop.Value
        $dstFullPath = Join-Path $PSScriptRoot $dstRelPath

        $dstDir = Split-Path $dstFullPath -Parent
        if (-not (Test-Path $dstDir)) {
            New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        }

        $url = "$rawBase/$srcPath"
        Write-Host "Fetching $srcPath -> $dstRelPath..."
        
        $tempFile = [System.IO.Path]::GetTempFileName()
        try {
            curl.exe -sSL -f -o $tempFile $url
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe failed downloading $url"
            }

            # Check if file changed
            $hasChanged = $true
            if (Test-Path $dstFullPath) {
                $diff = git diff --no-index --quiet $dstFullPath $tempFile
                if ($LASTEXITCODE -eq 0) {
                    $hasChanged = $false
                }
            }

            if ($hasChanged) {
                Copy-Item $tempFile $dstFullPath -Force
                Write-Host "  Updated $dstRelPath" -ForegroundColor Cyan
                $updatedAny = $true
            } else {
                Write-Host "  Already identical: $dstRelPath" -ForegroundColor DarkGray
            }
        } finally {
            if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
        }
    }

    # Extract version from tag (e.g. sdk-v1.1.0 -> 1.1.0)
    $cleanVer = $targetTag -replace '^sdk-v?', ''
    $vendorConfig.nVoice.tag = $targetTag
    $vendorConfig.nVoice.version = $cleanVer
    $vendorConfig.nVoice.updatedAt = (Get-Date -Format "yyyy-MM-dd")

    # Written with an explicit formatter, NOT ConvertTo-Json: that cmdlet rewrites
    # the whole file in its own style on every run, so a manifest that is only
    # ever touched by hand would show a large spurious diff after each sync.
    $newJson = ConvertTo-VendorJson $vendorConfig
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($vendorJsonPath, $newJson, $utf8NoBom)

    Write-Host ""
    if ($updatedAny) {
        Write-Host "Vendored SDK updated to $targetTag (v$cleanVer)." -ForegroundColor Green
    } else {
        Write-Host "Vendored SDK files already matching $targetTag." -ForegroundColor Green
    }
} finally {
    Pop-Location
}
