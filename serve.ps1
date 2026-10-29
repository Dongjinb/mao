# 喵屋日记 · 本地启动器
# 作用：在 127.0.0.1 上起一个只读小服务，让页面能以 http 方式打开（直接双击 html 时浏览器会禁止联网，云存档用不了）。
# 关闭：关掉这个黑色窗口即可。

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$port  = 8123
$page  = 'meow-diary-standalone.html'
$url   = "http://127.0.0.1:$port/$page"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try { $listener.Start() } catch {
  Write-Host "端口 $port 起不来，可能已经有一个在跑了。" -ForegroundColor Yellow
  Write-Host "直接访问：$url" -ForegroundColor Cyan
  Start-Process $url
  Start-Sleep -Seconds 2
  exit
}

Write-Host ""
Write-Host "  喵屋日记 本地服务已启动" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Cyan
Write-Host "  关掉这个窗口即停止；游戏存档仍然在浏览器本地。" -ForegroundColor DarkGray
Write-Host ""

if ($env:MD_NO_OPEN -ne '1') { Start-Process $url }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }

  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = $page }
    $full = Join-Path $root $rel
    $full = [System.IO.Path]::GetFullPath($full)
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('404')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $res.Headers['Cache-Control'] = 'no-store'
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
