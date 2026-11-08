param([string]$Address = 'http://127.0.0.1:4317')
# Jev anywhere: a small tray helper that makes Ctrl+Alt+J open the Jev bar over any app, without the Rex Desk window.
# It starts the Rex Desk server if it is not running, and starts with Windows when that is turned on in Settings.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$local = Join-Path $project '.local'
New-Item -ItemType Directory -Path $local -Force | Out-Null

# One helper per person: a second copy just opens the bar and leaves.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\RexDeskJevAnywhere', [ref]$created)
if ($created) { Set-Content -Path (Join-Path $local 'jev-anywhere.pid') -Value $PID -Encoding ascii -ErrorAction SilentlyContinue }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('RexDesk.JevHotkey' -as [type])) {
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Windows.Forms;
namespace RexDesk {
  public class JevHotkey : Form {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    public event EventHandler Pressed;
    public bool Registered;
    public JevHotkey() { ShowInTaskbar = false; WindowState = FormWindowState.Minimized; FormBorderStyle = FormBorderStyle.FixedToolWindow; Opacity = 0; }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Registered = RegisterHotKey(Handle, 1, 0x0002 | 0x0001 | 0x4000, 0x4A); } // Ctrl+Alt+J, no repeat
    protected override void WndProc(ref Message m) { if (m.Msg == 0x0312 && Pressed != null) Pressed(this, EventArgs.Empty); base.WndProc(ref m); }
    protected override void OnFormClosed(FormClosedEventArgs e) { UnregisterHotKey(Handle, 1); base.OnFormClosed(e); }
    protected override void SetVisibleCore(bool value) { if (!IsHandleCreated) CreateHandle(); base.SetVisibleCore(false); }
  }
  public static class JevWindow {
    delegate bool EnumProc(IntPtr hWnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    public static IntPtr Find(string title) {
      IntPtr found = IntPtr.Zero;
      EnumWindows((h, d) => { if (!IsWindowVisible(h)) return true; var text = new StringBuilder(256); GetWindowText(h, text, 256); if (text.ToString() == title) { found = h; return false; } return true; }, IntPtr.Zero);
      return found;
    }
    public static bool IsForeground(IntPtr hWnd) { return hWnd != IntPtr.Zero && GetForegroundWindow() == hWnd; }
    public static void Close(IntPtr hWnd) { if (hWnd != IntPtr.Zero) PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
  }
}
'@
}

function Test-RexDesk {
    try { return (Invoke-WebRequest -Uri "$Address/api/auth" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}
function Start-RexDesk {
    if (Test-RexDesk) { return $true }
    try { & (Join-Path $project 'Start-RexDesk.ps1') -NoBrowser; return $true } catch { return $false }
}
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

# The bar opens top-center on the screen the mouse is on. Pressing the keys again while it is in front closes it.
function Open-JevBar {
    $open = [RexDesk.JevWindow]::Find('Jev')
    if ($open -ne [IntPtr]::Zero) {
        $wasInFront = [RexDesk.JevWindow]::IsForeground($open)
        [RexDesk.JevWindow]::Close($open)
        if ($wasInFront) { return }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Start-RexDesk)) { $script:tray.ShowBalloonTip(4000, 'Jev', 'Rex Desk did not start. Check .local\server-error.log.', 'Error'); return }
    $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
    $width = 520; $height = 300
    $x = $screen.Left + [int](($screen.Width - $width) / 2); $y = $screen.Top + [int]($screen.Height * 0.12)
    $url = "$Address/jev?listen=1&auto=1"
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList @("--app=$url", "--user-data-dir=$(Join-Path $local 'jev-window')", "--window-size=$width,$height", "--window-position=$x,$y", '--no-first-run', '--no-default-browser-check')
    } else { Start-Process "$Address/jev" }
}

if (-not $created) { Open-JevBar; exit 0 }

$hotkey = New-Object RexDesk.JevHotkey
$tray = New-Object System.Windows.Forms.NotifyIcon
$iconFile = Join-Path $project 'public\favicon.ico'
$tray.Icon = if (Test-Path $iconFile) { New-Object System.Drawing.Icon($iconFile) } else { [System.Drawing.SystemIcons]::Application }
$tray.Text = 'Jev — Ctrl+Alt+J'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Talk to Jev   Ctrl+Alt+J', $null, { Open-JevBar })
[void]$menu.Items.Add('Open Rex Desk', $null, { if (Start-RexDesk) { & (Join-Path $project 'Start-RexDesk.ps1') -App } })
[void]$menu.Items.Add('-')
[void]$menu.Items.Add('Quit Jev anywhere', $null, { $tray.Visible = $false; $hotkey.Close(); [System.Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($sender, $event) if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-JevBar } })
$hotkey.add_Pressed({ Open-JevBar })
$tray.Visible = $true

[void](Start-RexDesk)
$hotkey.Show()
if (-not $hotkey.Registered) { $tray.ShowBalloonTip(6000, 'Jev', 'Another app already uses Ctrl+Alt+J. Click this tray icon to talk to Jev instead.', 'Warning') }
try { [System.Windows.Forms.Application]::Run($hotkey) }
finally { $tray.Visible = $false; $tray.Dispose(); Remove-Item (Join-Path $local 'jev-anywhere.pid') -ErrorAction SilentlyContinue; $mutex.ReleaseMutex() }
