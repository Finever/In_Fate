#requires -Version 5.1
# In_Fate quick-launch shortcut installer for Windows.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install-shortcut.ps1 -Remove
#
# Creates In_Fate.lnk on the Desktop and in the Start Menu.
param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer only supports Windows. Use npm start on macOS/Linux.'
}

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'
$launcher = Join-Path $desktopDir 'launch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$icon = Join-Path $desktopDir 'if.ico'
$shortcutName = 'In_Fate.lnk'

$desktopPath = [Environment]::GetFolderPath('Desktop')
$programsPath = [Environment]::GetFolderPath('Programs')
$targets = @(
  (Join-Path $desktopPath $shortcutName),
  (Join-Path $programsPath $shortcutName)
)

if ($Remove) {
  foreach ($target in $targets) {
    if (Test-Path $target) {
      Remove-Item -LiteralPath $target -Force
      Write-Output "removed: $target"
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $electron)) {
  throw "Cannot find Electron: $electron. Run npm install in desktop first."
}
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Cannot find launcher: $launcher"
}
if (-not (Test-Path -LiteralPath $wscript)) {
  throw "Cannot find wscript.exe: $wscript"
}
if (-not (Test-Path -LiteralPath $icon)) {
  $icon = $electron
}

$shell = New-Object -ComObject WScript.Shell
foreach ($target in $targets) {
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = '"' + $launcher + '"'
  $shortcut.WorkingDirectory = $desktopDir
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Description = 'In_Fate Desktop'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  Write-Output "created: $target"
}
