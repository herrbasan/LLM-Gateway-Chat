# Sync every submodule to its tracked remote branch tip, then record the bump.
#
# Why this exists: a git submodule pins ONE commit SHA in the parent repo -- that
# is what makes a checkout reproducible, and there is no "track latest" mode in
# git. So when a submodule's upstream moves (e.g. you push nui_wc2 from another
# machine), this repo keeps pointing at the old commit until someone explicitly
# advances it. This script is that explicit action, in one step.
#
# Why fast-forward onto the branch, NOT `git submodule update --remote`: that
# command checks each submodule out at a DETACHED HEAD, which leaves it with no
# branch and no upstream to compare against. VS Code then has nothing to report,
# so you are never told you're on stale code -- and the local branch silently rots
# (lib/nui_wc2's `main` had drifted 28 commits behind before anyone noticed on
# 2026-09-11). Keeping each submodule ON its tracked branch is precisely what
# makes drift visible: VS Code opens detected submodules as their own
# repositories and autofetches them, so the moment a branch tip passes the
# recorded SHA the parent reports the submodule as modified.
#
# Divergence fails loud instead of being papered over: nothing here edits a
# submodule, so local commits or a wrong branch means a human needs to look.
#
# Usage:  .\sync-submodules.ps1
# Agents: run the same steps at session start (see Agents.md, Session Start).

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $names = git config --file .gitmodules --get-regexp '^submodule\..*\.path$' |
        ForEach-Object { ($_ -split ' ')[0] -replace '^submodule\.', '' -replace '\.path$', '' }

    if (-not $names) { throw '.gitmodules declares no submodules' }

    # Only initialize when something is actually missing: bare `submodule update`
    # checks out the recorded SHA and would detach every submodule we just put on
    # its branch. A leading '-' in `submodule status` means not-initialized.
    if (git submodule status | Where-Object { $_ -match '^-' }) {
        Write-Host 'Initializing submodules...'
        git submodule update --init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'git submodule update --init failed' }
    }

    foreach ($name in $names) {
        $path   = git config --file .gitmodules "submodule.$name.path"
        $branch = git config --file .gitmodules "submodule.$name.branch"
        if (-not $path)   { throw "submodule.$name.path is missing from .gitmodules" }
        if (-not $branch) { throw "submodule.$name.branch is missing from .gitmodules - cannot attach $path to a branch" }

        Push-Location $path
        try {
            git fetch origin --quiet --prune
            if ($LASTEXITCODE -ne 0) { throw "git fetch failed in $path" }

            git symbolic-ref --quiet --short HEAD | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "$path is detached - attaching to '$branch'"
                git checkout $branch
                if ($LASTEXITCODE -ne 0) { throw "git checkout $branch failed in $path" }
            } elseif ((git symbolic-ref --short HEAD) -ne $branch) {
                throw "$path is on '$(git symbolic-ref --short HEAD)' but .gitmodules declares '$branch' - resolve manually"
            }

            git merge --ff-only "origin/$branch"
            if ($LASTEXITCODE -ne 0) { throw "$path has diverged from origin/$branch - resolve manually" }
        } finally {
            Pop-Location
        }
    }

    $changed = git status --porcelain -- lib
    if (-not $changed) {
        Write-Host 'All submodules on their tracked branches at the upstream tip.'
        return
    }

    Write-Host "Pointer(s) moved:`n$changed"
    git add lib
    git commit -m 'chore: bump submodules to tracked branch tips' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'commit failed - resolve manually' }

    Write-Host "`nCommitted. Re-run the chat server if a backend-facing lib changed (lib/ndb)."
    git log --oneline -1
} finally {
    Pop-Location
}
