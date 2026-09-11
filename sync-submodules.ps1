# Sync every submodule to its tracked remote branch tip, then record the bump.
#
# Why this exists: a git submodule pins ONE commit SHA in the parent repo — that
# is what makes a checkout reproducible, and there is no "track latest" mode in
# git. So when a submodule's upstream moves (e.g. you push nui_wc2 from another
# machine), this repo keeps pointing at the old commit until someone explicitly
# advances it. This script is that explicit action, in one step.
#
# Usage:  .\sync-submodules.ps1
# Agents: run the same two steps at session start (see Agents.md § Session Start).

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    Write-Host 'Fetching submodule branch tips...'
    git submodule update --remote
    if ($LASTEXITCODE -ne 0) { throw 'git submodule update --remote failed' }

    $changed = git status --porcelain -- lib
    if (-not $changed) {
        Write-Host 'All submodules already at their tracked branch tips.'
        return
    }

    Write-Host "Pointer(s) moved:`n$changed"
    git add lib
    git commit -m 'chore: bump submodules to tracked branch tips' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'commit failed — resolve manually' }

    Write-Host "`nCommitted. Re-run the chat server if a backend-facing lib changed (lib/ndb)."
    git log --oneline -1
} finally {
    Pop-Location
}
