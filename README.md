# SafeView EPI Desktop V33

Aplicativo desktop Windows para deteccao de EPIs em tempo real via webcam.
Funciona 100% offline apos a instalacao.

## Requisitos
- Windows 10 ou 11 (64-bit)
- Node.js 18+ (https://nodejs.org)
- best.onnx na pasta apps/safeviewepi/public/

## Instalacao rapida

1. Execute setup.bat como Administrador (best.onnx ja incluso)
3. O instalador sera aberto automaticamente ao final

## Estrutura

    SafeView-EPI-Desktop-V5/
    apps/safeviewepi/     - Codigo-fonte React + best.onnx (pre-populados)
    electron/             - Shell Electron (main.js, preload.js, icon.ico)
    patches/              - Patches aplicados ao app (referencia)
    setup.bat             - Script de instalacao automatizado
    package.json          - Config Electron + electron-builder

## O que o setup.bat faz

[1/6] npm install --legacy-peer-deps (dependencias React)
[2/6] Copia ONNX WASM para public/
[3/6] Copia MediaPipe WASM para public/mediapipe-wasm/
[4/6] Baixa modelo pose_landmarker_lite.task (~3MB)
[5/6] npm install (Electron) + build completo
[6/6] Abre o instalador .exe

## Autor: Gabriel Madureira | 2026
