import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, statfsSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// Computer control: everything Jev, an agent, or the person can ask this computer to do, on Windows and macOS.
// Each action names what it does in plain words (Jev chooses among those words), the values it needs, and whether a
// person confirms it first. Windows work goes to one long-lived PowerShell worker; macOS uses osascript and built-in tools.

const workerPath = fileURLToPath(new URL('../scripts/computer-windows.ps1', import.meta.url));

class WindowsWorker {
  constructor() { this.pending = new Map(); this.next = 1; this.child = null; }
  start() {
    if (this.child) return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    createInterface({ input: child.stdout }).on('line', line => {
      let answer; try { answer = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return; }
      const waiting = this.pending.get(answer.id);
      if (!waiting) return;
      this.pending.delete(answer.id); clearTimeout(waiting.timer);
      if (answer.ok) waiting.resolve(answer.result); else waiting.reject(new Error(answer.error || 'Windows refused the command.'));
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error(`Windows control stopped. ${errors.trim()}`.trim())); }
      this.pending.clear();
    });
    child.on('error', () => {});
    this.child = child;
  }
  call(script, args = {}, timeout = 30000) {
    this.start(); this.rest();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Windows did not answer in time.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, script, args })}\n`);
    });
  }
  // The worker holds about 60 MB, so it closes after ten quiet minutes and starts again on the next command.
  rest() { clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), 10 * 60000); this.idle.unref?.(); }
  stop() { clearTimeout(this.idle); const child = this.child; this.child = null; child?.stdin.end(); child?.kill(); }
}

function run(file, args = [], { timeout = 30000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, maxBuffer: 8 << 20, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim().slice(0, 500))) : resolve(String(stdout).trim()));
    if (input !== undefined) child.stdin.end(input);
  });
}
const osa = script => run('osascript', ['-e', script]);
const jxa = script => run('osascript', ['-l', 'JavaScript', '-e', script]);
const asString = value => JSON.stringify(String(value ?? ''));
// macOS asks for the administrator password in its own dialog; Rex Desk never sees it.
const asAdmin = command => osa(`do shell script ${asString(command)} with administrator privileges`);

export const normalize = value => String(value ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Best fuzzy match of a spoken name against a list: exact, then starts with, then contains, then every word present.
export function bestMatch(wanted, items, name = item => item) {
  const target = normalize(wanted);
  if (!target) return null;
  let best = null, bestScore = 0;
  for (const item of items) {
    const label = normalize(name(item));
    if (!label) continue;
    const score = label === target ? 100 : label.startsWith(target) ? 80 - label.length / 100 : label.includes(target) ? 60 - label.length / 100
      : target.split(' ').every(word => label.includes(word)) ? 45 : target.includes(label) && label.length > 3 ? 30 : 0;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.round(Number(value))));
const yes = value => value === true || /^(true|on|yes|1)$/i.test(String(value));

// Spoken names for settings pages: [Windows ms-settings URI, macOS System Settings pane].
export const settingsPages = {
  home: ['ms-settings:', ''], display: ['ms-settings:display', 'com.apple.Displays-Settings.extension'],
  sound: ['ms-settings:sound', 'com.apple.Sound-Settings.extension'], bluetooth: ['ms-settings:bluetooth', 'com.apple.BluetoothSettings'],
  wifi: ['ms-settings:network-wifi', 'com.apple.wifi-settings-extension'], network: ['ms-settings:network', 'com.apple.Network-Settings.extension'],
  vpn: ['ms-settings:network-vpn', 'com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension'],
  battery: ['ms-settings:batterysaver', 'com.apple.Battery-Settings.extension'], power: ['ms-settings:powersleep', 'com.apple.Battery-Settings.extension'],
  wallpaper: ['ms-settings:personalization-background', 'com.apple.Wallpaper-Settings.extension'], appearance: ['ms-settings:colors', 'com.apple.Appearance-Settings.extension'],
  night_light: ['ms-settings:nightlight', 'com.apple.Displays-Settings.extension'], notifications: ['ms-settings:notifications', 'com.apple.Notifications-Settings.extension'],
  focus: ['ms-settings:quiethours', 'com.apple.Focus-Settings.extension'], camera: ['ms-settings:privacy-webcam', 'com.apple.preference.security?Privacy_Camera'],
  microphone: ['ms-settings:privacy-microphone', 'com.apple.preference.security?Privacy_Microphone'], location: ['ms-settings:privacy-location', 'com.apple.preference.security?Privacy_LocationServices'],
  privacy: ['ms-settings:privacy', 'com.apple.settings.PrivacySecurity.extension'], updates: ['ms-settings:windowsupdate', 'com.apple.Software-Update-Settings.extension'],
  apps: ['ms-settings:appsfeatures', 'com.apple.settings.Storage'], default_apps: ['ms-settings:defaultapps', 'com.apple.Desktop-Settings.extension'],
  startup_apps: ['ms-settings:startupapps', 'com.apple.LoginItems-Settings.extension'], storage: ['ms-settings:storagesense', 'com.apple.settings.Storage'],
  about: ['ms-settings:about', 'com.apple.SystemProfiler.AboutExtension'], accounts: ['ms-settings:yourinfo', 'com.apple.Users-Groups-Settings.extension'],
  sign_in: ['ms-settings:signinoptions', 'com.apple.Touch-ID-Settings.extension'], date_time: ['ms-settings:dateandtime', 'com.apple.Date-Time-Settings.extension'],
  language: ['ms-settings:regionlanguage', 'com.apple.Localization-Settings.extension'], keyboard: ['ms-settings:keyboard', 'com.apple.Keyboard-Settings.extension'],
  mouse: ['ms-settings:mousetouchpad', 'com.apple.Trackpad-Settings.extension'], printers: ['ms-settings:printers', 'com.apple.Print-Scan-Settings.extension'],
  accessibility: ['ms-settings:easeofaccess', 'com.apple.Accessibility-Settings.extension'], taskbar: ['ms-settings:taskbar', 'com.apple.Desktop-Settings.extension'],
};

const knownFolders = { home: '', desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', music: 'Music', videos: process.platform === 'darwin' ? 'Movies' : 'Videos' };

// Windows virtual-key codes and macOS key codes for named keys. Letters and digits are computed.
const winKeys = { enter: 0x0D, return: 0x0D, tab: 0x09, escape: 0x1B, esc: 0x1B, backspace: 0x08, delete: 0x2E, del: 0x2E, space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2D, ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, option: 0x12, win: 0x5B, windows: 0x5B, cmd: 0x5B, command: 0x5B, meta: 0x5B,
  printscreen: 0x2C, capslock: 0x14, volumemute: 0xAD, volumedown: 0xAE, volumeup: 0xAF, next: 0xB0, previous: 0xB1, stop: 0xB2, playpause: 0xB3,
  comma: 0xBC, period: 0xBE, minus: 0xBD, equal: 0xBB, plus: 0xBB, slash: 0xBF, semicolon: 0xBA, quote: 0xDE, bracketleft: 0xDB, bracketright: 0xDD, backslash: 0xDC, backquote: 0xC0 };
const macKeys = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, del: 117, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const macModifiers = { ctrl: 'control down', control: 'control down', shift: 'shift down', alt: 'option down', option: 'option down', cmd: 'command down', command: 'command down', meta: 'command down', win: 'command down', windows: 'command down' };
export function parseKeys(text) {
  const keys = String(text || '').toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (!keys.length || keys.length > 5) throw new Error('Name one to five keys, for example ctrl+c or enter.');
  return keys;
}
function windowsKeyCodes(keys) {
  return keys.map(key => {
    if (winKeys[key] !== undefined) return winKeys[key];
    if (/^f([1-9]|1[0-2])$/.test(key)) return 0x6F + Number(key.slice(1));
    if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
    throw new Error(`Unknown key "${key}".`);
  });
}

// PowerShell snippets for Windows. Each receives one argument, $a, holding the action's values.
const ps = {
  apps: `Get-StartApps | ForEach-Object { [pscustomobject]@{ name = $_.Name; id = $_.AppID } }`,
  launch: `param($a) if ($a.id) { Start-Process explorer.exe ('shell:AppsFolder\\' + $a.id) } else { Start-Process $a.name }; @{ opened = $a.name }`,
  windows: `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; title = $_.MainWindowTitle; processId = $_.Id; handle = [int64]$_.MainWindowHandle } }`,
  focus: `param($a) [RexDesk.Input]::Chord([uint16[]]@(0x12)); [RexDesk.Input]::Focus([IntPtr][int64]$a.handle); @{ focused = $a.title }`,
  close: `param($a) $p = Get-Process -Id $a.processId; if ($a.force) { Stop-Process -Id $a.processId -Force } else { [void]$p.CloseMainWindow() }; @{ closed = $p.ProcessName }`,
  minimizeAll: `(New-Object -ComObject Shell.Application).MinimizeAll(); @{ done = $true }`,
  open: `param($a) Start-Process $a.target; @{ opened = $a.target }`,
  audio: `param($a) if ($null -ne $a.level) { [RexDesk.Audio]::SetVolume($a.flow, [float]($a.level / 100)) }; if ($null -ne $a.mute) { [RexDesk.Audio]::SetMute($a.flow, [bool]$a.mute) }; @{ level = [int][math]::Round([RexDesk.Audio]::GetVolume($a.flow) * 100); muted = [RexDesk.Audio]::GetMute($a.flow) }`,
  keys: `param($a) [RexDesk.Input]::Chord([uint16[]]$a.codes); @{ pressed = $a.label }`,
  type: `param($a) [RexDesk.Input]::Type([string]$a.text); @{ typed = ([string]$a.text).Length }`,
  click: `param($a) [RexDesk.Input]::Click([int]$a.x, [int]$a.y, [string]$a.button, [int]$a.count); @{ clicked = @($a.x, $a.y) }`,
  move: `param($a) [void][RexDesk.Input]::SetCursorPos([int]$a.x, [int]$a.y); @{ moved = @($a.x, $a.y) }`,
  scroll: `param($a) [RexDesk.Input]::Scroll([int]$a.notches, [bool]$a.horizontal); @{ scrolled = $a.notches }`,
  drag: `param($a) [RexDesk.Input]::Drag([int]$a.fromX, [int]$a.fromY, [int]$a.toX, [int]$a.toY); @{ dragged = $true }`,
  screenshot: `param($a)
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($full); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $full.Size); $g.Dispose()
    $scale = [math]::Min(1, $a.maxWidth / $b.Width); $w = [int]($b.Width * $scale); $h = [int]($b.Height * $scale)
    $small = New-Object System.Drawing.Bitmap $full, $w, $h
    $small.Save($a.path, [System.Drawing.Imaging.ImageFormat]::Jpeg); $small.Dispose(); $full.Dispose()
    @{ path = $a.path; width = $w; height = $h; left = $b.Left; top = $b.Top; scale = $scale }`,
  elements: `param($a)
    $UIA = [System.Windows.Automation.AutomationElement]; $Scope = [System.Windows.Automation.TreeScope]; $all = [System.Windows.Automation.Condition]::TrueCondition
    $tops = @($UIA::RootElement.FindAll($Scope::Children, $all))
    $window = $null
    if ($a.window) { $window = $tops | Where-Object { $_.Current.Name -like ('*' + $a.window + '*') } | Select-Object -First 1 }
    if (-not $window) { $front = $UIA::FromHandle([RexDesk.Input]::GetForegroundWindow()); if ($front -and $front.Current.Name -notlike 'Rex Desk*') { $window = $front } }
    if (-not $window) { $window = $tops | Where-Object { $_.Current.Name -and $_.Current.Name -notlike 'Rex Desk*' -and -not $_.Current.IsOffscreen -and $_.Current.Name -ne 'Program Manager' } | Select-Object -First 1 }
    if (-not $window) { throw 'No window is open to look at.' }
    $kinds = 'Button','Hyperlink','MenuItem','ListItem','TabItem','CheckBox','RadioButton','Edit','ComboBox','TreeItem','SplitButton','Slider','DataItem'
    $conditions = [System.Windows.Automation.Condition[]]($kinds | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition ($UIA::ControlTypeProperty), ([System.Windows.Automation.ControlType]::$_) })
    $found = $window.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.OrCondition (,$conditions)))
    $global:rexElements = New-Object System.Collections.ArrayList; $list = New-Object System.Collections.ArrayList
    foreach ($e in $found) {
      if ($list.Count -ge $a.limit) { break }
      $c = $e.Current; if ($c.IsOffscreen -or -not $c.Name) { continue }
      $r = $c.BoundingRectangle; if ($r.Width -le 0 -or $r.Height -le 0) { continue }
      $index = $global:rexElements.Add($e)
      [void]$list.Add([pscustomobject]@{ index = $index; name = $c.Name; type = ($c.ControlType.ProgrammaticName -replace 'ControlType\\.', ''); x = [int]($r.X + $r.Width / 2); y = [int]($r.Y + $r.Height / 2); enabled = $c.IsEnabled })
    }
    @{ window = $window.Current.Name; elements = @($list) }`,
  pressElement: `param($a)
    $e = $global:rexElements[[int]$a.index]; if (-not $e) { throw 'That item is gone. Look at the screen again.' }
    $c = $e.Current; $how = ''
    if ($c.ControlType.ProgrammaticName -eq 'ControlType.Edit') { $e.SetFocus(); $how = 'focus' }
    if (-not $how) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $how = 'invoke' } catch {} }
    if (-not $how) { try { $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $how = 'select' } catch {} }
    if (-not $how) { try { $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $how = 'toggle' } catch {} }
    if (-not $how) { try { $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $how = 'expand' } catch {} }
    if (-not $how) { $r = $c.BoundingRectangle; [RexDesk.Input]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2), 'left', 1); $how = 'click' }
    @{ pressed = $c.Name; how = $how }`,
  brightness: `param($a)
    if ($null -ne $a.level) { Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$a.level } | Out-Null }
    @{ level = [int](Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness }`,
  darkMode: `param($a) $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'; $light = [int](-not [bool]$a.on)
    Set-ItemProperty $key AppsUseLightTheme $light; Set-ItemProperty $key SystemUsesLightTheme $light; @{ dark = [bool]$a.on }`,
  monitorOff: `[RexDesk.Input]::MonitorOff(); @{ done = $true }`,
  consent: `param($a) $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\' + $a.device
    if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
    if ($null -ne $a.on) { Set-ItemProperty $key Value $(if ($a.on) { 'Allow' } else { 'Deny' }) }
    @{ access = (Get-ItemProperty $key).Value }`,
  radio: `param($a)
    [void][Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
    [void](Await-WinRt ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]))
    $radios = Await-WinRt ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $radio = $radios | Where-Object { [string]$_.Kind -eq $a.kind } | Select-Object -First 1
    if (-not $radio) { throw ('This computer has no ' + $a.kind + ' radio.') }
    if ($null -ne $a.on) { $status = Await-WinRt ($radio.SetStateAsync($(if ($a.on) { 'On' } else { 'Off' }))) ([Windows.Devices.Radios.RadioAccessStatus]); if ([string]$status -ne 'Allowed') { throw ('Windows did not allow it: ' + $status) } }
    @{ kind = $a.kind; state = [string]$radio.State }`,
  battery: `$s = [System.Windows.Forms.SystemInformation]::PowerStatus
    $match = @(powercfg /query SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD 2>$null | Select-String '0x([0-9a-fA-F]{8})') | Select-Object -Last 1; $threshold = $(if ($match) { $match.Matches[0].Groups[1].Value } else { '' })
    @{ hasBattery = ([string]$s.BatteryChargeStatus -notmatch 'NoSystemBattery'); percent = [int]($s.BatteryLifePercent * 100); pluggedIn = ([string]$s.PowerLineStatus -eq 'Online'); minutesLeft = $(if ($s.BatteryLifeRemaining -gt 0) { [int]($s.BatteryLifeRemaining / 60) } else { $null }); saverTurnsOnAt = $(if ($threshold) { [Convert]::ToInt32($threshold, 16) } else { $null }) }`,
  saver: `param($a) powercfg /setdcvalueindex SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD $a.threshold 2>$null | Out-Null; if ($LASTEXITCODE) { throw 'no-threshold' }; powercfg /setactive SCHEME_CURRENT | Out-Null; @{ turnsOnAt = $a.threshold }`,
  powerMode: `param($a) if (-not ('RexDesk.Power' -as [type])) { Add-Type -Namespace RexDesk -Name Power -MemberDefinition '[DllImport("powrprof.dll")] public static extern uint PowerSetActiveOverlayScheme(Guid scheme);' }
    $code = [RexDesk.Power]::PowerSetActiveOverlayScheme([Guid]$a.guid); if ($code -ne 0) { throw ('Windows refused the power mode (' + $code + ').') }; @{ mode = $a.mode }`,
  lock: `rundll32.exe user32.dll,LockWorkStation; @{ locked = $true }`,
  suspend: `param($a) [void][System.Windows.Forms.Application]::SetSuspendState($(if ($a.hibernate) { 'Hibernate' } else { 'Suspend' }), $false, $false); @{ done = $true }`,
  wakeTask: `param($a)
    $at = (Get-Date).AddMinutes([double]$a.minutes)
    $settings = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'Rex Desk wake' -Action (New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit') -Trigger (New-ScheduledTaskTrigger -Once -At $at) -Settings $settings -Force | Out-Null
    foreach ($kind in '/setacvalueindex', '/setdcvalueindex') { powercfg $kind SCHEME_CURRENT SUB_SLEEP RTCWAKE 1 2>$null | Out-Null }
    powercfg /setactive SCHEME_CURRENT 2>$null | Out-Null
    @{ wakeAt = $at.ToString('yyyy-MM-dd HH:mm') }`,
  shutdown: `param($a) shutdown.exe $a.flags; if ($LASTEXITCODE) { throw ('Windows refused (' + $LASTEXITCODE + ').') }; @{ done = $true }`,
  processes: `param($a) Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First $a.limit | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; processId = $_.Id; memoryMB = [int]($_.WorkingSet64 / 1MB); cpuSeconds = [int]$_.CPU } }`,
  kill: `param($a) $p = @(Get-Process -Name $a.name -ErrorAction Stop); $p | Stop-Process -Force; @{ stopped = $p.Count }`,
  clipboardRead: `@{ text = [string](Get-Clipboard -Raw) }`,
  clipboardWrite: `param($a) Set-Clipboard -Value ([string]$a.text); @{ copied = ([string]$a.text).Length }`,
  notify: `param($a)
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
    $texts = $xml.GetElementsByTagName('text'); [void]$texts.Item(0).AppendChild($xml.CreateTextNode([string]$a.title)); [void]$texts.Item(1).AppendChild($xml.CreateTextNode([string]$a.message))
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
    @{ shown = $true }`,
  speak: `param($a) if (-not $global:rexVoice) { Add-Type -AssemblyName System.Speech; $global:rexVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer }; $global:rexVoice.SpeakAsyncCancelAll(); [void]$global:rexVoice.SpeakAsync([string]$a.text); @{ speaking = $true }`,
  emptyTrash: `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; @{ emptied = $true }`,
};

// macOS helpers built from osascript (AppleScript and JavaScript for Automation) and the built-in command-line tools.
const mac = {
  apps: async () => {
    const roots = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
    return roots.flatMap(root => { try { return readdirSync(root).filter(name => name.endsWith('.app')).map(name => ({ name: name.slice(0, -4), id: path.join(root, name) })); } catch { return []; } });
  },
  volume: async () => {
    const text = await osa('get volume settings');
    return { level: Number(/output volume:(\d+)/.exec(text)?.[1] ?? 0), muted: /output muted:true/.test(text), input: Number(/input volume:(\d+)/.exec(text)?.[1] ?? 0) };
  },
  // CoreGraphics mouse events. Coordinates are screen points, the same units the screenshot reports after scaling.
  mouse: (x, y, events, clicks = 1) => jxa(`ObjC.import('CoreGraphics');
    const point = $.CGPointMake(${Number(x)}, ${Number(y)});
    for (const [type, button] of ${JSON.stringify(events)}) { const event = $.CGEventCreateMouseEvent(null, type, point, button); $.CGEventSetIntegerValueField(event, 1, ${Number(clicks)}); $.CGEventPost(0, event); delay(0.03); }`),
  keys: async keys => {
    const modifiers = keys.filter(key => macModifiers[key]).map(key => macModifiers[key]);
    const main = keys.filter(key => !macModifiers[key]);
    if (main.length !== 1) throw new Error('Name one main key, for example cmd+c or enter.');
    const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
    const key = main[0];
    const press = macKeys[key] !== undefined ? `key code ${macKeys[key]}` : key.length === 1 ? `keystroke ${asString(key)}` : null;
    if (!press) throw new Error(`Unknown key "${key}".`);
    await osa(`tell application "System Events" to ${press}${using}`);
  },
  wifiDevice: async () => {
    const text = await run('networksetup', ['-listallhardwareports']);
    return /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/.exec(text)?.[1] || 'en0';
  },
};

const known = (value, list, what) => { if (!list.includes(value)) throw new Error(`${what} must be one of: ${list.join(', ')}.`); return value; };
const urlOf = value => {
  const text = String(value || '').trim();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web addresses (http or https) open this way.');
  return new URL(url).href;
};
const folderOf = value => {
  const text = String(value || '').trim();
  const known = knownFolders[normalize(text)];
  if (known !== undefined) return path.join(os.homedir(), known);
  const full = text.replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(full)) throw new Error('Give a full path, or one of: home, desktop, documents, downloads, pictures, music, videos.');
  if (!existsSync(full)) throw new Error(`${full} does not exist.`);
  return full;
};
// Rex Desk's own processes and the ones Windows or macOS needs to keep running.
const protectedProcesses = new Set(['system', 'idle', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'svchost', 'dwm', 'fontdrvhost', 'registry', 'memcompression', 'kernel_task', 'launchd', 'windowserver', 'loginwindow', 'node', 'powershell', 'rex desk', 'rex-desk']);

// The catalog. `does` is what Jev reads when it picks an action, so it says plainly what the action is for.
// `confirm` actions wait for the person to approve unless they turned confirmations off.
export const actions = [
  // Apps, windows, files, and the web
  { id: 'open_app', group: 'Apps & windows', title: 'Open an app', does: 'Open or start an installed application by its name, such as Chrome, Word, Calculator, Spotify, or File Explorer',
    params: { name: { type: 'string', required: true, describe: 'App name as the person said it' } },
    win: async (p, c) => { const app = bestMatch(p.name, await c.apps(), item => item.name); return c.ps(ps.launch, app ? { id: app.id, name: app.name } : { name: p.name }); },
    mac: async (p, c) => { const app = bestMatch(p.name, await c.apps(), item => item.name); if (!app) throw new Error(`No app called ${p.name} is installed.`); await run('open', ['-a', app.id]); return { opened: app.name }; } },
  { id: 'quit_app', group: 'Apps & windows', title: 'Close an app', does: 'Close or quit an open application by its name', confirm: true,
    params: { name: { type: 'string', required: true }, force: { type: 'boolean', describe: 'Stop it even if it has unsaved work' } },
    win: async (p, c) => { const open = bestMatch(p.name, await c.ps(ps.windows), item => `${item.name} ${item.title}`); if (!open) throw new Error(`${p.name} is not open.`); return c.ps(ps.close, { processId: open.processId, force: yes(p.force) }); },
    mac: async (p, c) => { const app = bestMatch(p.name, await c.apps(), item => item.name); if (!app) throw new Error(`No app called ${p.name}.`); await osa(`tell application ${asString(app.name)} to quit`); return { closed: app.name }; } },
  { id: 'list_apps', group: 'Apps & windows', title: 'List installed apps', does: 'List the applications installed on this computer', read: true,
    win: async (p, c) => (await c.apps()).map(app => app.name), mac: async (p, c) => (await c.apps()).map(app => app.name) },
  { id: 'list_windows', group: 'Apps & windows', title: 'List open windows', does: 'List the windows and applications that are open right now', read: true,
    win: async (p, c) => (await c.ps(ps.windows)).map(({ name, title }) => ({ app: name, title })),
    mac: async () => (await osa('tell application "System Events" to get name of every process whose background only is false')).split(', ').map(app => ({ app })) },
  { id: 'focus_window', group: 'Apps & windows', title: 'Switch to a window', does: 'Bring an open application or window to the front so it can be used', params: { name: { type: 'string', required: true } },
    win: async (p, c) => { const open = bestMatch(p.name, await c.ps(ps.windows), item => `${item.name} ${item.title}`); if (!open) throw new Error(`${p.name} is not open.`); return c.ps(ps.focus, open); },
    mac: async (p, c) => { const app = bestMatch(p.name, await c.apps(), item => item.name); if (!app) throw new Error(`No app called ${p.name}.`); await osa(`tell application ${asString(app.name)} to activate`); return { focused: app.name }; } },
  { id: 'show_desktop', group: 'Apps & windows', title: 'Show the desktop', does: 'Minimize every window and show the desktop',
    win: (p, c) => c.ps(ps.minimizeAll), mac: async () => { await osa('tell application "System Events" to set visible of every process whose visible is true and frontmost is false to false'); return { done: true }; } },
  { id: 'open_url', group: 'Apps & windows', title: 'Open a web page', does: 'Open a website or web address in the browser', params: { url: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.open, { target: urlOf(p.url) }), mac: async p => { const url = urlOf(p.url); await run('open', [url]); return { opened: url }; } },
  { id: 'web_search', group: 'Apps & windows', title: 'Search the web', does: 'Search Google for something in the browser', params: { query: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.open, { target: `https://www.google.com/search?q=${encodeURIComponent(p.query)}` }),
    mac: async p => { await run('open', [`https://www.google.com/search?q=${encodeURIComponent(p.query)}`]); return { searched: p.query }; } },
  { id: 'open_folder', group: 'Apps & windows', title: 'Open a folder or file', does: 'Open a folder such as Downloads, Documents, or Desktop, or a file, in File Explorer or Finder',
    params: { path: { type: 'string', required: true, describe: 'home, desktop, documents, downloads, pictures, music, videos, or a full path' } },
    win: (p, c) => c.ps(ps.open, { target: folderOf(p.path) }), mac: async p => { const target = folderOf(p.path); await run('open', [target]); return { opened: target }; } },
  { id: 'open_settings', group: 'Apps & windows', title: 'Open Settings', does: 'Open the system Settings app, or one page of it such as display, sound, Bluetooth, Wi-Fi, battery, privacy, or updates',
    params: { page: { type: 'enum', values: Object.keys(settingsPages), describe: 'Settings page; home for the main page' } },
    win: (p, c) => c.ps(ps.open, { target: (settingsPages[p.page] || settingsPages.home)[0] }),
    mac: async p => { const pane = (settingsPages[p.page] || settingsPages.home)[1]; await run('open', pane ? [`x-apple.systempreferences:${pane}`] : ['-b', 'com.apple.systempreferences']); return { opened: p.page || 'home' }; } },

  // Sound and media
  { id: 'volume_set', group: 'Sound & media', title: 'Set the volume', does: 'Set the speaker volume to a level from 0 to 100 percent', params: { level: { type: 'number', min: 0, max: 100, required: true } },
    win: (p, c) => c.ps(ps.audio, { flow: 0, level: clamp(p.level, 0, 100), mute: clamp(p.level, 0, 100) === 0 }),
    mac: async p => { await osa(`set volume output volume ${clamp(p.level, 0, 100)} without output muted`); return mac.volume(); } },
  { id: 'volume_up', group: 'Sound & media', title: 'Turn the volume up', does: 'Make the sound louder', params: { step: { type: 'number', min: 1, max: 100, describe: 'Percent, 10 if not said' } },
    win: async (p, c) => { const now = await c.ps(ps.audio, { flow: 0 }); return c.ps(ps.audio, { flow: 0, level: clamp(now.level + Number(p.step || 10), 0, 100), mute: false }); },
    mac: async p => { const now = await mac.volume(); await osa(`set volume output volume ${clamp(now.level + Number(p.step || 10), 0, 100)} without output muted`); return mac.volume(); } },
  { id: 'volume_down', group: 'Sound & media', title: 'Turn the volume down', does: 'Make the sound quieter', params: { step: { type: 'number', min: 1, max: 100 } },
    win: async (p, c) => { const now = await c.ps(ps.audio, { flow: 0 }); return c.ps(ps.audio, { flow: 0, level: clamp(now.level - Number(p.step || 10), 0, 100) }); },
    mac: async p => { const now = await mac.volume(); await osa(`set volume output volume ${clamp(now.level - Number(p.step || 10), 0, 100)}`); return mac.volume(); } },
  { id: 'mute', group: 'Sound & media', title: 'Mute the sound', does: 'Turn the sound off, mute the speakers', win: (p, c) => c.ps(ps.audio, { flow: 0, mute: true }), mac: async () => { await osa('set volume with output muted'); return mac.volume(); } },
  { id: 'unmute', group: 'Sound & media', title: 'Unmute the sound', does: 'Turn the sound back on, unmute the speakers', win: (p, c) => c.ps(ps.audio, { flow: 0, mute: false }), mac: async () => { await osa('set volume without output muted'); return mac.volume(); } },
  { id: 'volume_status', group: 'Sound & media', title: 'Check the volume', does: 'Say how loud the sound is and whether it is muted', read: true, win: (p, c) => c.ps(ps.audio, { flow: 0 }), mac: () => mac.volume() },
  { id: 'microphone_mute', group: 'Sound & media', title: 'Mute the microphone', does: 'Turn the microphone off, mute it', win: (p, c) => c.ps(ps.audio, { flow: 1, mute: true }),
    mac: async () => { await osa('set volume input volume 0'); return { microphone: 'muted (input volume 0)' }; } },
  { id: 'microphone_unmute', group: 'Sound & media', title: 'Unmute the microphone', does: 'Turn the microphone back on', win: (p, c) => c.ps(ps.audio, { flow: 1, mute: false }),
    mac: async () => { await osa('set volume input volume 75'); return { microphone: 'on (input volume 75)' }; } },
  { id: 'media', group: 'Sound & media', title: 'Play, pause, or skip media', does: 'Play or pause music or video, or skip to the next or previous track',
    params: { key: { type: 'enum', values: ['play_pause', 'next', 'previous', 'stop'], required: true } },
    win: (p, c) => c.ps(ps.keys, { codes: [{ play_pause: 0xB3, next: 0xB0, previous: 0xB1, stop: 0xB2 }[known(p.key, ['play_pause', 'next', 'previous', 'stop'], 'key')]], label: p.key }),
    mac: async p => { const verb = { play_pause: 'playpause', next: 'next track', previous: 'previous track', stop: 'pause' }[known(p.key, ['play_pause', 'next', 'previous', 'stop'], 'key')];
      const player = (await osa('tell application "System Events" to (name of processes) contains "Spotify"')) === 'true' ? 'Spotify' : 'Music';
      await osa(`tell application ${asString(player)} to ${verb}`); return { player, did: p.key }; } },
  { id: 'speak', group: 'Sound & media', title: 'Say something aloud', does: 'Read a sentence out loud with the computer voice', params: { text: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.speak, { text: String(p.text).slice(0, 2000) }), mac: async p => { spawn('say', [String(p.text).slice(0, 2000)], { detached: true, stdio: 'ignore' }).unref(); return { speaking: true }; } },

  // Screen
  { id: 'brightness_set', group: 'Screen', title: 'Set screen brightness', does: 'Make the screen brighter or dimmer, set brightness from 0 to 100 percent', params: { level: { type: 'number', min: 0, max: 100, required: true } },
    win: (p, c) => c.ps(ps.brightness, { level: clamp(p.level, 0, 100) }).catch(error => { throw new Error(`Brightness works only on a laptop's built-in screen (${error.message}).`); }),
    // macOS has no brightness command; the brightness keys step it in sixteenths.
    mac: async p => { const steps = Math.round(clamp(p.level, 0, 100) / 6.25); await osa(`tell application "System Events"\nrepeat 16 times\nkey code 145\nend repeat\nrepeat ${steps} times\nkey code 144\nend repeat\nend tell`); return { level: steps * 6.25 }; } },
  { id: 'dark_mode', group: 'Screen', title: 'Dark or light mode', does: 'Switch the computer to dark mode or to light mode', params: { on: { type: 'boolean', required: true, describe: 'true for dark mode' } },
    win: (p, c) => c.ps(ps.darkMode, { on: yes(p.on) }), mac: async p => { await osa(`tell application "System Events" to tell appearance preferences to set dark mode to ${yes(p.on)}`); return { dark: yes(p.on) }; } },
  { id: 'screen_off', group: 'Screen', title: 'Turn the screen off', does: 'Turn off the display without sleeping; moving the mouse turns it back on',
    win: (p, c) => c.ps(ps.monitorOff), mac: async () => { await run('pmset', ['displaysleepnow']); return { done: true }; } },
  { id: 'screenshot', group: 'Screen', title: 'Take a screenshot', does: 'Take a picture of the whole screen', read: true,
    win: (p, c) => c.screenshot(), mac: (p, c) => c.screenshot() },

  // Mouse, keyboard, and what is on screen
  { id: 'screen_items', group: 'Mouse & keyboard', title: 'Read the screen', does: 'List the buttons, links, menus, tabs, and fields in the window in front, to find something to click', read: true,
    params: { window: { type: 'string', describe: 'Part of the window title; the front window if empty' } },
    win: (p, c) => c.elements(p.window), mac: (p, c) => c.elements(p.window) },
  { id: 'click_item', group: 'Mouse & keyboard', title: 'Click a button or link by name', does: 'Click, press, select, or tick a button, link, menu, tab, checkbox, or field on screen by the words written on it',
    params: { name: { type: 'string', describe: 'Words on the item' }, index: { type: 'number', describe: 'Item number from Read the screen' }, window: { type: 'string' } },
    win: (p, c) => c.pressItem(p), mac: (p, c) => c.pressItem(p) },
  { id: 'click', group: 'Mouse & keyboard', title: 'Click at a position', does: 'Click the mouse at a screen position',
    params: { x: { type: 'number', required: true }, y: { type: 'number', required: true }, button: { type: 'enum', values: ['left', 'right', 'middle'] }, count: { type: 'number', min: 1, max: 3, describe: '2 for a double-click' } },
    win: (p, c) => c.ps(ps.click, { x: Math.round(p.x), y: Math.round(p.y), button: p.button || 'left', count: clamp(p.count || 1, 1, 3) }),
    mac: async p => { const button = p.button || 'left', events = { left: [[1, 0], [2, 0]], right: [[3, 1], [4, 1]], middle: [[25, 2], [26, 2]] }[button];
      for (let index = 1; index <= clamp(p.count || 1, 1, 3); index++) await mac.mouse(p.x, p.y, events, index); return { clicked: [p.x, p.y] }; } },
  { id: 'move_mouse', group: 'Mouse & keyboard', title: 'Move the mouse', does: 'Move the mouse pointer to a screen position', params: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
    win: (p, c) => c.ps(ps.move, { x: Math.round(p.x), y: Math.round(p.y) }), mac: async p => { await mac.mouse(p.x, p.y, [[5, 0]]); return { moved: [p.x, p.y] }; } },
  { id: 'scroll', group: 'Mouse & keyboard', title: 'Scroll', does: 'Scroll the page or window up or down', params: { direction: { type: 'enum', values: ['up', 'down', 'left', 'right'], required: true }, amount: { type: 'number', min: 1, max: 50, describe: 'Notches, 5 if not said' } },
    win: (p, c) => { const amount = clamp(p.amount || 5, 1, 50); return c.ps(ps.scroll, { notches: ['down', 'left'].includes(p.direction) ? -amount : amount, horizontal: ['left', 'right'].includes(p.direction) }); },
    mac: async p => { const key = { up: 'pageup', down: 'pagedown', left: 'left', right: 'right' }[p.direction]; for (let index = 0; index < Math.ceil(clamp(p.amount || 5, 1, 50) / 5); index++) await mac.keys([key]); return { scrolled: p.direction }; } },
  { id: 'drag', group: 'Mouse & keyboard', title: 'Drag', does: 'Drag with the mouse from one screen position to another',
    params: { fromX: { type: 'number', required: true }, fromY: { type: 'number', required: true }, toX: { type: 'number', required: true }, toY: { type: 'number', required: true } },
    win: (p, c) => c.ps(ps.drag, { fromX: p.fromX, fromY: p.fromY, toX: p.toX, toY: p.toY }),
    mac: async p => { await mac.mouse(p.fromX, p.fromY, [[1, 0]]); await mac.mouse(p.toX, p.toY, [[6, 0]]); await mac.mouse(p.toX, p.toY, [[2, 0]]); return { dragged: true }; } },
  { id: 'type_text', group: 'Mouse & keyboard', title: 'Type text', does: 'Type words or sentences with the keyboard into the box that has focus, in any language', params: { text: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.type, { text: String(p.text).slice(0, 5000) }),
    // System Events cannot type Khmer or Korean, so text goes through the clipboard and a paste.
    mac: async p => { await run('pbcopy', [], { input: String(p.text).slice(0, 5000) }); await osa('tell application "System Events" to keystroke "v" using {command down}'); return { typed: String(p.text).length }; } },
  { id: 'press_keys', group: 'Mouse & keyboard', title: 'Press keys', does: 'Press a key or a keyboard shortcut, such as enter, escape, ctrl+c, ctrl+s, or alt+tab',
    params: { keys: { type: 'string', required: true, describe: 'Keys joined with +, for example ctrl+shift+t' } },
    win: (p, c) => { const keys = parseKeys(p.keys); return c.ps(ps.keys, { codes: windowsKeyCodes(keys), label: keys.join('+') }); },
    mac: async p => { const keys = parseKeys(p.keys); await mac.keys(keys); return { pressed: keys.join('+') }; } },
  { id: 'clipboard_read', group: 'Mouse & keyboard', title: 'Read the clipboard', does: 'Read the text that was copied to the clipboard', read: true,
    win: (p, c) => c.ps(ps.clipboardRead), mac: async () => ({ text: await run('pbpaste') }) },
  { id: 'clipboard_write', group: 'Mouse & keyboard', title: 'Copy text', does: 'Put text on the clipboard so it can be pasted', params: { text: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.clipboardWrite, { text: p.text }), mac: async p => { await run('pbcopy', [], { input: String(p.text) }); return { copied: String(p.text).length }; } },

  // Devices and privacy
  { id: 'camera', group: 'Devices & privacy', title: 'Camera on or off', does: 'Turn the camera on or off: allow or block apps from using the webcam', params: { on: { type: 'boolean', required: true } },
    win: (p, c) => c.ps(ps.consent, { device: 'webcam', on: yes(p.on) }),
    mac: async () => { await run('open', [`x-apple.systempreferences:${settingsPages.camera[1]}`]); return { opened: 'Camera privacy settings', note: 'macOS has no camera switch; choose apps here.' }; } },
  { id: 'microphone_access', group: 'Devices & privacy', title: 'Allow or block the microphone', does: 'Allow or block apps from using the microphone at all', params: { on: { type: 'boolean', required: true } },
    win: (p, c) => c.ps(ps.consent, { device: 'microphone', on: yes(p.on) }),
    mac: async () => { await run('open', [`x-apple.systempreferences:${settingsPages.microphone[1]}`]); return { opened: 'Microphone privacy settings' }; } },
  { id: 'wifi', group: 'Devices & privacy', title: 'Wi-Fi on or off', does: 'Turn Wi-Fi on or off', params: { on: { type: 'boolean', required: true } },
    win: (p, c) => c.ps(ps.radio, { kind: 'WiFi', on: yes(p.on) }),
    mac: async p => { await run('networksetup', ['-setairportpower', await mac.wifiDevice(), yes(p.on) ? 'on' : 'off']); return { wifi: yes(p.on) ? 'on' : 'off' }; } },
  { id: 'bluetooth', group: 'Devices & privacy', title: 'Bluetooth on or off', does: 'Turn Bluetooth on or off', params: { on: { type: 'boolean', required: true } },
    win: (p, c) => c.ps(ps.radio, { kind: 'Bluetooth', on: yes(p.on) }),
    mac: async p => { try { await run('blueutil', ['--power', yes(p.on) ? '1' : '0']); return { bluetooth: yes(p.on) ? 'on' : 'off' }; }
      catch { await run('open', [`x-apple.systempreferences:${settingsPages.bluetooth[1]}`]); return { opened: 'Bluetooth settings', note: 'Install blueutil (brew install blueutil) to switch Bluetooth directly.' }; } } },

  // Battery and power
  { id: 'battery_status', group: 'Battery & power', title: 'Check the battery', does: 'Say how much battery is left and whether the computer is charging', read: true,
    win: (p, c) => c.ps(ps.battery),
    mac: async () => { const text = await run('pmset', ['-g', 'batt']); return { pluggedIn: /AC Power/.test(text), percent: Number(/(\d+)%/.exec(text)?.[1] ?? NaN), state: /;\s*([a-z ]+);/.exec(text)?.[1] || '', timeLeft: /(\d+:\d+) remaining/.exec(text)?.[1] || null }; } },
  { id: 'battery_saver', group: 'Battery & power', title: 'Battery saver on or off', does: 'Turn battery saver, energy saver, or low power mode on or off to make the battery last longer', params: { on: { type: 'boolean', required: true } },
    // Windows turns its saver on when the battery falls to this level, so 100 means "on whenever unplugged" and 20 is the default.
    // Newer Windows 11 builds dropped that setting; there the closest switch is the best-power-efficiency power mode.
    win: (p, c) => c.ps(ps.saver, { threshold: yes(p.on) ? 100 : 20 }).catch(() => c.run('power_mode', { mode: yes(p.on) ? 'efficiency' : 'balanced' }).then(({ result }) => ({ ...result, via: 'power mode' }))),
    mac: async p => { await asAdmin(`pmset -a lowpowermode ${yes(p.on) ? 1 : 0}`); return { lowPowerMode: yes(p.on) }; } },
  { id: 'power_mode', group: 'Battery & power', title: 'Power mode', does: 'Choose best battery life, balanced, or best performance', params: { mode: { type: 'enum', values: ['efficiency', 'balanced', 'performance'], required: true } },
    win: (p, c) => c.ps(ps.powerMode, { mode: p.mode, guid: { efficiency: '961cc777-2547-4f9d-8174-7d86181b8a7a', balanced: '00000000-0000-0000-0000-000000000000', performance: 'ded574b5-45a0-4f42-8737-46345c09c238' }[known(p.mode, ['efficiency', 'balanced', 'performance'], 'mode')] }),
    mac: async p => { await asAdmin(`pmset -a lowpowermode ${p.mode === 'efficiency' ? 1 : 0}`); return { lowPowerMode: p.mode === 'efficiency' }; } },
  { id: 'lock', group: 'Battery & power', title: 'Lock the computer', does: 'Lock the screen so a password is needed', later: true,
    win: (p, c) => c.ps(ps.lock), mac: async () => { await osa('tell application "System Events" to keystroke "q" using {control down, command down}'); return { locked: true }; } },
  { id: 'sleep', group: 'Battery & power', title: 'Sleep', does: 'Put the computer to sleep now', later: true,
    win: (p, c) => c.ps(ps.suspend, {}), mac: async () => { await run('pmset', ['sleepnow']); return { done: true }; } },
  { id: 'sleep_and_wake', group: 'Battery & power', title: 'Sleep and wake up later', does: 'Put the computer to sleep now and wake it up by itself after some hours or minutes', later: true,
    params: { hours: { type: 'number', min: 0, max: 72, describe: 'Hours until it wakes' }, minutes: { type: 'number', min: 0, max: 59 } },
    prepare: async (p, c) => c.scheduleWake(p), win: (p, c) => c.ps(ps.suspend, {}), mac: async () => { await run('pmset', ['sleepnow']); return { done: true }; } },
  { id: 'schedule_wake', group: 'Battery & power', title: 'Wake up later', does: 'Set the computer to wake up by itself at a later time, without sleeping now',
    params: { hours: { type: 'number', min: 0, max: 72 }, minutes: { type: 'number', min: 0, max: 59 } }, win: (p, c) => c.scheduleWake(p), mac: (p, c) => c.scheduleWake(p) },
  { id: 'hibernate', group: 'Battery & power', title: 'Hibernate', does: 'Hibernate: save everything to disk and power off', confirm: true, later: true, macNote: 'macOS hibernates on its own when the battery is low.',
    win: (p, c) => c.ps(ps.suspend, { hibernate: true }) },
  { id: 'shutdown', group: 'Battery & power', title: 'Shut down', does: 'Turn the computer off, shut down', confirm: true, later: true, params: { minutes: { type: 'number', min: 0, max: 600, describe: 'Delay; Windows waits 1 minute if not said so it can be cancelled' } },
    win: (p, c) => c.ps(ps.shutdown, { flags: ['/s', '/t', String(Math.round((p.minutes ?? 1) * 60)), '/c', 'Rex Desk is shutting down this computer.'] }),
    mac: async () => { await osa('tell application "System Events" to shut down'); return { done: true }; } },
  { id: 'restart', group: 'Battery & power', title: 'Restart', does: 'Restart or reboot the computer', confirm: true, later: true, params: { minutes: { type: 'number', min: 0, max: 600 } },
    win: (p, c) => c.ps(ps.shutdown, { flags: ['/r', '/t', String(Math.round((p.minutes ?? 1) * 60)), '/c', 'Rex Desk is restarting this computer.'] }),
    mac: async () => { await osa('tell application "System Events" to restart'); return { done: true }; } },
  { id: 'cancel_shutdown', group: 'Battery & power', title: 'Cancel shut down', does: 'Stop a shutdown or restart that is counting down', macNote: 'macOS shuts down at once, so there is nothing to cancel.',
    win: (p, c) => c.ps(ps.shutdown, { flags: ['/a'] }) },
  { id: 'sign_out', group: 'Battery & power', title: 'Sign out', does: 'Sign out or log off of this user account', confirm: true, later: true,
    win: (p, c) => c.ps(ps.shutdown, { flags: ['/l'] }), mac: async () => { await osa('tell application "System Events" to log out'); return { done: true }; } },

  // System
  { id: 'system_info', group: 'System', title: 'Check the computer', does: 'Say how busy the processor is, how much memory and disk space is free, and how long the computer has been on', read: true,
    win: (p, c) => c.systemInfo(), mac: (p, c) => c.systemInfo() },
  { id: 'top_processes', group: 'System', title: 'What uses the most memory', does: 'List the programs using the most memory', read: true, params: { limit: { type: 'number', min: 1, max: 40 } },
    win: (p, c) => c.ps(ps.processes, { limit: clamp(p.limit || 10, 1, 40) }),
    mac: async p => (await run('ps', ['-Ao', 'pid=,rss=,%cpu=,comm=', '-m'])).split('\n').slice(0, clamp(p.limit || 10, 1, 40)).map(line => { const [processId, rss, cpu, ...name] = line.trim().split(/\s+/); return { name: path.basename(name.join(' ')), processId: Number(processId), memoryMB: Math.round(Number(rss) / 1024), cpuPercent: Number(cpu) }; }) },
  { id: 'stop_program', group: 'System', title: 'Stop a program', does: 'Force a frozen or heavy program to stop', confirm: true, params: { name: { type: 'string', required: true, describe: 'Process name, such as chrome or Teams' } },
    win: (p, c) => { const name = String(p.name).replace(/\.exe$/i, ''); if (protectedProcesses.has(name.toLowerCase())) throw new Error(`${name} keeps Windows or Rex Desk running, so it is not stopped.`); return c.ps(ps.kill, { name }); },
    mac: async p => { if (protectedProcesses.has(String(p.name).toLowerCase())) throw new Error(`${p.name} keeps macOS or Rex Desk running, so it is not stopped.`); await run('killall', [String(p.name)]); return { stopped: p.name }; } },
  { id: 'notify', group: 'System', title: 'Show a notification', does: 'Show a pop-up notification on the screen', params: { title: { type: 'string' }, message: { type: 'string', required: true } },
    win: (p, c) => c.ps(ps.notify, { title: p.title || 'Rex Desk', message: p.message }), mac: async p => { await osa(`display notification ${asString(p.message)} with title ${asString(p.title || 'Rex Desk')}`); return { shown: true }; } },
  { id: 'empty_trash', group: 'System', title: 'Empty the Recycle Bin', does: 'Empty the Recycle Bin or Trash, deleting those files for good', confirm: true,
    win: (p, c) => c.ps(ps.emptyTrash), mac: async () => { await osa('tell application "Finder" to empty trash'); return { emptied: true }; } },
];

