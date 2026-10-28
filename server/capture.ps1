<#
  Screen capture for TestTool.

  Design notes (deliberately ASCII-only - no Chinese literals anywhere in this file,
  so PowerShell output encoding can never corrupt anything we parse):

    * PNG goes to a FILE, never through stdout. stdout carries exactly one ASCII
      line: "META:{...}". Binary data and non-ASCII text never touch the pipe.
    * SetProcessDPIAware() must be called before any coordinate is read, otherwise
      on a scaled display Windows hands back virtualized coordinates and the
      capture is offset/shrunk.
    * window mode prefers PrintWindow(PW_RENDERFULLCONTENT) over CopyFromScreen:
      CopyFromScreen reads the composited screen, so an always-on-top window
      (IME candidate list, toast notification) covering the target would end up
      in the image. PrintWindow asks the window to redraw itself into our bitmap,
      which is occlusion-proof. Some Chromium/UWP windows return success while
      painting pure black, so the result is sampled and we fall back if so.
    * DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS) gives the visible frame.
      Plain GetWindowRect includes ~7px of invisible resize border on Win10+.
#>
param(
    [ValidateSet('full', 'window')]
    [string]$Mode = 'full',

    # "x,y,w,h" in pixels, applied after capture. Empty = no crop.
    [string]$Crop = '',

    # Load assemblies and exit without touching the screen.
    [switch]$WarmUp,

    [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class Cap {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

# Must happen before any coordinate is queried.
[void][Cap]::SetProcessDPIAware()

if ($WarmUp) {
    [Console]::Out.WriteLine('META:{"ok":true,"warmup":true}')
    exit 0
}

if ([string]::IsNullOrWhiteSpace($OutPath)) {
    throw 'OUT_PATH_REQUIRED'
}

# Sample a few pixels to spot a PrintWindow that "succeeded" with a black frame.
function Test-BitmapAllBlack {
    param([System.Drawing.Bitmap]$Bitmap)

    $xs = [int[]]@(10, [int]($Bitmap.Width / 4), [int]($Bitmap.Width / 2), [int]($Bitmap.Width * 3 / 4))
    $ys = [int[]]@(10, [int]($Bitmap.Height / 4), [int]($Bitmap.Height / 2), [int]($Bitmap.Height * 3 / 4))

    foreach ($px in $xs) {
        foreach ($py in $ys) {
            if ($px -lt 0 -or $py -lt 0 -or $px -ge $Bitmap.Width -or $py -ge $Bitmap.Height) { continue }
            $c = $Bitmap.GetPixel($px, $py)
            if ($c.R -ne 0 -or $c.G -ne 0 -or $c.B -ne 0) { return $false }
        }
    }
    return $true
}

$hwnd = [IntPtr]::Zero

if ($Mode -eq 'window') {
    $hwnd = [Cap]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { throw 'NO_FOREGROUND_WINDOW' }

    $r = New-Object Cap+RECT
    $gotRect = $false
    try {
        # DWMWA_EXTENDED_FRAME_BOUNDS = 9
        $gotRect = ([Cap]::DwmGetWindowAttribute($hwnd, 9, [ref]$r, 16) -eq 0)
    } catch {
        $gotRect = $false
    }
    if (-not $gotRect) {
        if (-not [Cap]::GetWindowRect($hwnd, [ref]$r)) { throw 'GET_WINDOW_RECT_FAILED' }
    }

    $x = $r.Left
    $y = $r.Top
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top

    if ($w -le 0 -or $h -le 0 -or $x -le -30000 -or $y -le -30000) {
        throw 'WINDOW_MINIMIZED_OR_INVALID'
    }
}
else {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $vs.X
    $y = $vs.Y
    $w = $vs.Width
    $h = $vs.Height
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$usedPrintWindow = $false

try {
    if ($Mode -eq 'window') {
        $hdc = $g.GetHdc()
        try {
            # PW_RENDERFULLCONTENT = 2
            $usedPrintWindow = [Cap]::PrintWindow($hwnd, $hdc, 2)
        }
        finally {
            $g.ReleaseHdc($hdc)
        }

        if ($usedPrintWindow -and (Test-BitmapAllBlack $bmp)) {
            # Reported success but painted nothing useful.
            $usedPrintWindow = $false
        }
    }

    if (-not $usedPrintWindow) {
        $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    }
}
finally {
    $g.Dispose()
}

if (-not [string]::IsNullOrWhiteSpace($Crop)) {
    $parts = $Crop -split ','
    if ($parts.Count -ne 4) {
        $bmp.Dispose()
        throw 'BAD_CROP_FORMAT'
    }

    $cx = 0; $cy = 0; $cw = 0; $ch = 0
    try {
        $cx = [int]$parts[0]
        $cy = [int]$parts[1]
        $cw = [int]$parts[2]
        $ch = [int]$parts[3]
    }
    catch {
        $bmp.Dispose()
        throw 'BAD_CROP_FORMAT'
    }

    if ($cx -lt 0) { $cx = 0 }
    if ($cy -lt 0) { $cy = 0 }
    if ($cx -ge $bmp.Width) { $cx = $bmp.Width - 1 }
    if ($cy -ge $bmp.Height) { $cy = $bmp.Height - 1 }
    if ($cx + $cw -gt $bmp.Width) { $cw = $bmp.Width - $cx }
    if ($cy + $ch -gt $bmp.Height) { $ch = $bmp.Height - $cy }

    if ($cw -le 0 -or $ch -le 0) {
        $bmp.Dispose()
        throw 'BAD_CROP_RANGE'
    }

    $rect = New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)
    $cropped = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    $bmp = $cropped
}

try {
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $finalW = $bmp.Width
    $finalH = $bmp.Height
}
finally {
    $bmp.Dispose()
}

$meta = @{
    ok          = $true
    mode        = $Mode
    x           = $x
    y           = $y
    w           = $finalW
    h           = $finalH
    printWindow = $usedPrintWindow
    bytes       = (Get-Item $OutPath).Length
}

[Console]::Out.WriteLine('META:' + ($meta | ConvertTo-Json -Compress))
