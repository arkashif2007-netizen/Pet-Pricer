Add-Type -AssemblyName System.Drawing

function Resize-Icon([string]$srcPath, [string]$dstPath, [int]$size) {
    $img = [System.Drawing.Image]::FromFile($srcPath)
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    $img.Dispose()
}

$logo = "c:\Users\arbac\Desktop\FreeBuff\assets\logo.jpg"
$base = "c:\Users\arbac\Desktop\FreeBuff\android\app\src\main\res"

Resize-Icon $logo "$base\mipmap-mdpi\ic_launcher.png" 48
Resize-Icon $logo "$base\mipmap-mdpi\ic_launcher_round.png" 48

Resize-Icon $logo "$base\mipmap-hdpi\ic_launcher.png" 72
Resize-Icon $logo "$base\mipmap-hdpi\ic_launcher_round.png" 72

Resize-Icon $logo "$base\mipmap-xhdpi\ic_launcher.png" 96
Resize-Icon $logo "$base\mipmap-xhdpi\ic_launcher_round.png" 96

Resize-Icon $logo "$base\mipmap-xxhdpi\ic_launcher.png" 144
Resize-Icon $logo "$base\mipmap-xxhdpi\ic_launcher_round.png" 144

Resize-Icon $logo "$base\mipmap-xxxhdpi\ic_launcher.png" 192
Resize-Icon $logo "$base\mipmap-xxxhdpi\ic_launcher_round.png" 192

Get-ChildItem "$base\mipmap*" -Filter "*.webp" | Remove-Item -Force
Write-Host "Icons successfully generated and replaced!"
