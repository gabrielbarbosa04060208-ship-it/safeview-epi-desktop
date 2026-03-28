// PATCH: src/lib/ppe/model.ts — V30
// Fix B2: numThreads condicional baseado em crossOriginIsolated.
//   - main.js envia COOP/COEP → crossOriginIsolated = true no renderer
//   - setup.bat copia ort-wasm-simd-threaded.mjs → multi-thread disponível
//   - Anteriormente numThreads=1 estava hardcoded → perdíamos 3-4x de performance
//   - Agora: se crossOriginIsolated=true, usamos min(hardwareConcurrency, 4) threads
//           se false, fallback para 1 thread (safe para ambientes sem isolamento)
// Fix: numThreads forçado para 1 era necessário antes de V21 (sem .mjs threaded).
//      Desde V21+ o setup.bat copia o .mjs; desde V22+ COOP/COEP estão ativos.

import * as ort from "onnxruntime-web/wasm";
import { MODEL_SIZE } from "./constants";

function resolveDistPath(relativePath: string): string {
  return new URL(relativePath, window.location.href).href;
}

// wasmPaths aponta para dist/ onde os .wasm foram copiados pelo setup.bat
ort.env.wasm.wasmPaths = resolveDistPath('./');

// B2 FIX: usar multi-thread quando crossOriginIsolated = true (COOP/COEP ativos)
// crossOriginIsolated é true quando main.js serve os headers corretos.
// ort-wasm-simd-threaded.mjs está em dist/ desde o setup.bat V21+.
const canUseThreads =
  typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

ort.env.wasm.numThreads = canUseThreads
  ? Math.min(navigator.hardwareConcurrency || 4, 4)
  : 1;

ort.env.wasm.simd  = true;
ort.env.wasm.proxy = false;

let session: ort.InferenceSession | null = null;

const PIXEL_COUNT = MODEL_SIZE * MODEL_SIZE;
const INPUT_SIZE  = 3 * PIXEL_COUNT;
let inputBuffer:    Float32Array | null = null;
let preprocessCanvas: OffscreenCanvas | null = null;
let preprocessCtx:  OffscreenCanvasRenderingContext2D | null = null;

function getPreprocessCanvas(): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  if (!preprocessCanvas) {
    preprocessCanvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
    preprocessCtx    = preprocessCanvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    }) as OffscreenCanvasRenderingContext2D;
  }
  return { canvas: preprocessCanvas, ctx: preprocessCtx! };
}

function getInputBuffer(): Float32Array {
  if (!inputBuffer) inputBuffer = new Float32Array(INPUT_SIZE);
  return inputBuffer;
}

