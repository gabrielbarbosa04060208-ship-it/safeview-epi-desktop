// PATCH: vite.config.ts — V2
// Correção crítica: base: './'
// Vite padrão gera paths absolutos (/assets/x.js) — não existem em app:// ou file://.
// Com base: './', os assets ficam ./assets/x.js — relativo ao HTML. Funciona em ambos.
//
// assetsInclude: inclui .onnx/.task/.wasm como static assets (Vite 5 não os inclui por padrão).
// NOTA: os arquivos .wasm do onnxruntime-web e do MediaPipe são copiados para public/
// pelo setup.bat — Vite os propaga para dist/ automaticamente via cópia de public/.
// O best.onnx já está em public/ no repositório original.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  assetsInclude: ['**/*.onnx', '**/*.task', '**/*.wasm'],
  build: {
    // Garante que arquivos grandes (ONNX ~N MB) não sejam inlinados como base64
    assetsInlineLimit: 0,
  },
});
