// Bringing a session's terminal to the front, and telling whether it already is, on each OS.
// Everything is best effort: a missing tool or a desktop without a way to do it returns false.

import { execFile } from 'node:child_process';

function run(cmd, args, { timeout = 3000, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

const pidsOf = s => ((s && s.origin && s.origin.pids) || []).map(p => (typeof p === 'object' ? p.pid : p)).filter(Boolean);
const envOf = s => (s && s.origin && s.origin.env) || {};

// ---------------------------------------------------------------- Linux

async function hyprClients() {
  const out = await run('hyprctl', ['clients', '-j']);
  try { return out ? JSON.parse(out) : []; } catch { return []; }
}

async function hyprFocus(address) {
  // Hyprland 0.55+ with a Lua config takes Lua dispatches; older configs take the classic syntax.
  const lua = await run('hyprctl', ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`]);
  if (lua && lua.trim() === 'ok') return true;
  const classic = await run('hyprctl', ['dispatch', 'focuswindow', `address:${address}`]);
  return !!(classic && classic.trim() === 'ok');
}

async function tmuxSelect(env) {
  if (!env.TMUX_PANE) return false;
  const socket = env.TMUX ? ['-S', env.TMUX.split(',')[0]] : [];
  const a = await run('tmux', [...socket, 'select-window', '-t', env.TMUX_PANE]);
  const b = await run('tmux', [...socket, 'select-pane', '-t', env.TMUX_PANE]);
  return a !== null && b !== null;
}

async function linuxFocus(s) {
  const pids = pidsOf(s), env = envOf(s);
  await tmuxSelect(env);
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const clients = await hyprClients();
    for (const pid of pids) {
      const c = clients.find(w => w.pid === pid);
      if (c) return { ok: await hyprFocus(c.address), how: `hyprland ${c.class}` };
    }
    return { ok: false, how: 'no window found for the session' };
  }
  if (process.env.DISPLAY) {
    if (env.WINDOWID) {
      const r = await run('xdotool', ['windowactivate', env.WINDOWID]);
      if (r !== null) return { ok: true, how: 'xdotool WINDOWID' };
    }
    for (const pid of pids) {
      const ids = await run('xdotool', ['search', '--pid', String(pid)]);
      const id = ids && ids.trim().split('\n').pop();
      if (id) return { ok: (await run('xdotool', ['windowactivate', id])) !== null, how: 'xdotool' };
    }
  }
  return { ok: false, how: 'this desktop does not let apps focus windows' };
}

async function linuxActivePid() {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const out = await run('hyprctl', ['activewindow', '-j'], { timeout: 1500 });
    try { return out ? JSON.parse(out).pid : undefined; } catch { return undefined; }
  }
  if (process.env.DISPLAY) {
    const out = await run('xdotool', ['getactivewindow', 'getwindowpid'], { timeout: 1500 });
    return out ? Number(out.trim()) || undefined : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- macOS

const MAC_APPS = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm2', vscode: 'Visual Studio Code', WezTerm: 'WezTerm',
  ghostty: 'Ghostty', Hyper: 'Hyper', Tabby: 'Tabby', kitty: 'kitty', alacritty: 'Alacritty', WarpTerminal: 'Warp' };

function macApp(env) {
  if (env.TERM_PROGRAM && MAC_APPS[env.TERM_PROGRAM]) return MAC_APPS[env.TERM_PROGRAM];
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.ALACRITTY_WINDOW_ID) return 'Alacritty';
  return env.TERM_PROGRAM || 'Terminal';
}

async function macFocus(s) {
  const env = envOf(s), app = macApp(env), tty = s.origin && s.origin.tty;
  const esc = v => String(v).replace(/[\\"]/g, '\\$&');
  let script = `tell application "${esc(app)}" to activate`;
  if (tty && app === 'Terminal') {
    script = `tell application "Terminal"
      activate
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${esc(tty)}" then
            set selected of t to true
            set index of w to 1
          end if
        end repeat
      end repeat
    end tell`;
  } else if (tty && app === 'iTerm2') {
    script = `tell application "iTerm2"
      activate
      repeat with w in windows
        repeat with t in tabs of w
          repeat with ss in sessions of t
            if tty of ss is "${esc(tty)}" then
              select w
              select t
              select ss
            end if
          end repeat
        end repeat
      end repeat
    end tell`;
  }
  await tmuxSelect(env);
  return { ok: (await run('osascript', ['-e', script])) !== null, how: app };
}

async function macActivePid() {
  const out = await run('osascript', ['-e', 'tell application "System Events" to unix id of first process whose frontmost is true'], { timeout: 1500 });
  return out ? Number(out.trim()) || undefined : undefined;
}

// ---------------------------------------------------------------- Windows

const PS_HEAD = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class ClippitWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
`;

async function winFocus(s) {
  const pid = pidsOf(s)[0];
  if (!pid) return { ok: false, how: 'no process id' };
  // Walk up from claude to the first ancestor that owns a window (Windows Terminal, conhost, VS Code...).
  const script = `${PS_HEAD}
$id = ${Number(pid)}
for ($i = 0; $i -lt 12 -and $id; $i++) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) {
    if ([ClippitWin]::IsIconic($p.MainWindowHandle)) { [ClippitWin]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null }
    [ClippitWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Write-Output $p.ProcessName; exit 0
  }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
}
exit 1`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  return { ok: out !== null, how: out ? out.trim() : 'no window found' };
}

async function winActivePid() {
  const script = `${PS_HEAD}
$pid0 = 0; [ClippitWin]::GetWindowThreadProcessId([ClippitWin]::GetForegroundWindow(), [ref]$pid0) | Out-Null; Write-Output $pid0`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 4000 });
  return out ? Number(out.trim()) || undefined : undefined;
}

// Windows only sends claude's own pid; the terminal is an ancestor, so compare against the chain lazily.
async function winAncestors(pid) {
  const script = `$id = ${Number(pid)}; $out = @(); for ($i = 0; $i -lt 12 -and $id; $i++) { $out += $id; $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId }; $out -join ','`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  return out ? out.trim().split(',').map(Number).filter(Boolean) : [];
}

// ---------------------------------------------------------------- public

export async function focusSession(s, platform = process.platform) {
  try {
    if (platform === 'linux') return await linuxFocus(s);
    if (platform === 'darwin') return await macFocus(s);
    if (platform === 'win32') return await winFocus(s);
  } catch { /* fall through */ }
  return { ok: false, how: 'unsupported' };
}

let cache = { at: 0, pid: undefined };
export async function activeWindowPid(platform = process.platform) {
  if (Date.now() - cache.at < 1500) return cache.pid;
  let pid;
  try {
    if (platform === 'linux') pid = await linuxActivePid();
    else if (platform === 'darwin') pid = await macActivePid();
    else if (platform === 'win32') pid = await winActivePid();
  } catch { pid = undefined; }
  cache = { at: Date.now(), pid };
  return pid;
}

// Is the session's terminal the window in front right now?
export async function isFocused(s, platform = process.platform) {
  const active = await activeWindowPid(platform);
  if (!active) return false;
  let pids = pidsOf(s);
  if (platform === 'win32' && pids.length === 1) {
    s.origin.pids = pids = await winAncestors(pids[0]);
  }
  return pids.includes(active);
}
