#requires -Version 5.1
<#
In_Fate Windows integration helper.

Called by tools/install.mjs. It owns the parts that must be native Windows:
desktop/start-menu shortcuts and the HKCU uninstall entry. Every write is
verified by reading it back; a failure exits non-zero and is written to the
ResultPath JSON file so the Node installer can report it instead of guessing.

Actions:
  Preflight  create/delete a temporary shortcut and registry value
  Register   create shortcuts, write uninstall entry, verify everything
  Unregister remove shortcuts/entry that belong to InstallDir
  Verify     read-only check of the current registration
#>
param(
  [ValidateSet('Preflight', 'Register', 'Unregister', 'Verify')]
  [string]$Action = 'Register',
  [string]$InstallDir = '',
  [string]$Version = '0.0.0',
  [string]$Icon = '',
  [string]$RegistryKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\In_Fate',
  [string]$DesktopDir = '',
  [string]$StartMenuDir = '',
  [string]$ResultPath = '',
  [switch]$NoShortcuts,
  [switch]$NoRegistry
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$result = [ordered]@{
  ok = $false
  action = $Action
  installDir = $InstallDir
  registryKey = $RegistryKey
  shortcuts = @()
  removedShortcuts = @()
  registry = $null
  preflight = $null
  errors = @()
  warnings = @()
}

function Write-Result {
  if (-not $ResultPath) { return }
  $parent = Split-Path -Parent $ResultPath
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $json = $result | ConvertTo-Json -Depth 10 -Compress
  [System.IO.File]::WriteAllText(
    $ResultPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Fail([string]$message) {
  $result.errors += $message
  Write-Result
  [Console]::Error.WriteLine($message)
  exit 1
}

function Get-NormalizedPath([string]$path) {
  if (-not $path) { return '' }
  return [System.IO.Path]::GetFullPath($path).TrimEnd('\', '/')
}

function Test-SamePath([string]$left, [string]$right) {
  if (-not $left -or -not $right) { return $false }
  return [string]::Equals(
    (Get-NormalizedPath $left),
    (Get-NormalizedPath $right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Get-ShortcutDirectory([string]$explicit, [string]$kind) {
  if ($explicit) { return $explicit }
  switch ($kind) {
    'desktop' { return [Environment]::GetFolderPath('Desktop') }
    'start-menu' { return [Environment]::GetFolderPath('Programs') }
    default { throw "Unknown shortcut directory kind: $kind" }
  }
}

function Get-WScriptPath {
  $path = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $path)) {
    throw "wscript.exe not found: $path"
  }
  return $path
}

function Get-LauncherInfo {
  $desktopLauncher = Join-Path $script:InstallDirFull 'start-desktop.vbs'
  if (Test-Path -LiteralPath $desktopLauncher) {
    return [ordered]@{
      target = (Get-WScriptPath)
      arguments = '"' + $desktopLauncher + '"'
      launcher = $desktopLauncher
    }
  }
  $browserLauncher = Join-Path $script:InstallDirFull 'start-if.vbs'
  if (Test-Path -LiteralPath $browserLauncher) {
    return [ordered]@{
      target = (Get-WScriptPath)
      arguments = '"' + $browserLauncher + '"'
      launcher = $browserLauncher
    }
  }
  throw "No start-desktop.vbs or start-if.vbs found in $script:InstallDirFull"
}

function Get-IconPath {
  if ($Icon -and (Test-Path -LiteralPath $Icon)) { return $Icon }
  $candidates = @(
    (Join-Path $script:InstallDirFull 'In_Fate\desktop\if-w3.ico'),
    (Join-Path $script:InstallDirFull 'In_Fate\desktop\node_modules\electron\dist\electron.exe'),
    (Join-Path $script:InstallDirFull 'In_Fate\desktop\electron.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return (Get-WScriptPath)
}

function Assert-ShortcutResult($link, $expected, [string]$label) {
  if (-not $link.TargetPath) { throw "$label shortcut has no target" }
  if (-not (Test-SamePath $link.TargetPath $expected.target)) {
    throw "$label shortcut target mismatch: $($link.TargetPath)"
  }
  if ($link.Arguments.IndexOf($expected.launcher, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "$label shortcut arguments do not point at $($expected.launcher)"
  }
}

function Remove-PathQuietly([string]$path) {
  try {
    if ($path -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $result.warnings += "could not remove $path : $($_.Exception.Message)"
  }
}

function Invoke-Preflight {
  $wscript = Get-WScriptPath
  $shell = New-Object -ComObject WScript.Shell
  $probePaths = @()
  $probeKeys = @()
  try {
    if (-not $NoShortcuts) {
      foreach ($entry in @(
        @{ dir = $script:DesktopDirValue; label = 'desktop' },
        @{ dir = $script:StartMenuDirValue; label = 'start-menu' }
      )) {
        $dir = $entry.dir
        if (-not $dir) { throw "shortcut directory is empty: $($entry.label)" }
        if (-not (Test-Path -LiteralPath $dir)) {
          New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $probe = Join-Path $dir ('.if-install-probe-' + [guid]::NewGuid().ToString('N') + '.lnk')
        $probePaths += $probe
        $link = $shell.CreateShortcut($probe)
        $link.TargetPath = $wscript
        $link.WorkingDirectory = $script:InstallDirFull
        $link.Save()
        if (-not (Test-Path -LiteralPath $probe)) {
          throw "could not create a shortcut in $dir"
        }
      }
    }
    if (-not $NoRegistry) {
      $parentKey = Split-Path -Parent $RegistryKey
      if (-not $parentKey) { throw "registry key has no parent: $RegistryKey" }
      $probeKey = Join-Path $parentKey ('__if_install_probe_' + [guid]::NewGuid().ToString('N'))
      $probeKeys += $probeKey
      New-Item -Path $probeKey -Force | Out-Null
      New-ItemProperty -Path $probeKey -Name Probe -Value '1' -PropertyType String -Force | Out-Null
      $value = (Get-ItemProperty -Path $probeKey).Probe
      if ($value -ne '1') { throw "registry write verification failed: $probeKey" }
    }
    $result.preflight = [ordered]@{
      shortcuts = (-not $NoShortcuts)
      registry = (-not $NoRegistry)
      desktopDir = $script:DesktopDirValue
      startMenuDir = $script:StartMenuDirValue
    }
    $result.ok = $true
    Write-Result
    exit 0
  } finally {
    foreach ($path in $probePaths) { Remove-PathQuietly $path }
    foreach ($key in $probeKeys) {
      try { Remove-Item -Path $key -Recurse -Force -ErrorAction Stop } catch { }
    }
  }
}

function Invoke-Register {
  if (-not (Test-Path -LiteralPath $script:InstallDirFull)) {
    throw "install directory does not exist: $script:InstallDirFull"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:InstallDirFull 'uninstall.cmd'))) {
    throw "uninstall.cmd is missing from $script:InstallDirFull"
  }

  $launcher = Get-LauncherInfo
  $iconPath = Get-IconPath
  $shell = New-Object -ComObject WScript.Shell
  $pending = @()
  $created = @()
  $keyExisted = $false

  try {
    if (-not $NoShortcuts) {
      foreach ($entry in @(
        @{ path = (Join-Path $script:DesktopDirValue 'In_Fate.lnk'); label = 'desktop' },
        @{ path = (Join-Path $script:StartMenuDirValue 'In_Fate.lnk'); label = 'start-menu' }
      )) {
        $dir = Split-Path -Parent $entry.path
        if (-not (Test-Path -LiteralPath $dir)) {
          New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $tmp = Join-Path $dir ('.In_Fate-' + [guid]::NewGuid().ToString('N') + '.lnk')
        $link = $shell.CreateShortcut($tmp)
        $link.TargetPath = $launcher.target
        $link.Arguments = $launcher.arguments
        $link.WorkingDirectory = $script:InstallDirFull
        $link.IconLocation = ($iconPath + ',0')
        $link.Description = 'In_Fate'
        $link.WindowStyle = 1
        $link.Save()
        $check = $shell.CreateShortcut($tmp)
        Assert-ShortcutResult $check $launcher $entry.label
        $pending += @{ tmp = $tmp; final = $entry.path; label = $entry.label }
      }
      foreach ($item in $pending) {
        $existed = Test-Path -LiteralPath $item.final
        Move-Item -LiteralPath $item.tmp -Destination $item.final -Force
        $check = $shell.CreateShortcut($item.final)
        Assert-ShortcutResult $check $launcher $item.label
        $created += @{ path = $item.final; existed = $existed; label = $item.label }
        $result.shortcuts += [ordered]@{
          label = $item.label
          path = $item.final
          target = $check.TargetPath
          arguments = $check.Arguments
        }
      }
    }

    if (-not $NoRegistry) {
      $keyExisted = Test-Path -LiteralPath $RegistryKey
      $installRoot = Get-NormalizedPath $script:InstallDirFull
      $uninstall = Join-Path $script:InstallDirFull 'uninstall.cmd'
      $repair = Join-Path $script:InstallDirFull 'repair.cmd'

      $sizeBytes = 0
      foreach ($sub in @('In_Fate', 'runtime', 'tools', 'config')) {
        $path = Join-Path $script:InstallDirFull $sub
        if (Test-Path -LiteralPath $path) {
          try {
            $sum = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
              Measure-Object -Property Length -Sum).Sum
            if ($sum) { $sizeBytes += [int64]$sum }
          } catch { }
        }
      }
      $estimatedKb = [int][math]::Ceiling($sizeBytes / 1KB)

      New-Item -Path $RegistryKey -Force | Out-Null
      $stringValues = [ordered]@{
        DisplayName = 'In_Fate'
        DisplayVersion = $Version
        Publisher = 'Finever'
        InstallLocation = $installRoot
        DisplayIcon = ('"' + $iconPath + '",0')
        UninstallString = ('"' + $uninstall + '" --from-registry')
        QuietUninstallString = ('"' + $uninstall + '" --from-registry --quiet')
        ModifyPath = ('"' + $repair + '"')
        InstallDate = (Get-Date -Format 'yyyyMMdd')
        URLInfoAbout = 'https://github.com/Finever/In_Fate'
      }
      foreach ($name in $stringValues.Keys) {
        New-ItemProperty -Path $RegistryKey -Name $name -Value ([string]$stringValues[$name]) -PropertyType String -Force | Out-Null
      }
      foreach ($entry in @(
        @{ name = 'NoModify'; value = 0 },
        @{ name = 'NoRepair'; value = 1 },
        @{ name = 'EstimatedSize'; value = $estimatedKb }
      )) {
        New-ItemProperty -Path $RegistryKey -Name $entry.name -Value ([int]$entry.value) -PropertyType DWord -Force | Out-Null
      }

      $read = Get-ItemProperty -Path $RegistryKey
      foreach ($name in $stringValues.Keys) {
        if ([string]$read.$name -ne [string]$stringValues[$name]) {
          throw "registry value verification failed: $name"
        }
      }
      if ([int]$read.NoRepair -ne 1) { throw 'registry value verification failed: NoRepair' }
      if ([int]$read.EstimatedSize -ne $estimatedKb) { throw 'registry value verification failed: EstimatedSize' }

      $result.registry = [ordered]@{
        key = $RegistryKey
        displayName = [string]$read.DisplayName
        displayVersion = [string]$read.DisplayVersion
        installLocation = [string]$read.InstallLocation
        uninstallString = [string]$read.UninstallString
        estimatedSizeKb = [int]$read.EstimatedSize
        created = (-not $keyExisted)
      }
    }

    $result.ok = $true
    Write-Result
    exit 0
  } catch {
    foreach ($item in $created) {
      if (-not $item.existed) { Remove-PathQuietly $item.path }
    }
    foreach ($item in $pending) { Remove-PathQuietly $item.tmp }
    if (-not $NoRegistry -and -not $keyExisted -and (Test-Path -LiteralPath $RegistryKey)) {
      Remove-PathQuietly $RegistryKey
    }
    throw
  }
}

function Invoke-Unregister {
  $shell = New-Object -ComObject WScript.Shell
  $removalFailed = $false
  if (-not $NoShortcuts) {
    foreach ($entry in @(
      @{ path = (Join-Path $script:DesktopDirValue 'In_Fate.lnk'); label = 'desktop' },
      @{ path = (Join-Path $script:StartMenuDirValue 'In_Fate.lnk'); label = 'start-menu' }
    )) {
      if (-not (Test-Path -LiteralPath $entry.path)) { continue }
      try {
        $link = $shell.CreateShortcut($entry.path)
        $desktopLauncher = Join-Path $script:InstallDirFull 'start-desktop.vbs'
        $browserLauncher = Join-Path $script:InstallDirFull 'start-if.vbs'
        $targetIsLauncher = (Test-SamePath $link.TargetPath $desktopLauncher) -or (Test-SamePath $link.TargetPath $browserLauncher)
        $argumentsOwned = $link.Arguments.IndexOf($script:InstallDirFull, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        $owned = $targetIsLauncher -or ((Test-SamePath $link.TargetPath (Get-WScriptPath)) -and $argumentsOwned)
        if ($owned) {
          try {
            Remove-Item -LiteralPath $entry.path -Force
          } catch {
            $removalFailed = $true
            $result.warnings += "could not remove shortcut $($entry.path): $($_.Exception.Message)"
            continue
          }
          $result.removedShortcuts += [ordered]@{ label = $entry.label; path = $entry.path }
        } else {
          $result.warnings += "kept shortcut not owned by this install: $($entry.path)"
        }
      } catch {
        $removalFailed = $true
        $result.warnings += "could not inspect shortcut $($entry.path): $($_.Exception.Message)"
      }
    }
  }

  if (-not $NoRegistry -and (Test-Path -LiteralPath $RegistryKey)) {
    try {
      $read = Get-ItemProperty -Path $RegistryKey
      $owned = (-not $read.InstallLocation) -or (Test-SamePath $read.InstallLocation $script:InstallDirFull)
      if ($owned -and [string]$read.DisplayName -eq 'In_Fate') {
        try {
          Remove-Item -LiteralPath $RegistryKey -Recurse -Force
        } catch {
          $removalFailed = $true
          $result.warnings += "could not remove registry entry ${RegistryKey}: $($_.Exception.Message)"
          $read = $null
        }
        if ($read) {
          $result.registry = [ordered]@{ key = $RegistryKey; removed = $true }
        }
      } else {
        $result.warnings += "kept registry entry not owned by this install: $RegistryKey"
      }
    } catch {
      $removalFailed = $true
      $result.warnings += "could not inspect registry entry ${RegistryKey}: $($_.Exception.Message)"
    }
  }

  if ($removalFailed) {
    throw 'failed to remove owned shortcuts or uninstall registry entry'
  }
  $result.ok = $true
  Write-Result
  exit 0
}

function Invoke-Verify {
  $launcher = Get-LauncherInfo
  $shell = New-Object -ComObject WScript.Shell
  foreach ($entry in @(
    @{ path = (Join-Path $script:DesktopDirValue 'In_Fate.lnk'); label = 'desktop' },
    @{ path = (Join-Path $script:StartMenuDirValue 'In_Fate.lnk'); label = 'start-menu' }
  )) {
    if (-not (Test-Path -LiteralPath $entry.path)) {
      throw "$($entry.label) shortcut is missing: $($entry.path)"
    }
    $link = $shell.CreateShortcut($entry.path)
    Assert-ShortcutResult $link $launcher $entry.label
    $result.shortcuts += [ordered]@{ label = $entry.label; path = $entry.path }
  }
  if (-not $NoRegistry) {
    if (-not (Test-Path -LiteralPath $RegistryKey)) {
      throw "uninstall registry entry is missing: $RegistryKey"
    }
    $read = Get-ItemProperty -Path $RegistryKey
    if ([string]$read.DisplayName -ne 'In_Fate') { throw 'uninstall registry entry has the wrong DisplayName' }
    if (-not (Test-SamePath $read.InstallLocation $script:InstallDirFull)) {
      throw 'uninstall registry entry has the wrong InstallLocation'
    }
    $result.registry = [ordered]@{ key = $RegistryKey; displayName = [string]$read.DisplayName }
  }
  $result.ok = $true
  Write-Result
  exit 0
}

try {
  if (-not $InstallDir) { throw 'InstallDir is required' }
  $script:InstallDirFull = Get-NormalizedPath $InstallDir
  $script:DesktopDirValue = Get-ShortcutDirectory $DesktopDir 'desktop'
  $script:StartMenuDirValue = Get-ShortcutDirectory $StartMenuDir 'start-menu'
  $result.installDir = $script:InstallDirFull

  if ($Action -eq 'Preflight') { Invoke-Preflight }
  elseif ($Action -eq 'Register') { Invoke-Register }
  elseif ($Action -eq 'Unregister') { Invoke-Unregister }
  elseif ($Action -eq 'Verify') { Invoke-Verify }
  else { throw "Unknown action: $Action" }
} catch {
  Fail $_.Exception.Message
}
