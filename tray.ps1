<#
  TestTool 托盘启动器

  双击「启动.cmd」会隐藏窗口跑起这个脚本：它在后台拉起 node 服务，
  并在系统托盘放一个图标。右键图标 = 菜单，双击图标 = 打开网页。

  为什么用 PowerShell 而不是 Electron：
  Windows 托盘只需要 WinForms 的 NotifyIcon，而 PowerShell 自带 .NET 运行时，
  零依赖就能做到。为一张托盘图标引入 Electron 要付 200MB 的代价。

  状态变量一律用 $script: 前缀 —— PowerShell 的 .NET 事件回调在自己的
  作用域里执行，不加前缀会读到 $null。
#>

$ErrorActionPreference = 'Stop'

# ── 先把黑框藏掉 ──────────────────────────────────────────
# pwsh.exe 是控制台程序，从快捷方式启动时 Windows 一定会给它建一个控制台窗口。
# 光靠 -WindowStyle Hidden 靠不住 —— 快捷方式自带的窗口样式会盖过它。
# 而那个黑框一旦被用户关掉，就等于杀掉了整个托盘进程（托盘就活在这个进程里），
# 所以这里直接调 Win32 API 把窗口隐藏。
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleHider {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$console = [ConsoleHider]::GetConsoleWindow()
if ($console -ne [IntPtr]::Zero) {
    [void][ConsoleHider]::ShowWindow($console, 0)   # 0 = SW_HIDE
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 单实例：重复双击不再开第二个托盘 ──────────────────────
$mutex = New-Object System.Threading.Mutex($false, 'Global\TestToolTray')
if (-not $mutex.WaitOne(0)) {
    [System.Windows.Forms.MessageBox]::Show(
        'TestTool 已经在运行了，请看右下角托盘图标。',
        'TestTool',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information)
    exit 1
}

# ── 路径与配置 ────────────────────────────────────────────
$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path

$logDir = Join-Path $script:Root 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
# 托盘用自己的日志文件。刻意不共用 service.log —— 那个文件常常被
# service.ps1 或手动启动时的重定向独占着，共用会导致托盘一启动就写日志失败。
$script:Log = Join-Path $logDir 'tray.log'
$script:ServiceLog = Join-Path $logDir 'service.log'

$script:Port = 8787
$envPath = Join-Path $script:Root '.env'
if (Test-Path $envPath) {
    $hit = Select-String -Path $envPath -Pattern '^\s*PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($hit) { $script:Port = [int]$hit.Matches[0].Groups[1].Value }
}

# 手机访问地址可以在 .env 里固定。装了 VPN / 虚拟机 / 代理 TUN 的机器上，
# 自动探测常会挑中那个假地址（日志里就见过 198.18.0.1），固定下来
# 手机收藏的那个链接才不会时好时坏。
$script:LanIp = ''
if (Test-Path $envPath) {
    $hit = Select-String -Path $envPath -Pattern '^\s*LAN_IP\s*=\s*([0-9.]+)' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($hit) { $script:LanIp = $hit.Matches[0].Groups[1].Value.Trim() }
}

# 状态集中放在一个 hashtable 里，而不是散落的 $script: 变量。
#
# 原因是 PowerShell 的坑：.NET 事件回调（Timer.Tick、菜单项 Click）在自己的
# 作用域里执行，直接写 $script:xxx 不保证能被其他回调读到 —— 表现为
# 「端口冲突后本该停止重试，却每 5 秒又试一次，把日志刷满」。
# hashtable 是引用类型，修改它的内容在所有作用域里都可靠可见。
$script:State = @{
    Proc        = $null   # 服务进程
    WantRunning = $false  # 用户意图：true = 应该处于运行状态
}

# ── 函数 ──────────────────────────────────────────────────

function Write-Log {
    param([string]$Message)
    # 写日志失败绝不能拖垮整个托盘 —— 那正是之前「黑框一闪就没了」的原因。
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        "[$stamp] $Message" | Out-File -FilePath $script:Log -Append -Encoding utf8 -ErrorAction Stop
    }
    catch {
        # 日志丢了就丢了，不影响服务
    }
}

function Get-LanIp {
    # .env 里配了 LAN_IP 就固定用它，不再猜网卡顺序
    if ($script:LanIp) { return $script:LanIp }

    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.IPAddress -notlike '198.18.*' -and
            $_.IPAddress -notlike '198.19.*'
        } |
        Select-Object -First 1
    if ($ip) { return $ip.IPAddress }
    return '127.0.0.1'
}

