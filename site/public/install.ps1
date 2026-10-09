# Install the `abject` command, Abject's headless edition, on Windows.
#
#   irm https://abject.world/install.ps1 | iex
#
# Puts each release in %LOCALAPPDATA%\abject\versions\<version>, points the
# junction %LOCALAPPDATA%\abject\current at the one in use (`abject update`
# moves it), and adds %LOCALAPPDATA%\abject\bin to your PATH. No administrator
# rights are needed.
#
#   $env:ABJECT_VERSION = '0.16.0'      install that release instead of the latest
#   $env:ABJECT_INSTALL_DIR = 'D:\x'    install there instead

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'mempko/abject'
$Root = if ($env:ABJECT_INSTALL_DIR) { $env:ABJECT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'abject' }
$Version = $env:ABJECT_VERSION
if (-not $Version) {
  $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'abject-install' }).tag_name
}
$Version = $Version -replace '^v', ''

# One Windows build, x64; Windows on ARM runs it under emulation.
$Name = "abject-$Version-win-x64.zip"
$Url = "https://github.com/$Repo/releases/download/v$Version/$Name"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("abject-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null

try {
  Write-Host "Downloading abject $Version (win-x64)..."
  Invoke-WebRequest $Url -OutFile (Join-Path $Tmp $Name) -UseBasicParsing
  Invoke-WebRequest "$Url.sha256" -OutFile (Join-Path $Tmp "$Name.sha256") -UseBasicParsing

  $Expected = ((Get-Content (Join-Path $Tmp "$Name.sha256") -Raw).Trim() -split '\s+')[0].ToLower()
  $Actual = (Get-FileHash (Join-Path $Tmp $Name) -Algorithm SHA256).Hash.ToLower()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Name (expected $Expected, got $Actual)" }

  Expand-Archive (Join-Path $Tmp $Name) -DestinationPath (Join-Path $Tmp 'x') -Force
  $Inner = Get-ChildItem (Join-Path $Tmp 'x') -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $Inner.FullName 'abject.exe'))) { throw "The archive did not contain abject.exe" }

  $Dest = Join-Path $Root "versions\$Version"
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $Root 'versions') -Force | Out-Null
  Move-Item $Inner.FullName $Dest

  $Current = Join-Path $Root 'current'
  if (Test-Path $Current) { (Get-Item $Current).Delete() }
  New-Item -ItemType Junction -Path $Current -Target $Dest | Out-Null

  $Bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Path $Bin -Force | Out-Null
  Set-Content -Path (Join-Path $Bin 'abject.cmd') -Encoding ASCII -Value "@`"%~dp0..\current\abject.exe`" %*"

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($UserPath -split ';') -contains $Bin)) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($UserPath) { "$UserPath;$Bin" } else { $Bin })), 'User')
    $env:Path = "$env:Path;$Bin"
    Write-Host "Added $Bin to your PATH (new terminals pick it up)."
  }

  Write-Host "Installed abject $Version in $Dest"
  Write-Host ""
  Write-Host "Run: abject"
}
finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
