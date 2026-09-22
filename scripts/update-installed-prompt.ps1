param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$bundleSource = [IO.Path]::GetFullPath((Join-Path $repoRoot 'dist/installed-prompt-fix-20260916'))
$resourcesRoot = 'C:\Program Files\Codex Web GPT\resources'
$target = Join-Path $resourcesRoot 'runtime'
$expectedBundle = '00002a4d1a900a1639f3fbd76820ce4f37b652942241e624b26687184aaa899d'
$previousBundle = '41b9cfe6590f10bea1cba26c193e8212f99f3c33ee1a7a70f78ffb28a028e664'
$bunPath = Join-Path $bundleSource 'runtime\bun.exe'
$validator = Join-Path $PSScriptRoot 'validate-installed-prompt.cjs'

function Assert-Bundle([string]$BundlePath, [string]$BundleId) {
    $manifest = Get-Content -LiteralPath (Join-Path $BundlePath 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.bundleId -ne $BundleId) { throw "Unexpected runtime revision: $BundlePath" }
    & $bunPath $validator $BundlePath $BundleId
    if ($LASTEXITCODE -ne 0) { throw "Runtime integrity check failed: $BundlePath" }
}

Assert-Bundle $bundleSource $expectedBundle
$currentBundle = (Get-Content -LiteralPath (Join-Path $target 'manifest.json') -Raw | ConvertFrom-Json).bundleId
if ($currentBundle -eq $expectedBundle) {
    Assert-Bundle $target $expectedBundle
    Write-Host 'This update is already installed.'
    exit 0
}
Assert-Bundle $target $previousBundle
if ($CheckOnly) {
    Write-Host 'Source and installed runtime verified. No installed files changed.'
    exit 0
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Open PowerShell as administrator and run this script again.'
}
$running = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(Codex Web GPT|Codex|codex|codex-app-server)\.exe$' -or
    ($_.Name -eq 'bun.exe' -and $_.ExecutablePath -like '*\.codex-chatgpt-web\versions\*')
})
if ($running.Count -gt 0) {
    throw 'Exit Codex Web GPT from its tray and fully exit Codex before applying this update. No processes were killed.'
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staged = Join-Path $resourcesRoot "runtime.prompt-update-$stamp"
$backup = Join-Path $resourcesRoot "runtime.before-prompt-update-$stamp"
foreach ($candidate in @($target, $staged, $backup)) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($candidate)) -ne $resourcesRoot) {
        throw "Unexpected update destination: $candidate"
    }
}
if ((Test-Path -LiteralPath $staged) -or (Test-Path -LiteralPath $backup)) {
    throw 'An update with this timestamp already exists; retry later.'
}
Copy-Item -LiteralPath $bundleSource -Destination $staged -Recurse
Assert-Bundle $staged $expectedBundle
Move-Item -LiteralPath $target -Destination $backup
try {
    Move-Item -LiteralPath $staged -Destination $target
    Assert-Bundle $target $expectedBundle
} catch {
    if (Test-Path -LiteralPath $target) {
        Move-Item -LiteralPath $target -Destination (Join-Path $resourcesRoot "runtime.failed-prompt-update-$stamp")
    }
    Move-Item -LiteralPath $backup -Destination $target
    throw
}
Write-Host "Update verified. Backup: $backup"
Write-Host 'Open Codex Web GPT first; it will refresh its per-user runtime from the updated bundle. Then open Codex.'
