param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $ProjectRoot
$LocalModules = Join-Path $ProjectRoot 'node_modules'
$SharedModules = Join-Path $WorkspaceRoot '小鹅通下载器/node_modules'
$ModuleRoot = if (Test-Path -LiteralPath (Join-Path $LocalModules 'electron/dist/electron.exe')) { $LocalModules } else { $SharedModules }
$ElectronDist = Join-Path $ModuleRoot 'electron/dist'
$BuilderCli = Join-Path $ModuleRoot 'electron-builder/out/cli/cli.js'
$FfmpegPath = Join-Path $ProjectRoot 'assets/ffmpeg.exe'
$NodeExecutable = (Get-Command node -ErrorAction Stop).Source

foreach ($RequiredPath in @($ElectronDist, $BuilderCli, $FfmpegPath)) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "缺少构建依赖：$RequiredPath。请在本项目执行 npm install，或恢复工作区已有依赖。"
    }
}

$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ExpectedInstaller = Join-Path $ProjectRoot "dist/QlchatDownloader-$($Package.version)-x64-Setup.exe"
$ExpectedPortable = Join-Path $ProjectRoot "dist/QlchatDownloader-$($Package.version)-x64-Portable.exe"
$BuilderCache = Join-Path $WorkspaceRoot '.electron-builder-cache'

if ($CheckOnly) {
    [pscustomobject]@{
        Project = $ProjectRoot
        Electron = $ElectronDist
        Builder = $BuilderCli
        Ffmpeg = $FfmpegPath
        Installer = $ExpectedInstaller
        Portable = $ExpectedPortable
        BuilderCache = $BuilderCache
    } | Format-List
    exit 0
}

$PreviousCache = $env:ELECTRON_BUILDER_CACHE
$PreviousSigning = $env:CSC_IDENTITY_AUTO_DISCOVERY
try {
    $env:ELECTRON_BUILDER_CACHE = $BuilderCache
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    Push-Location -LiteralPath $ProjectRoot
    try {
        & $NodeExecutable $BuilderCli --projectDir $ProjectRoot --win nsis portable --x64 --publish never "--config.electronDist=$ElectronDist" '--config.win.signAndEditExecutable=false'
        if ($LASTEXITCODE -ne 0) { throw "安装包构建失败，退出码 $LASTEXITCODE。" }
    }
    finally { Pop-Location }
}
finally {
    $env:ELECTRON_BUILDER_CACHE = $PreviousCache
    $env:CSC_IDENTITY_AUTO_DISCOVERY = $PreviousSigning
}

if (-not (Test-Path -LiteralPath $ExpectedInstaller)) { throw "构建命令成功，但未找到安装包：$ExpectedInstaller" }
if (-not (Test-Path -LiteralPath $ExpectedPortable)) { throw "构建命令成功，但未找到绿色版：$ExpectedPortable" }
$InstallerInfo = Get-Item -LiteralPath $ExpectedInstaller
$PortableInfo = Get-Item -LiteralPath $ExpectedPortable
if ($InstallerInfo.Length -lt 1MB) { throw '安装包体积异常，请检查构建输出。' }
if ($PortableInfo.Length -lt 1MB) { throw '绿色版体积异常，请检查构建输出。' }
$HashStream = [System.IO.File]::OpenRead($ExpectedInstaller)
$Hasher = [System.Security.Cryptography.SHA256]::Create()
try { $InstallerHash = [System.BitConverter]::ToString($Hasher.ComputeHash($HashStream)).Replace('-', '') }
finally { $HashStream.Dispose(); $Hasher.Dispose() }
[pscustomobject]@{
    Installer = $InstallerInfo.FullName
    SizeMB = [math]::Round($InstallerInfo.Length / 1MB, 1)
    SHA256 = $InstallerHash
    Portable = $PortableInfo.FullName
    PortableSizeMB = [math]::Round($PortableInfo.Length / 1MB, 1)
} | Format-List
