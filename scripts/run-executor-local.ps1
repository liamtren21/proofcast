$ErrorActionPreference = 'Stop'
# Dedicated executor environment only. Never load the owner/deployer key here.
Push-Location (Join-Path $PSScriptRoot '..')
try {
    node apps/worker/src/executor-main.js
    if ($LASTEXITCODE -ne 0) { throw 'ProofCast executor exited unsuccessfully' }
} finally {
    Pop-Location
}