function Get-MobileUrl {
    return "http://$(Get-LanIp):$($script:Port)/"
}

function Test-ServerRunning {
    if ($null -eq $script:State.Proc) { return $false }
    return -not $script:State.Proc.HasExited
}

function Get-PortOwner {
    $conn = Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-OwnServer {
    # 端口占用者是不是我们自己拉起来的 server.ts？
    #
    # 这个判断必须收紧，绝不能变成「谁占着端口就杀谁」—— 那个端口上完全可能
    # 跑着别人的东西。判据是指令行里同时出现本项目的根目录和 server\server.ts，
    # 别的 node 程序不会长成这样。
    param($Proc)
    if (-not $Proc -or -not $Proc.CommandLine) { return $false }
    $line = $Proc.CommandLine
    return ($line -like '*server.ts*' -and $line -like "*$($script:Root)*")
}

function Start-Server {
    if (Test-ServerRunning) { return }

    # 端口预检。否则「启动 → 端口冲突 → node 退出 → 看门狗又拉起」会变成
    # 每 5 秒转一圈的死循环，把日志刷满。
    $owner = Get-PortOwner
    if ($owner) {
        if (Test-OwnServer $owner) {
            # 上一次的托盘是被硬关掉的（不是点「退出」），它拉起来的服务就成了
            # 孤儿一直占着端口 —— 新托盘于是永远拉不动服务，只看得到「端口被占用」。
            # 这里把它认领回来清掉再重开。
            Write-Log "taking over orphaned server (pid $($owner.ProcessId))"
            & taskkill /pid $owner.ProcessId /T /F 2>&1 | Out-Null
            Start-Sleep -Milliseconds 700

            if (Get-PortOwner) {
                Write-Log 'orphaned server did not die, giving up'
                $script:State.WantRunning = $false
                Show-Balloon '端口没释放' "端口 $($script:Port) 上的旧服务杀不掉，可能需要管理员权限。"
                return
            }
        }
        else {
            Write-Log "port $($script:Port) held by unrelated pid $($owner.ProcessId), not starting"
            $script:State.WantRunning = $false
            Show-Balloon '端口被占用' "端口 $($script:Port) 被别的程序占用了（不是 TestTool 自己）。换成 .env 里的 PORT=8788 试试。"
            return
        }
    }

    Write-Log 'starting server'

    # 用 cmd 包一层做重定向。Start-Process 不允许 -RedirectStandardOutput 和
    # -RedirectStandardError 指向同一个文件，而 cmd 的 >> 一条就够。
    $script:State.Proc = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', "node `"$($script:Root)\server\server.ts`" >> `"$($script:Log)`" 2>&1" `
        -WorkingDirectory $script:Root `
        -WindowStyle Hidden `
        -PassThru

    Start-Sleep -Milliseconds 1200

    if (Test-ServerRunning) {
        $script:State.WantRunning = $true
        return
    }

    # 起来就退了，多半是配置问题（比如没填 key 不会导致退出，但语法错误会）
    Write-Log 'server exited right after start'
    $script:State.WantRunning = $false
    Show-Balloon '服务启动失败' '看看日志里写了什么（右键图标 → 打开日志）'
    return
}

function Stop-Server {
    $script:State.WantRunning = $false
    if (-not (Test-ServerRunning)) { return }

    Write-Log 'stopping server'
    # 必须杀整棵进程树：直接杀 cmd 的话 node 会变成孤儿，继续占着端口
    & taskkill /pid $($script:State.Proc.Id) /T /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 400
    $script:State.Proc = $null
}

function Update-Tray {
    if (Test-ServerRunning) {
        $script:Notify.Text = "桌面助手 运行中 · $(Get-MobileUrl)"
        $script:ItemToggle.Text = '停止服务'
    }
    else {
        $script:Notify.Text = '桌面助手 已停止'
        $script:ItemToggle.Text = '启动服务'
    }
}

function Show-Balloon {
    param([string]$Title, [string]$Text)
    $script:Notify.BalloonTipTitle = $Title
    $script:Notify.BalloonTipText = $Text
    $script:Notify.ShowBalloonTip(3000)
}

function Open-Page {
    Start-Process "http://127.0.0.1:$($script:Port)/"
}

function Copy-MobileUrl {
    $url = Get-MobileUrl
    Set-Clipboard -Value $url
    Show-Balloon '手机地址已复制' $url
}

function Open-Log {
    # 优先开服务日志（排查问题主要看它）；被占用打不开就退到托盘日志
    foreach ($file in @($script:ServiceLog, $script:Log)) {
        if (Test-Path $file) {
            Start-Process notepad.exe $file
            return
        }
    }
    Show-Balloon '还没有日志' '服务还没写过任何日志'
}

function Toggle-Server {
    if (Test-ServerRunning) { Stop-Server } else { Start-Server }
    Start-Sleep -Milliseconds 500
    Update-Tray
}

function Restart-Server {
    Stop-Server
    Start-Sleep -Milliseconds 300
    Start-Server
    Start-Sleep -Milliseconds 500
    Update-Tray
    Show-Balloon '服务已重启' (Get-MobileUrl)
}

function Exit-App {
    $script:Timer.Stop()
    Stop-Server
    $script:Notify.Visible = $false
    $script:Notify.Dispose()
    $script:Context.ExitThread()
}

# ── 托盘图标（现画一个，免得依赖外部 ico 文件）────────────

function New-TrayIcon {
    # 优先用项目自带的 testtool.ico —— 和桌面快捷方式是同一个图标
    $ico = Join-Path $script:Root 'testtool.ico'
    if (Test-Path $ico) {
        try { return (New-Object System.Drawing.Icon $ico) } catch { }
    }

    # 没有 ico 文件就现画一个，保证托盘永远有图标
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 76, 141, 255))
    $g.FillEllipse($bg, 1, 1, 30, 30)

    # 中间一块白色小屏幕，示意「截屏」
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White, 2.5)
    $g.DrawRectangle($pen, 9, 10, 14, 10)
    $g.DrawLine($pen, 13, 24, 19, 24)

    $g.Dispose()
    $bg.Dispose()
    $pen.Dispose()

    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Icon = New-TrayIcon
