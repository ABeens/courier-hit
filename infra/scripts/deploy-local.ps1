# Lanza deploy-local.sh desde PowerShell con el bash de Git para Windows.
#
# Por que existe: en PowerShell, `bash` suele resolver a C:\Windows\System32\bash.exe,
# que es el lanzador de WSL. Sin una distribucion de Linux instalada falla con
# "execvpe(/bin/bash) failed: No such file or directory". Este script busca el
# bash de Git y le pasa el mismo argumento.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-local.ps1 all
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-local.ps1 api
#   powershell -ExecutionPolicy Bypass -File .\infra\scripts\deploy-local.ps1 web

param(
  [ValidateSet('all', 'api', 'web', 'seed')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$candidatos = @(
  (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
)
$gitBash = $candidatos | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $gitBash) {
  throw 'No encuentro el bash de Git para Windows. Instala Git (https://git-scm.com) y repite.'
}

Push-Location $repoRoot
try {
  & $gitBash infra/scripts/deploy-local.sh $Target
  if ($LASTEXITCODE -ne 0) { throw "El despliegue termino con codigo $LASTEXITCODE." }
}
finally { Pop-Location }
