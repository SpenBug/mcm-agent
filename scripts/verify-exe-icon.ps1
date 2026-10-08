# Verify the icon embedded in the built exe is the CURRENT brand icon.
#
# Why this exists: last round the horse-head path was changed in code but
# build/icon.png was still the old sigma/hexagon, and packaging shipped it
# WITHOUT ANY ERROR -- the installed exe's icon just didn't match the brand.
# icon-check.js only proves build/* matches the shape source; it cannot prove
# what electron-builder actually stamped into the exe. So read it back out.
#
# Method: extract the 32x32 icon from the PE, compare against build/icon.png
# downscaled to 32x32. Rendering paths differ (builder resamples/re-encodes),
# so compare mean pixel difference instead of bytes. The old sigma vs the horse
# head differ far more than the threshold, so they are reliably distinguishable.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/verify-exe-icon.ps1 [-Exe path]
# Exit: 0 match / 1 mismatch / 2 unsupported environment
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes a BOM-less
# .ps1 as the ANSI codepage, so Chinese strings arrive as mojibake and can even
# break the parser (a mangled quote swallows the rest of the line).

param(
  [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'

if ($env:OS -notlike '*Windows*') {
  Write-Host 'SKIP: not Windows, cannot read PE icons'
  exit 2
}

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Host 'SKIP: System.Drawing unavailable'
  exit 2
}

$root = Split-Path -Parent $PSScriptRoot

if (-not $Exe) {
  $found = Get-ChildItem -Path (Join-Path $root 'dist\win-unpacked') -Filter '*.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($found) { $Exe = $found.FullName }
}

if (-not (Test-Path $Exe)) {
  Write-Host "FAIL: exe not found: $Exe (run 'npm run dist' first)"
  exit 1
}

$ref = Join-Path $root 'build\icon.png'
if (-not (Test-Path $ref)) {
  Write-Host "FAIL: reference image missing: $ref (run 'npm run icon' first)"
  exit 1
}

function Get-Argb([System.Drawing.Bitmap]$bmp) {
  $w = $bmp.Width
  $h = $bmp.Height
  $out = New-Object 'int[]' ($w * $h * 4)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $i = ($y * $w + $x) * 4
      $out[$i] = $c.A
      $out[$i + 1] = $c.R
      $out[$i + 2] = $c.G
      $out[$i + 3] = $c.B
    }
  }
  return $out
}

$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
if (-not $icon) {
  Write-Host 'FAIL: no embedded icon in exe'
  exit 1
}

$exeBmp = $icon.ToBitmap()
$size = $exeBmp.Width

$refFull = New-Object System.Drawing.Bitmap((Get-Item $ref).FullName)
$refBmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($refBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($refFull, 0, 0, $size, $size)
$g.Dispose()
$refFull.Dispose()

$a = Get-Argb $exeBmp
$b = Get-Argb $refBmp

$diff = 0
for ($i = 0; $i -lt $a.Length; $i++) { $diff += [math]::Abs($a[$i] - $b[$i]) }
$mad = $diff / $a.Length

$exeBmp.Dispose()
$icon.Dispose()
$refBmp.Dispose()

Write-Host "exe embedded icon : ${size}x${size}"
Write-Host ("mean pixel diff vs build/icon.png : {0:N2}" -f $mad)

if ($mad -lt 24) {
  Write-Host 'OK: exe icon matches the current brand icon'
  exit 0
}

Write-Host 'FAIL: exe icon does NOT match the current brand icon'
Write-Host '  Likely build/icon.ico is stale, or electron-builder used another icon resource.'
Write-Host '  Fix: npm run brand ; npm run icon ; npm run dist'
exit 1
