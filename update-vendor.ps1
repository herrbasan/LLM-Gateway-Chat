#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Update vendor libraries from WebAdmin to ChatStandalone
.DESCRIPTION
    Copies vendor scripts and styles from WebAdmin/public/shared to ChatStandalone/shared
.EXAMPLE
    .\update-vendor.ps1
#>

$ErrorActionPreference = "Stop"

$source = "..\WebAdmin\public\shared"
$dest = ".\shared"

if (!(Test-Path $source)) {
    Write-Error "Source not found: $source"
    Write-Host "Make sure to run this from the ChatStandalone directory"
    exit 1
}

Write-Host "Updating vendor libraries..." -ForegroundColor Cyan
Write-Host "Source: $source" -ForegroundColor Gray
Write-Host "Dest:   $dest" -ForegroundColor Gray
Write-Host ""

# Remove old vendor directory
if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
    Write-Host "Removed old vendor directory" -ForegroundColor Yellow
}

# Copy new files
Copy-Item -Recurse -Force $source $dest
Write-Host "Copied vendor files" -ForegroundColor Green

# Show what was copied
Write-Host ""
Write-Host "Updated files:" -ForegroundColor Cyan
Get-ChildItem $dest -Recurse -File | ForEach-Object {
    $size = if ($_.Length -gt 1MB) { "{0:N1} MB" -f ($_.Length / 1MB) } 
            elseif ($_.Length -gt 1KB) { "{0:N1} KB" -f ($_.Length / 1KB) }
            else { "$($_.Length) B" }
    Write-Host "  $($_.FullName.Replace($PWD.Path, '').TrimStart('\'))" -ForegroundColor Gray -NoNewline
    Write-Host " ($size)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Done! Vendor libraries updated." -ForegroundColor Green
