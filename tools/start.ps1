$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $ProjectRoot
$ElectronExecutable = Join-Path $ProjectRoot 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path -LiteralPath $ElectronExecutable)) {
    $ElectronExecutable = Join-Path $WorkspaceRoot '小鹅通下载器/node_modules/electron/dist/electron.exe'
}
if (-not (Test-Path -LiteralPath $ElectronExecutable)) { throw '缺少 Electron。请在项目目录执行 npm install。' }
& $ElectronExecutable $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw "程序退出码：$LASTEXITCODE" }
