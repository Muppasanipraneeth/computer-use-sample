# Jarvis's Control-key watcher for hold-to-talk (Windows); the macOS twin is control-key.swift. Electron's
# globalShortcut can only register key combinations, never a lone modifier, so this helper watches instead and prints
# one line per change on stdout:
#   "ready"  once, when the hooks are in place (Windows needs no permission for this)
#   "down"   Control went down with no Shift, Alt or Windows key held
#   "up"     Control went up (both Control keys, when both were held)
#   "other"  another key or a mouse button went down while Control is held, so it is part of a shortcut (Ctrl+C)
# It uses low-level keyboard and mouse hooks, compiled at start by Add-Type (the C# compiler ships with .NET Framework,
# so nothing needs installing). It only observes events: every hook passes the event on unchanged. It exits when its
# stdin closes, so it never outlives Jarvis.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class JarvisControlKey
{
    const int WH_KEYBOARD_LL = 13;
    const int WH_MOUSE_LL = 14;
    const int WM_KEYDOWN = 0x0100;
    const int WM_KEYUP = 0x0101;
    const int WM_SYSKEYDOWN = 0x0104;
    const int WM_SYSKEYUP = 0x0105;
    const int WM_LBUTTONDOWN = 0x0201;
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_MBUTTONDOWN = 0x0207;
    const int WM_XBUTTONDOWN = 0x020B;
    const int VK_SHIFT = 0x10;
    const int VK_CONTROL = 0x11;
    const int VK_MENU = 0x12;
    const int VK_LWIN = 0x5B;
    const int VK_RWIN = 0x5C;
    const int VK_LCONTROL = 0xA2;
    const int VK_RCONTROL = 0xA3;

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string lpModuleName);

    // Kept in static fields for the hooks' lifetime: a delegate the GC collects crashes the process on the next event.
    static readonly HookProc keyboardProc = new HookProc(OnKeyboard);
    static readonly HookProc mouseProc = new HookProc(OnMouse);

    // Hook callbacks must return fast (Windows silently drops a hook that keeps it waiting), so they only queue lines
    // and a writer thread does the possibly-blocking pipe writes.
    // A List rather than a Queue: List lives in mscorlib, which Add-Type always references.
    static readonly List<string> lines = new List<string>();
    static bool leftControl;
    static bool rightControl;
    static bool controlDown;

    static void Emit(string line)
    {
        lock (lines)
        {
            lines.Add(line);
            Monitor.Pulse(lines);
        }
    }

    // Inside a low-level hook GetAsyncKeyState still reports the state from before the current event.
    static bool Held(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }

    static IntPtr OnKeyboard(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            int vk = Marshal.ReadInt32(lParam); // KBDLLHOOKSTRUCT.vkCode
            bool pressed = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool released = message == WM_KEYUP || message == WM_SYSKEYUP;
            if (vk == VK_LCONTROL || vk == VK_RCONTROL || vk == VK_CONTROL)
            {
                bool right = vk == VK_RCONTROL;
                if (pressed)
                {
                    // A release we never saw (secure desktop, UAC prompt) would make every later press look like
                    // auto-repeat; if Windows says Control was up before this event, it is a fresh press.
                    if ((leftControl || rightControl) && !Held(VK_CONTROL))
                    {
                        leftControl = false;
                        rightControl = false;
                        if (controlDown) { controlDown = false; Emit("up"); }
                    }
                    // Auto-repeat and the second Control key arrive while one is already held: not a new press.
                    bool alreadyHeld = leftControl || rightControl;
                    if (right) rightControl = true; else leftControl = true;
                    if (!alreadyHeld && !Held(VK_SHIFT) && !Held(VK_MENU) && !Held(VK_LWIN) && !Held(VK_RWIN))
                    {
                        controlDown = true;
                        Emit("down");
                    }
                }
                else if (released)
                {
                    if (vk == VK_CONTROL) { leftControl = false; rightControl = false; }
                    else if (right) rightControl = false;
                    else leftControl = false;
                    if (controlDown && !leftControl && !rightControl)
                    {
                        controlDown = false;
                        Emit("up");
                    }
                }
            }
            else if (pressed && controlDown)
            {
                Emit("other");
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    static IntPtr OnMouse(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && controlDown)
        {
            int message = wParam.ToInt32();
            if (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN)
            {
                Emit("other");
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    public static int Run()
    {
        StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.NewLine = "\n";
        stdout.AutoFlush = true;
        Thread writer = new Thread(delegate ()
        {
            try
            {
                while (true)
                {
                    string line;
                    lock (lines)
                    {
                        while (lines.Count == 0) Monitor.Wait(lines);
                        line = lines[0];
                        lines.RemoveAt(0);
                    }
                    stdout.WriteLine(line);
                }
            }
            catch (IOException)
            {
                // Jarvis closed the pipe; the stdin watcher ends the process.
            }
        });
        writer.IsBackground = true;
        writer.Start();

        // Low-level hooks run in this process, so the module handle is only a formality; the host exe's will do.
        IntPtr module = GetModuleHandle(null);
        if (SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0) == IntPtr.Zero)
        {
            Console.Error.WriteLine("control-key: could not hook the keyboard (error " + Marshal.GetLastWin32Error() + ")");
            return 1;
        }
        if (SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0) == IntPtr.Zero)
        {
            Console.Error.WriteLine("control-key: could not hook the mouse (error " + Marshal.GetLastWin32Error() + ")");
            return 1;
        }

        Thread stdinWatcher = new Thread(delegate ()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] buffer = new byte[256];
                while (input.Read(buffer, 0, buffer.Length) > 0) { }
            }
            catch (IOException) { }
            // Process exit releases the hooks.
            Environment.Exit(0);
        });
        stdinWatcher.IsBackground = true;
        stdinWatcher.Start();

        Emit("ready");
        // The hooks are called from this thread's message loop, so it must keep pumping.
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        return 0;
    }
}
'@

exit ([JarvisControlKey]::Run())