const byId = new Map(actions.map(action => [action.id, action]));
export const platformKey = (platform = process.platform) => platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : '';

// Values a person or a model supplied, checked against the action's description of them.
export function checkParams(action, input = {}) {
  const values = {};
  for (const [name, spec] of Object.entries(action.params || {})) {
    let value = input[name];
    if (value === undefined || value === null || value === '') { if (spec.required) throw new Error(`${action.title} needs ${name}.`); continue; }
    if (spec.type === 'number') { value = Number(value); if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`); if (spec.min !== undefined) value = Math.max(spec.min, value); if (spec.max !== undefined) value = Math.min(spec.max, value); }
    else if (spec.type === 'boolean') value = yes(value);
    else if (spec.type === 'enum') { value = String(value).toLowerCase().replace(/[\s-]+/g, '_'); known(value, spec.values, name); }
    else value = String(value).slice(0, 5000);
    values[name] = value;
  }
  return values;
}

export class Computer {
  constructor({ platform = process.platform, directory = os.tmpdir(), runner } = {}) {
    Object.assign(this, { platform, key: platformKey(platform), directory });
    this.worker = runner || (this.key === 'win' ? new WindowsWorker() : null);
    this.items = []; this.shot = null; this.appList = null;
  }
  supported(action) { return Boolean(action[this.key]); }
  // What this computer can do, for the dashboard, Jev, and agents.
  catalog() {
    return actions.map(({ id, group, title, does, params, confirm, read, macNote }) => ({ id, group, title, does, params: params || {}, confirm: Boolean(confirm), read: Boolean(read),
      available: this.supported(byId.get(id)), note: this.key === 'mac' ? macNote || '' : '' }));
  }
  available() { return actions.filter(action => this.supported(action)); }
  action(id) {
    const action = byId.get(id);
    if (!action) throw new Error(`Unknown computer action "${id}".`);
    if (!this.supported(action)) throw new Error(`${action.title} is not available on ${this.key === 'mac' ? 'macOS' : this.key === 'win' ? 'Windows' : this.platform}.${action.macNote ? ` ${action.macNote}` : ''}`);
    return action;
  }
  // Runs one action. Sleep, lock, and shutdown answer first and happen a moment later, so the reply reaches the screen.
  async run(id, input = {}) {
    const action = this.action(id), params = checkParams(action, input);
    const prepared = action.prepare ? await action.prepare(params, this) : undefined;
    if (action.later) {
      const timer = setTimeout(() => void action[this.key](params, this).catch(() => {}), 1500); timer.unref?.();
      return { action: id, scheduled: true, params, ...(prepared ? { result: prepared } : {}) };
    }
    return { action: id, result: await action[this.key](params, this) };
  }
  ps(script, args) { if (!this.worker) throw new Error('Windows control is not available here.'); return this.worker.call(script, args); }
  async apps() {
    if (this.appList && Date.now() - this.appList.at < 5 * 60000) return this.appList.items;
    const items = this.key === 'win' ? [].concat(await this.ps(ps.apps) || []) : await mac.apps();
    this.appList = { at: Date.now(), items }; return items;
  }
  async screenshot({ maxWidth = 1568 } = {}) {
    mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, `screen-${Date.now()}.jpg`);
    if (this.key === 'win') this.shot = await this.ps(ps.screenshot, { path: file, maxWidth });
    else {
      await run('screencapture', ['-x', '-t', 'jpg', file]);
      await run('sips', ['-Z', String(maxWidth), file]);
      const size = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
      const points = Number(await jxa("ObjC.import('AppKit'); $.NSScreen.mainScreen.frame.size.width"));
      const width = Number(/pixelWidth: (\d+)/.exec(size)?.[1]), height = Number(/pixelHeight: (\d+)/.exec(size)?.[1]);
      this.shot = { path: file, width, height, left: 0, top: 0, scale: width / points };
    }
    return this.shot;
  }
  // A position on the last screenshot, turned into a screen position.
  fromScreenshot(x, y) {
    if (!this.shot) throw new Error('Take a screenshot first.');
    return { x: Math.round(this.shot.left + x / this.shot.scale), y: Math.round(this.shot.top + y / this.shot.scale) };
  }
  async elements(window = '') {
    if (this.key === 'win') { const found = await this.ps(ps.elements, { window: window || '', limit: 150 }); this.items = [].concat(found.elements || []); return { window: found.window, elements: this.items }; }
    // macOS reads the front app's window through System Events; it needs Accessibility permission for Rex Desk.
    const text = await jxa(`const se = Application('System Events');
      const processes = se.processes.whose({ backgroundOnly: false })();
      let proc = processes.find(p => p.frontmost() && !/rex desk/i.test(p.name()));
      ${window ? `proc = processes.find(p => p.name().toLowerCase().includes(${asString(String(window).toLowerCase())})) || proc;` : ''}
      if (!proc) throw new Error('No window is open to look at.');
      const kinds = new Set(['AXButton','AXLink','AXMenuItem','AXMenuButton','AXRadioButton','AXCheckBox','AXTextField','AXTextArea','AXPopUpButton','AXTab','AXRow','AXCell','AXComboBox','AXSlider']);
      const out = [];
      for (const item of proc.windows[0].entireContents()) {
        if (out.length >= 150) break;
        try { const role = item.role(); if (!kinds.has(role)) continue;
          const name = item.name() || item.description() || item.title() || ''; if (!name) continue;
          const [x, y] = item.position(), [w, h] = item.size();
          out.push({ index: out.length, name, type: role.replace(/^AX/, ''), x: Math.round(x + w / 2), y: Math.round(y + h / 2), enabled: item.enabled() });
        } catch (error) {}
      }
      JSON.stringify({ window: proc.name(), elements: out });`);
    const found = JSON.parse(text); this.items = found.elements; return found;
  }
  // Presses an item by its number from the last look at the screen, or finds it by its words.
  async pressItem({ name, index, window } = {}) {
    let item = index !== undefined && index !== '' ? this.items.find(entry => entry.index === Number(index)) : null;
    if (!item && name) { await this.elements(window); item = bestMatch(name, this.items, entry => entry.name); }
    if (!item) throw new Error(name ? `Nothing called "${name}" is on screen.` : 'Read the screen first, then name the item.');
    if (this.key === 'win') return this.ps(ps.pressElement, { index: item.index });
    await mac.mouse(item.x, item.y, [[1, 0], [2, 0]]); return { pressed: item.name, how: 'click' };
  }
  async scheduleWake({ hours = 0, minutes = 0 } = {}) {
    const total = Math.round(Number(hours || 0) * 60 + Number(minutes || 0));
    if (total < 1) throw new Error('Say when to wake up, for example in 5 hours.');
    if (this.key === 'win') return this.ps(ps.wakeTask, { minutes: total });
    const at = new Date(Date.now() + total * 60000), pad = value => String(value).padStart(2, '0');
    const stamp = `${pad(at.getMonth() + 1)}/${pad(at.getDate())}/${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
    await asAdmin(`pmset schedule wake "${stamp}"`);
    return { wakeAt: at.toISOString() };
  }
  async systemInfo() {
    const sample = () => os.cpus().map(cpu => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }));
    const before = sample(); await new Promise(resolve => setTimeout(resolve, 300)); const after = sample();
    const busy = after.reduce((sum, cpu, index) => sum + (1 - (cpu.idle - before[index].idle) / Math.max(1, cpu.total - before[index].total)), 0) / after.length;
    const disk = (() => { try { const stats = statfsSync(this.key === 'win' ? 'C:\\' : '/'); return { freeGB: +(stats.bavail * stats.bsize / 2 ** 30).toFixed(1), totalGB: +(stats.blocks * stats.bsize / 2 ** 30).toFixed(1) }; } catch { return null; } })();
    return { computer: os.hostname(), system: `${this.key === 'win' ? 'Windows' : this.key === 'mac' ? 'macOS' : os.type()} ${os.release()}`, processorBusyPercent: Math.round(busy * 100), processors: os.cpus().length,
      memoryFreeGB: +(os.freemem() / 2 ** 30).toFixed(1), memoryTotalGB: +(os.totalmem() / 2 ** 30).toFixed(1), systemDisk: disk, onForHours: +(os.uptime() / 3600).toFixed(1) };
  }
  stop() { this.worker?.stop?.(); }
}
