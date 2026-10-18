// The Windows side of Mark a zone and the hand-off to Claude: the window in front, screenshots, text
// recognition (Windows.Media.Ocr, built into Windows 10 and 11), which process serves a localhost port,
// and a console window running claude. All of it through PowerShell 5.1, which every Windows has, so
// nothing needs compiling or installing. Each call is best effort and resolves to null or an empty result.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function ps(script, { timeout = 8000 } = {}) {
  // -EncodedCommand takes UTF-16LE base64, so the script needs no quoting at all.
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: err ? String(stderr || err.message).trim() : '' });
      });
  });
}

const psString = s => `'${String(s).replace(/'/g, "''")}'`;

// Physical pixels everywhere: Electron converts zones to screen pixels before they get here.
const DPI_AWARE = `Add-Type 'using System; using System.Runtime.InteropServices; public static class ClippitDpi { [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v); }'
[ClippitDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null`;

// ---------------------------------------------------------------- the window in front

const BROWSERS = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave Browser', vivaldi: 'Vivaldi',
  opera: 'Opera', chromium: 'Chromium', arc: 'Arc' };

// The topmost real window that isn't Clippit's (opening his menu brings him forward).
export async function frontWindow(skipPids = []) {
  const script = `${DPI_AWARE}
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ClippitFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
}
"@
$skip = @(${skipPids.map(Number).filter(Boolean).join(', ') || 0})
$h = [ClippitFront]::GetForegroundWindow()
for ($i = 0; $i -lt 400 -and $h -ne [IntPtr]::Zero; $i++) {
  $owner = 0; [ClippitFront]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
  $sb = New-Object Text.StringBuilder 512; [ClippitFront]::GetWindowText($h, $sb, 512) | Out-Null
  $tool = [ClippitFront]::GetWindowLong($h, -20) -band 0x80
  if ([ClippitFront]::IsWindowVisible($h) -and -not [ClippitFront]::IsIconic($h) -and $sb.Length -gt 0 -and -not $tool -and $skip -notcontains $owner) {
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -notmatch '^(electron|clippit|explorer)$') {
      [pscustomobject]@{ pid = [int]$owner; name = $p.ProcessName; product = $p.Product; title = $sb.ToString() } | ConvertTo-Json -Compress
      exit 0
    }
  }
  $h = [ClippitFront]::GetWindow($h, 2)
}`;
  const r = await ps(script, { timeout: 6000 });
  let w;
  try { w = JSON.parse(r.out.trim()); } catch { return null; }
  const key = String(w.name || '').toLowerCase();
  return { pid: w.pid, name: w.product || w.name, process: w.name, windowTitle: w.title || undefined,
    browser: BROWSERS[key] ? 'chromium' : null, appName: BROWSERS[key] || w.product || w.name };
}

// ---------------------------------------------------------------- screenshots and text

// shots: [{ rect: {x, y, width, height} in screen pixels, file }]. Returns which files were written.
export async function capture(shots) {
  const lines = shots.map(({ rect: r, file }) => {
    const [x, y, w, h] = [r.x, r.y, r.width, r.height].map(Math.round);
    return `try { $b = New-Object Drawing.Bitmap ${Math.max(1, w)}, ${Math.max(1, h)}; $g = [Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size); $b.Save(${psString(file)}, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose() } catch { }`;
  });
  await ps(`${DPI_AWARE}\nAdd-Type -AssemblyName System.Drawing\n${lines.join('\n')}`, { timeout: 10000 });
  return shots.map(s => existsSync(s.file));
}

// Lines as "x y w h<TAB>text", the box as fractions of the image with y from the top, like the macOS helper.
export async function ocr(file) {
  const script = `Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { [Console]::Error.WriteLine('no OCR language installed'); exit 2 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${psString(file)})) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$imgW = [double]$bitmap.PixelWidth; $imgH = [double]$bitmap.PixelHeight; $inv = [Globalization.CultureInfo]::InvariantCulture
foreach ($line in $result.Lines) {
  $x0 = 1e9; $y0 = 1e9; $x1 = 0; $y1 = 0
  foreach ($word in $line.Words) { $r = $word.BoundingRect; $x0 = [Math]::Min($x0, $r.X); $y0 = [Math]::Min($y0, $r.Y); $x1 = [Math]::Max($x1, $r.X + $r.Width); $y1 = [Math]::Max($y1, $r.Y + $r.Height) }
  [Console]::Out.WriteLine([string]::Format($inv, '{0:F3} {1:F3} {2:F3} {3:F3}', $x0 / $imgW, $y0 / $imgH, ($x1 - $x0) / $imgW, ($y1 - $y0) / $imgH) + "\`t" + $line.Text)
}`;
  return ps(script, { timeout: 20000 });
}

// ---------------------------------------------------------------- localhost:3000 → the project serving it

// Windows has no public way to read another process's working folder, so this looks at the listening
// process's command line (and its parent's): dev servers nearly always name a file inside the project.
export async function listenerCommandLines(port) {
  const script = `$ids = @(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$out = @()
foreach ($id in $ids) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
  $out += [pscustomobject]@{ pid = [int]$id; commandLine = $p.CommandLine; parent = $(if ($parent) { $parent.CommandLine } else { '' }) }
}
ConvertTo-Json -Compress -InputObject @($out)`;
  const r = await ps(script, { timeout: 8000 });
  try { const v = JSON.parse(r.out.trim() || '[]'); return Array.isArray(v) ? v : [v]; } catch { return []; }
}

// Absolute paths named on a command line, as folders: "D:\shop\node_modules\vite\bin\vite.js" → D:\shop\node_modules\vite\bin.
export function foldersIn(commandLine = '') {
  const out = [];
  for (const m of String(commandLine || '').matchAll(/"([^"]+)"|(\S+)/g)) {
    let p = (m[1] || m[2] || '').replace(/^--?[\w-]+=/, '');
    if (!/^[a-z]:[\\/]/i.test(p) || /^[a-z]:[\\/](windows|program files)/i.test(p)) continue;
    if (/\.[a-z0-9]{1,5}$/i.test(path.basename(p))) p = path.dirname(p);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- a console window running claude

function findOnPath(names) {
  for (const d of String(process.env.PATH || '').split(';').filter(Boolean)) {
    for (const n of names) { const f = path.join(d.replace(/"/g, ''), n); if (existsSync(f)) return f; }
  }
  return null;
}

// `start` opens a new console (Windows Terminal, when that is the default terminal) in the repo, where
// lib/launch-claude.mjs reads the prompt file and runs claude with it: no prompt text passes through cmd.
export function launchClaudeWindow({ repo, promptFile, title = 'Claude' }) {
  const node = findOnPath(['node.exe']);
  if (!node) return Promise.resolve({ ok: false, how: 'node.exe is not on PATH' });
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launch-claude.mjs');
  const q = s => `"${String(s).replace(/"/g, '')}"`;
  const cmdline = `/d /s /c "start ${q(title)} /D ${q(repo)} ${q(node)} ${q(launcher)} ${q(promptFile)}"`;
  return new Promise(resolve => {
    try {
      const child = spawn('cmd.exe', [cmdline], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' });
      child.on('error', e => resolve({ ok: false, how: e.message }));
      child.on('exit', code => resolve({ ok: code === 0, how: code === 0 ? 'a new console window' : `start exited with ${code}` }));
      child.unref();
    } catch (e) { resolve({ ok: false, how: e.message }); }
  });
}
