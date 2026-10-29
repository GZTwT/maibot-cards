# Pack the plugin folder into a zip that can be uploaded to a GitHub Release.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM,
# and a trailing multi-byte char would swallow the next line.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$manifest = Get-Content (Join-Path $root '_manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$zip = Join-Path (Split-Path -Parent $root) "dist\maibot-cards-$($manifest.version).zip"

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $zip) | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

$tmp = Join-Path $env:TEMP "bisca-pack-$([guid]::NewGuid().ToString('N'))"
robocopy $root $tmp /E /XD __pycache__ data /XF config.toml *.pyc | Out-Null
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip
Remove-Item -Recurse -Force $tmp

Write-Host "packed -> $zip"
