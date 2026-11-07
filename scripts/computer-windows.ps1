# Rex Desk computer control worker for Windows.
# One long-lived PowerShell process: the native helpers below compile once, then every command arrives as a JSON line
# {"id":1,"script":"param($a) ...","args":{...}} on stdin and its answer leaves as one JSON line on stdout.
# Only Rex Desk's own server writes to stdin; the scripts come from src/computer.js, never from a person or a model.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace RexDesk {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int j();
    int GetMasterVolumeLevelScalar(out float level);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
    int GetMute(out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int context, int parameters, out IAudioEndpointVolume volume); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  // flow 0 is the speakers (render), 1 the microphone (capture).
  public static class Audio {
    static IAudioEndpointVolume Endpoint(int flow) {
      var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
      IMMDevice device; Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(flow, 1, out device));
      IAudioEndpointVolume volume; var id = typeof(IAudioEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(device.Activate(ref id, 23, 0, out volume));
      return volume;
    }
    public static float GetVolume(int flow) { float level; Marshal.ThrowExceptionForHR(Endpoint(flow).GetMasterVolumeLevelScalar(out level)); return level; }
    public static void SetVolume(int flow, float level) { Marshal.ThrowExceptionForHR(Endpoint(flow).SetMasterVolumeLevelScalar(level, Guid.Empty)); }
    public static bool GetMute(int flow) { bool mute; Marshal.ThrowExceptionForHR(Endpoint(flow).GetMute(out mute)); return mute; }
    public static void SetMute(int flow, bool mute) { Marshal.ThrowExceptionForHR(Endpoint(flow).SetMute(mute, Guid.Empty)); }
  }

  public static class Input {
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);

    static void Send(INPUT[] inputs) {
      if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
        throw new Exception("Windows blocked the input. A window running as administrator ignores input from normal apps.");
    }
    static INPUT Mouse(uint flags, int data) { var input = new INPUT { type = 0 }; input.u.mouse.flags = flags; input.u.mouse.data = unchecked((uint)data); return input; }
    static INPUT Key(ushort vk, ushort scan, uint flags) { var input = new INPUT { type = 1 }; input.u.key.vk = vk; input.u.key.scan = scan; input.u.key.flags = flags; return input; }
    static bool Extended(ushort vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || (vk >= 0xA6 && vk <= 0xB7); }

    public static void Click(int x, int y, string button, int count) {
      SetCursorPos(x, y); Thread.Sleep(30);
      uint down = 0x2, up = 0x4;
      if (button == "right") { down = 0x8; up = 0x10; } else if (button == "middle") { down = 0x20; up = 0x40; }
      for (int index = 0; index < count; index++) { Send(new[] { Mouse(down, 0), Mouse(up, 0) }); Thread.Sleep(70); }
    }
    public static void Scroll(int notches, bool horizontal) { Send(new[] { Mouse(horizontal ? 0x1000u : 0x0800u, notches * 120) }); }
    public static void Drag(int fromX, int fromY, int toX, int toY) {
      SetCursorPos(fromX, fromY); Send(new[] { Mouse(0x2, 0) });
      for (int step = 1; step <= 20; step++) { SetCursorPos(fromX + (toX - fromX) * step / 20, fromY + (toY - fromY) * step / 20); Thread.Sleep(12); }
      Send(new[] { Mouse(0x4, 0) });
    }
    // Unicode key events type any script, Khmer and Korean included, whatever keyboard layout is active.
    public static void Type(string text) {
      var inputs = new List<INPUT>();
      foreach (char ch in text) {
        if (ch == '\r') continue;
        if (ch == '\n') { inputs.Add(Key(0x0D, 0, 0)); inputs.Add(Key(0x0D, 0, 2)); continue; }
        inputs.Add(Key(0, ch, 0x4)); inputs.Add(Key(0, ch, 0x6));
      }
      if (inputs.Count > 0) Send(inputs.ToArray());
    }
    // Presses the keys in order and releases them in reverse, so ctrl+shift+s works like a person's chord.
    public static void Chord(ushort[] keys) {
      var inputs = new List<INPUT>();
      foreach (var vk in keys) inputs.Add(Key(vk, 0, Extended(vk) ? 1u : 0u));
      for (int index = keys.Length - 1; index >= 0; index--) inputs.Add(Key(keys[index], 0, (Extended(keys[index]) ? 1u : 0u) | 2u));
      Send(inputs.ToArray());
    }
    public static void MonitorOff() { PostMessage((IntPtr)0xFFFF, 0x0112, (IntPtr)0xF170, (IntPtr)2); }
    public static void Focus(IntPtr window) { if (IsIconic(window)) ShowWindow(window, 9); SetForegroundWindow(window); }
  }
}
'@
# Physical pixels everywhere, so a screenshot position is a click position.
[void][RexDesk.Input]::SetProcessDPIAware()

$script:elements = @()

# Await a WinRT IAsyncOperation from Windows PowerShell 5.1.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-WinRt($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  [void]$task.Wait(-1); $task.Result
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $result = & ([scriptblock]::Create($request.script)) $request.args
    $answer = @{ id = $id; ok = $true; result = $result }
  } catch {
    $answer = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
