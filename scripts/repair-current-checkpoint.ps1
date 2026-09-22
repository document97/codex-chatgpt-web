$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBun = Join-Path (Split-Path -Parent $taskRoot) 'runtime-benchmark-v5.0.6\runtime\bun.exe'
$taskSession = 'C:\Users\Glimmer\.codex\sessions\2026\09\16\rollout-2026-09-16T01-27-47-01a0a4da-4d75-7021-befb-859f8de0a3a1_01a0a61c-4d00-7813-9271-7d93241a76b6.jsonl'
& $taskBun (Join-Path $PSScriptRoot 'repair-session-checkpoints.ts') --apply $taskSession
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint repair failed. Keep the output for diagnosis.' }
Write-Host 'Checkpoint repair completed. You can now reopen Codex without the Web app.'
