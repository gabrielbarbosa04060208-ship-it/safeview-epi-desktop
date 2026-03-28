// SafeView EPI Desktop — electron/main.js — V2
// Gabriel Madureira — github.com/gabrielbarbosa04060208-ship-it
'use strict';

const { app, BrowserWindow, ipcMain, Menu, protocol } = require('electron');
const path = require('path');
const fs   = require('fs');

const ICON_PATH = path.join(__dirname, 'icon.ico');
const DIST_DIR  = path.join(__dirname, '..', 'apps', 'safeviewepi', 'dist');

// ── MIME types ────────────────────────────────────────────────────────────────
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html':  'text/html',
    '.js':    'text/javascript',
    '.mjs':   'text/javascript',
    '.css':   'text/css',
    '.json':  'application/json',
    '.wasm':  'application/wasm',
    '.svg':   'image/svg+xml',
    '.png':   'image/png',
    '.jpg':   'image/jpeg',
    '.jpeg':  'image/jpeg',
    '.ico':   'image/x-icon',
    '.task':  'application/octet-stream',
    '.onnx':  'application/octet-stream',
    '.ts':    'application/octet-stream',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Headers com COOP + COEP ───────────────────────────────────────────────────
// Estes headers habilitam crossOriginIsolated = true no renderer.
// Efeito direto: ort.env.wasm.numThreads usa múltiplas threads WASM (SIMD multi-thread).
// Sem COOP + COEP: ONNX cai para 1 thread; inferência ~3-4x mais lenta.
function buildHeaders(mimeType) {
  return {
    'Content-Type':                 [mimeType],
    'Cross-Origin-Opener-Policy':   ['same-origin'],
    'Cross-Origin-Embedder-Policy': ['require-corp'],
    'Cross-Origin-Resource-Policy': ['cross-origin'],
    'Cache-Control':                ['no-cache'],
  };
}

// ── BUG FIX #1: registerSchemesAsPrivileged ANTES de app.whenReady() ─────────
// OBRIGATÓRIO para que fetch() funcione no scheme 'app://'.
// Se chamado depois de whenReady(), o Electron ignora silenciosamente — fetch falha.
// supportFetchAPI: true  → ort.env.wasm / MediaPipe conseguem fetch('app://...')
// corsEnabled: true      → sem erros de CORS ao carregar WASM cross-origin
// bypassCSP: true        → necessário para eval() do WASM JIT compiler
// standard: true         → trata como URL standard (resolve paths relativos)
// secure: true           → equiparado a HTTPS para efeitos de segurança
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard:            true,
    secure:              true,
    supportFetchAPI:     true,
    corsEnabled:         true,
    bypassCSP:           true,
    allowServiceWorkers: true,
  },
}]);

// ── BUG FIX #2: protocol.handle() em vez de registerBufferProtocol ────────────
// registerBufferProtocol foi deprecated no Electron 25; protocol.handle() é a API nova.
// Serve arquivos de dist/ com os headers COOP+COEP injetados.
//
// Mapeamento de URL:
//   app://app/index.html          → dist/index.html
//   app://app/assets/main.js      → dist/assets/main.js
//   app://app/best.onnx           → dist/best.onnx
//   app://app/mediapipe-wasm/...  → dist/mediapipe-wasm/...
//   app://app/models/pose*.task   → dist/models/pose_landmarker_lite.task
//   app://app/ort-wasm-simd*.wasm → dist/ort-wasm-simd*.wasm

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      urlPath = '/index.html';
    }

    // '/' ou vazio → serve index.html (SPA entry point)
    if (!urlPath || urlPath === '/') urlPath = '/index.html';

    // Remove leading slash para path.join seguro
    const relativePath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
    const filePath     = path.join(DIST_DIR, relativePath);

    // Lê o arquivo e retorna Response com headers COOP/COEP
    try {
      const data     = fs.readFileSync(filePath);
      const mimeType = getMimeType(filePath);
      return new Response(data, {
        status:  200,
        headers: buildHeaders(mimeType),
      });
    } catch {
      // Arquivo não encontrado → serve index.html (HashRouter trata a rota no client)
      try {
        const indexData = fs.readFileSync(path.join(DIST_DIR, 'index.html'));
        return new Response(indexData, {
          status:  200,
          headers: buildHeaders('text/html'),
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  });
}

// ── Janela principal ──────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    800,
    minWidth:  900,
    minHeight: 600,
    frame:     true,           // frame nativo do SO — arrastável sem TitleBar custom
    autoHideMenuBar: true,
    icon:      ICON_PATH,
    show:      false,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload:                     path.join(__dirname, 'preload.js'),
      nodeIntegration:             false,
      contextIsolation:            true,
      webSecurity:                 false,  // necessário: WASM local + custom protocol
      allowRunningInsecureContent: true,
    },
  });

  Menu.setApplicationMenu(null);

  // Carrega via protocolo app://app/ — COOP/COEP aplicados no handler
  mainWindow.loadURL('app://app/index.html');

  // F12 → DevTools (debug em campo)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Ciclo de vida ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC: controles de janela ──────────────────────────────────────────────────
ipcMain.on('window-minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});

ipcMain.handle('window-maximize-toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  return win.isMaximized();
});

ipcMain.handle('window-is-maximized', (e) => {
  return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false;
});

ipcMain.on('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});
