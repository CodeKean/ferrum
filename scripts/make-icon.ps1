# Builds web/public/favicon.ico from the same design as web/public/favicon.svg.
#
# Windows shortcuts cannot use an SVG, so the desktop launcher needs a real .ico. Rather than scale
# one large bitmap down — which turns 17px lettering into mush at 16x16 — every size is drawn
# natively at its own resolution, with the type scaled proportionally. The sizes are the ones Windows
# actually asks for: 16 (tray, small list), 32 (desktop at 100%), 48 (desktop at 150%), 64, 128, 256
# (large icons and the alt-tab card).
#
# Run: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1

Add-Type -AssemblyName System.Drawing

$OutFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'web\public\favicon.ico'
$Sizes   = 16, 32, 48, 64, 128, 256

# Literal, exactly as in favicon.svg: an icon has no stylesheet to inherit from.
$Teal  = [System.Drawing.ColorTranslator]::FromHtml('#127C71')
$White = [System.Drawing.Color]::White

function New-RoundedPath([float]$size, [float]$radius) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $p.AddArc(0, 0, $d, $d, 180, 90)
    $p.AddArc($size - $d, 0, $d, $d, 270, 90)
    $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $p.AddArc(0, $size - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-Tile([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    # 5/32 corner radius, the ratio the SVG uses, so every size keeps the same silhouette.
    $path  = New-RoundedPath $size ($size * 5.0 / 32.0)
    $brush = New-Object System.Drawing.SolidBrush($Teal)
    $g.FillPath($brush, $path)

    # The atomic number is dropped below 32px. At 16px it would be two illegible grey pixels that
    # only muddy the "Fe" — an icon that reads at a glance beats one that is faithful and unreadable.
    if ($size -ge 32) {
        $numFont  = New-Object System.Drawing.Font('Consolas', ($size * 8.0 / 32.0), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $numBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(184, 255, 255, 255))
        $g.DrawString('26', $numFont, $numBrush, ($size * 4.0 / 32.0), ($size * 2.0 / 32.0))
        $numFont.Dispose(); $numBrush.Dispose()
    }

    # "Fe", centred horizontally, sitting on the lower half as in the SVG.
    $feSize   = if ($size -ge 32) { $size * 17.0 / 32.0 } else { $size * 20.0 / 32.0 }
    $feFont   = New-Object System.Drawing.Font('Segoe UI Semibold', $feSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $feBrush  = New-Object System.Drawing.SolidBrush($White)
    $fmt      = New-Object System.Drawing.StringFormat
    $fmt.Alignment     = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $box = if ($size -ge 32) {
        New-Object System.Drawing.RectangleF(0, ($size * 6.0 / 32.0), $size, ($size * 26.0 / 32.0))
    } else {
        New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    }
    $g.DrawString('Fe', $feFont, $feBrush, $box, $fmt)

    $feFont.Dispose(); $feBrush.Dispose(); $fmt.Dispose()
    $brush.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

# Each frame is stored as PNG inside the ICO container. Windows has read PNG-in-ICO since Vista, and
# it is the only sane way to carry a 256x256 frame — as an uncompressed BMP that one frame alone
# would be 256KB.
$frames = @()
foreach ($s in $Sizes) {
    $bmp = New-Tile $s
    $ms  = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += [pscustomobject]@{ Size = $s; Bytes = $ms.ToArray() }
    $ms.Dispose(); $bmp.Dispose()
}

$fs = [System.IO.File]::Create($OutFile)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR: reserved, type 1 (icon), image count.
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)

# Directory entries are fixed at 16 bytes, so the first image starts after all of them.
$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
    # 256 is written as 0 — the field is one byte and 256 does not fit.
    $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
    $bw.Write([byte]$dim)          # width
    $bw.Write([byte]$dim)          # height
    $bw.Write([byte]0)             # palette size: 0 for truecolour
    $bw.Write([byte]0)             # reserved
    $bw.Write([uint16]1)           # colour planes
    $bw.Write([uint16]32)          # bits per pixel
    $bw.Write([uint32]$f.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $bw.Write($f.Bytes) }

$bw.Flush(); $bw.Dispose(); $fs.Dispose()

$len = (Get-Item $OutFile).Length
Write-Host "Wrote $OutFile ($len bytes, $($frames.Count) sizes: $($Sizes -join ', '))"
