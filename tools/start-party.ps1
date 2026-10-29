# 群里打牌用：起 cloudflared 快速隧道，把公网地址写进 bisca 数据目录。
# 用法：右键用 PowerShell 运行，或 tools\start-party.cmd。窗口关掉 = 隧道关闭。
param(
  [int]$Port = 18081,
  [string]$UrlFile = 'E:\github\MaiBot\docker-config\bisca-data\public_url.txt'
)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'cloudflared.exe'
if (-not (Test-Path $exe)) { throw "找不到 $exe" }

# 安全前提：bisca 没设密码时谁都算主人，绝不能往公网放。
$code = 0
try {
  $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/cards/api/rooms" -UseBasicParsing -TimeoutSec 5
  $code = 200
} catch {
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
}
if ($code -eq 0) { throw "bisca 没在 127.0.0.1:$Port 上跑，先 docker compose up -d bisca" }
if ($code -eq 200) { throw "bisca 是 open mode（没设 BISCA_PASSWORD），拒绝暴露到公网。先给容器加密码。" }

$log = Join-Path $env:TEMP 'bisca-tunnel.log'
if (Test-Path $log) { Remove-Item $log -Force }
$proc = Start-Process -FilePath $exe -ArgumentList 'tunnel','--url',"http://127.0.0.1:$Port",'--no-autoupdate' `
  -RedirectStandardError $log -RedirectStandardOutput "$log.out" -PassThru -WindowStyle Hidden

$public = ''
try {
  $deadline = (Get-Date).AddSeconds(40)
  while (-not $public -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
      $m = [regex]::Match((Get-Content -Raw $log), 'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($m.Success) { $public = $m.Value }
    }
  }
  if (-not $public) { throw "40 秒没拿到隧道地址，看日志：$log" }

  [IO.File]::WriteAllText($UrlFile, $public, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ""
  Write-Host "隧道已开：$public" -ForegroundColor Green
  Write-Host "地址已写入 $UrlFile，群里发 uno / 炸金花 / 斗地主 就会用这个域名。" -ForegroundColor Green
  Write-Host "关掉这个窗口即断开（地址随即失效）。" -ForegroundColor Yellow
  Write-Host ""
  Wait-Process -Id $proc.Id
}
finally {
  if (Test-Path $UrlFile) { Remove-Item $UrlFile -Force -ErrorAction SilentlyContinue }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "隧道已关闭，public_url.txt 已删除。"
}