$script:Notify.Visible = $true
$script:Notify.add_MouseDoubleClick({ Open-Page })

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$item = $menu.Items.Add('打开网页')
$item.add_Click({ Open-Page })

$item = $menu.Items.Add('复制手机地址')
$item.add_Click({ Copy-MobileUrl })

$menu.Items.Add('-') | Out-Null

$script:ItemToggle = $menu.Items.Add('停止服务')
$script:ItemToggle.add_Click({ Toggle-Server })

$item = $menu.Items.Add('重启服务')
$item.add_Click({ Restart-Server })

$item = $menu.Items.Add('打开日志')
$item.add_Click({ Open-Log })

$menu.Items.Add('-') | Out-Null

$item = $menu.Items.Add('退出')
$item.add_Click({ Exit-App })

$script:Notify.ContextMenuStrip = $menu

# ── 看门狗：进程意外退出时自动拉起 ────────────────────────

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 5000
$script:Timer.add_Tick({
        if ($script:State.WantRunning -and -not (Test-ServerRunning)) {
            Write-Log 'server died, restarting'
            Start-Server
            Update-Tray
        }
        else {
            Update-Tray
        }
    })
$script:Timer.Start()

# ── 跑起来 ────────────────────────────────────────────────

Start-Server
Start-Sleep -Milliseconds 900
Update-Tray
Show-Balloon 'TestTool 已启动' (Get-MobileUrl)

$script:Context = New-Object System.Windows.Forms.ApplicationContext

try {
    [System.Windows.Forms.Application]::Run($script:Context)
}
finally {
    # 不管怎么退出，都别把 node 留在后台占着端口
    $script:Timer.Stop()
    Stop-Server
    $script:Notify.Visible = $false
    $script:Notify.Dispose()
}