export async function loadModel(): Promise<void> {
  const modelUrl    = resolveDistPath('./best.onnx');
  const response    = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Falha ao carregar modelo: HTTP ${response.status}`);
  const modelBuffer = await response.arrayBuffer();

  session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders:     ["wasm"],
    graphOptimizationLevel: "all",
    enableCpuMemArena:      true,
    enableMemPattern:       true,
  });

  // Warm-up: pré-compila kernels JIT
  const warmupData   = getInputBuffer();
  const warmupTensor = new ort.Tensor("float32", warmupData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  await session.run({ [session.inputNames[0]]: warmupTensor });

  console.log(
    `[ONNX] Carregado | threads: ${ort.env.wasm.numThreads} | crossOriginIsolated: ${typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'N/A'}`
  );
}

export function isModelLoaded(): boolean {
  return session !== null;
}

function preprocessFrame(video: HTMLVideoElement): Float32Array {
  const { ctx }  = getPreprocessCanvas();
  const float32  = getInputBuffer();

  const scale = Math.min(MODEL_SIZE / video.videoWidth, MODEL_SIZE / video.videoHeight);
  const nw    = Math.round(video.videoWidth  * scale);
  const nh    = Math.round(video.videoHeight * scale);
  const dx    = (MODEL_SIZE - nw) / 2;
  const dy    = (MODEL_SIZE - nh) / 2;

  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.drawImage(video, dx, dy, nw, nh);

  const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const pixels    = imageData.data;
  const planeG    = PIXEL_COUNT;
  const planeB    = PIXEL_COUNT * 2;
  const inv255    = 1 / 255;

  for (let i = 0, j = 0; i < PIXEL_COUNT; i++, j += 4) {
    float32[i]          = pixels[j]     * inv255;
    float32[planeG + i] = pixels[j + 1] * inv255;
    float32[planeB + i] = pixels[j + 2] * inv255;
  }

  return float32;
}

export async function runInference(
  video: HTMLVideoElement
): Promise<{ data: Float32Array; numDetections: number }> {
  if (!session) throw new Error("Modelo não carregado");

  const inputData    = preprocessFrame(video);
  const tensor       = new ort.Tensor("float32", inputData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const results      = await session.run({ [session.inputNames[0]]: tensor });
  const outputTensor = results[session.outputNames[0]];
  const data         = outputTensor.data as Float32Array;
  const dims         = outputTensor.dims as number[];

  return { data, numDetections: dims[2] };
}

// ── Multi-Scale Inference — crop de região para EPIs pequenos ───────────────
//
// Problema: No letterbox 640×640 de frame inteiro, EPIs pequenos na cabeça
//   (óculos, proteção auricular, máscara) ficam com ~15-20 pixels — no limite
//   do YOLO. Detecções ficam inconsistentes ou com baixa confiança.
//
// Solução: Extrair crop da região da cabeça (expandida 1.5x), resize para
//   640×640 e rodar segunda inferência ONNX. Isso efetivamente triplica a
//   resolução para EPIs na cabeça.
//
// As coordenadas retornadas estão no espaço do CROP (640×640 model space).
// O chamador deve remapear para o espaço do frame completo.

let cropCanvas: OffscreenCanvas | null = null;
let cropCtx: OffscreenCanvasRenderingContext2D | null = null;
let cropInputBuffer: Float32Array | null = null;

function getCropCanvas(): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  if (!cropCanvas) {
    cropCanvas = new OffscreenCanvas(MODEL_SIZE, MODEL_SIZE);
    cropCtx    = cropCanvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    }) as OffscreenCanvasRenderingContext2D;
  }
  return { canvas: cropCanvas, ctx: cropCtx! };
}

function getCropInputBuffer(): Float32Array {
  if (!cropInputBuffer) cropInputBuffer = new Float32Array(INPUT_SIZE);
  return cropInputBuffer;
}

/**
 * Roda inferência ONNX em uma região recortada do vídeo.
 *
 * @param video - fonte do vídeo
 * @param cropX - X do canto superior esquerdo do crop (pixels do vídeo)
 * @param cropY - Y do canto superior esquerdo do crop (pixels do vídeo)
 * @param cropW - largura do crop (pixels do vídeo)
 * @param cropH - altura do crop (pixels do vídeo)
 *
 * Retorna detecções em model space do crop (640×640). O chamador é
 * responsável por remapear coordenadas para o frame completo.
 */
export async function runInferenceOnCrop(
  video: HTMLVideoElement,
  cropX: number, cropY: number, cropW: number, cropH: number
): Promise<{ data: Float32Array; numDetections: number }> {
  if (!session) throw new Error("Modelo não carregado");

  const { ctx } = getCropCanvas();
  const float32 = getCropInputBuffer();

  // Letterbox do crop dentro de 640×640
  const scale = Math.min(MODEL_SIZE / cropW, MODEL_SIZE / cropH);
  const nw    = Math.round(cropW * scale);
  const nh    = Math.round(cropH * scale);
  const dx    = (MODEL_SIZE - nw) / 2;
  const dy    = (MODEL_SIZE - nh) / 2;

  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  // drawImage com source rect: extrai crop do vídeo
  ctx.drawImage(video, cropX, cropY, cropW, cropH, dx, dy, nw, nh);

  const imageData = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE);
  const pixels    = imageData.data;
  const planeG    = PIXEL_COUNT;
  const planeB    = PIXEL_COUNT * 2;
  const inv255    = 1 / 255;

  for (let i = 0, j = 0; i < PIXEL_COUNT; i++, j += 4) {
    float32[i]          = pixels[j]     * inv255;
    float32[planeG + i] = pixels[j + 1] * inv255;
    float32[planeB + i] = pixels[j + 2] * inv255;
  }

  const tensor       = new ort.Tensor("float32", float32, [1, 3, MODEL_SIZE, MODEL_SIZE]);
  const results      = await session.run({ [session.inputNames[0]]: tensor });
  const outputTensor = results[session.outputNames[0]];
  const data         = outputTensor.data as Float32Array;
  const dims         = outputTensor.dims as number[];

  return { data, numDetections: dims[2] };
}
