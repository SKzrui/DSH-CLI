# dcli installer — links the `dcli` command and prints quick-start hints.
$ErrorActionPreference = "Stop"

Write-Host "Linking dcli..." -ForegroundColor Cyan
npm link

Write-Host ""
Write-Host "dcli is ready. Quick start:" -ForegroundColor Green
Write-Host "  dcli                          interactive session"
Write-Host "  dcli --help                   usage"
Write-Host "  dcli `"fix the failing test`"  one-shot task"
Write-Host ""
