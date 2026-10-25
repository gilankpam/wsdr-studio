// SPDX-License-Identifier: GPL-2.0-only
// wsdr-studio desktop shell. Starts the backend (wsdr-studiod --ui-pipe), which answers on stdout with
// one JSON line {port, token[, attached]}, then shows http://127.0.0.1:PORT/ in a window locked to that
// origin. The page gets the token from the preload over IPC. Closing the window quits; the backend is
// stopped by closing its stdin (it then finalises any recording and exits).
//
// Backend options given to the app are passed on: --pid --freq --rate --record-dir --fft --port, --no-usb3.
// --dual opens the window in dual-adapter mode.
// WSDR_STUDIOD: the backend binary. WSDR_DEV_URL: load this URL instead (Vite dev server).
'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PASS = new Set(['--pid', '--freq', '--rate', '--record-dir', '--fft', '--port']);
const PASS_FLAGS = new Set(['--no-usb3']);

let backend = null; // child process (null when attached to an instance started elsewhere)
let quitting = false;
let win = null;
let origin = '';
let token = '';

function backendArgs() {
  const out = ['--ui-pipe'];
  const argv = process.argv.slice(app.isPackaged ? 1 : 2);
  for (let i = 0; i < argv.length; i++) {
    const [k, inline] = argv[i].split(/=(.*)/s, 2);
    if (PASS_FLAGS.has(argv[i])) {
      out.push(argv[i]);
      continue;
    }
    if (!PASS.has(k)) continue;
    const v = inline ?? (argv[i + 1]?.startsWith('--') ? undefined : argv[++i]);
    if (v !== undefined) out.push(k, v);
  }
  if (process.env.WSDR_DEV_URL) out.push('--dev-origin', new URL(process.env.WSDR_DEV_URL).origin);
  return out;
}

function fail(title, detail) {
  if (quitting) return;
  quitting = true;
  dialog.showErrorBox(title, detail);
  app.exit(1);
}

// Start the backend and wait for its {port, token} line.
function startBackend() {
  // AppDir: usr/lib/wsdr-studio/electron/resources -> usr/bin
  const exe = process.env.WSDR_STUDIOD || path.join(process.resourcesPath, '..', '..', '..', '..', 'bin', 'wsdr-studiod');
  const args = backendArgs();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => finish(new Error('the backend did not start within 15 s')), 15000);
    function finish(e, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) {
        child.kill(); // a backend stuck before answering must not keep the adapter
        reject(e);
      } else resolve(v);
    }
    child.on('error', (e) => finish(new Error(`cannot run ${exe}: ${e.message}`)));
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      err = (err + d).slice(-4000);
    });
    const onOut = (d) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl < 0) return out.length > 4096 ? finish(new Error('unexpected backend output')) : undefined;
      child.stdout.off('data', onOut); // only the first line matters; drain the rest
      child.stdout.resume();
      let info;
      try {
        info = JSON.parse(out.slice(0, nl));
      } catch {
        info = null;
      }
      if (!info || !Number.isInteger(info.port) || typeof info.token !== 'string')
        return finish(new Error(`unexpected backend output: ${out.slice(0, 200)}`));
      const ignored = info.attached && args.some((a) => PASS.has(a)); // options for a backend we did not start
      finish(null, { child: info.attached ? null : child, port: info.port, token: info.token, pid: info.pid, ignored });
    };
    child.stdout.on('data', onOut);
    // 'close', not 'exit': it comes after stdout/stderr are drained (an attaching backend prints its
    // line and exits at once; 'exit' may arrive before that line does)
    child.on('close', (code, sig) => {
      if (!done) return finish(new Error(`the backend exited (${sig ?? code})\n\n${err.trim()}`));
      if (backend === child && !quitting) fail('wsdr-studio stopped', `The backend exited (${sig ?? code}).\n\n${err.trim()}`);
      if (backend === child) app.quit();
    });
  });
}

const sameOrigin = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

function lockDown(wc) {
  // every frame, every navigation and redirect: only within the app's origin
  wc.on('will-frame-navigate', (e) => {
    if (!sameOrigin(e.url)) e.preventDefault();
  });
  wc.on('will-redirect', (e) => {
    if (!sameOrigin(e.url)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    title: 'wsdr-studio',
    backgroundColor: '#0b0e13',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // (lockDown: via 'web-contents-created', like every web contents)
  // The page asks before closing while recording (beforeunload); confirm here.
  win.webContents.on('will-prevent-unload', (e) => {
    const c = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Keep recording', 'Quit and save'],
      defaultId: 0,
      cancelId: 0,
      message: 'A recording is running',
      detail: 'Quitting ends the recording; the file is saved.',
    });
    if (c === 1) e.preventDefault(); // = unload anyway
  });
  win.on('closed', () => (win = null));
  // --dual: open in dual-adapter mode (the page reads ?dual=1 once and remembers it)
  const q = process.argv.includes('--dual') ? '?dual=1' : '';
  win.loadURL((process.env.WSDR_DEV_URL || `${origin}/`) + q);
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running one gets 'second-instance' and shows its window
} else {
  app.on('second-instance', () => {
    if (!win) {
      if (quitting)
        dialog.showMessageBox({ type: 'info', message: 'wsdr-studio is still closing (saving a recording)', detail: 'Start it again in a moment.' });
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // No permissions except writing the clipboard ("Copy path").
    const allow = (perm) => perm === 'clipboard-sanitized-write';
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allow(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allow(perm));
    let b;
    try {
      b = await startBackend();
    } catch (e) {
      return fail('wsdr-studio could not start', e.message);
    }
    backend = b.child;
    origin = `http://127.0.0.1:${b.port}`;
    if (!backend && Number.isInteger(b.pid)) {
      // attached to a backend started elsewhere: notice when it goes away (or its pid is reused)
      const watch = setInterval(() => {
        try {
          if (fs.readFileSync(`/proc/${b.pid}/comm`, 'utf8').trim() !== 'wsdr-studiod') throw new Error('gone');
        } catch {
          clearInterval(watch);
          fail('wsdr-studio stopped', `The running wsdr-studiod (pid ${b.pid}) this window was using has exited.`);
        }
      }, 2000);
      if (b.ignored)
        dialog.showMessageBox({
          type: 'info',
          message: 'wsdr-studiod was already running',
          detail: 'This window uses it; the command-line options were not applied.',
        });
    }
    token = b.token;
    const pageOrigin = process.env.WSDR_DEV_URL ? new URL(process.env.WSDR_DEV_URL).origin : origin;
    ipcMain.handle('wsdr:session', (e) => {
      if (!e.senderFrame || new URL(e.senderFrame.url).origin !== pageOrigin) throw new Error('not allowed');
      return { token };
    });
    if (process.env.WSDR_DEV_URL) origin = pageOrigin; // navigation lock follows the page
    createWindow();
  });

  app.on('web-contents-created', (_e, wc) => lockDown(wc));
  app.on('window-all-closed', () => app.quit());

  // Stop the backend gracefully (stdin EOF), give a recording time to be finalised, then exit.
  app.on('will-quit', (e) => {
    quitting = true;
    if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
    e.preventDefault();
    const child = backend;
    backend = null;
    const kill = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.once('exit', () => {
      clearTimeout(kill);
      app.exit(0);
    });
    child.stdin.end();
  });
}
