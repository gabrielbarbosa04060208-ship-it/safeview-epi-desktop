// postprocessing.ts — V31
//
// Bugs corrigidos:
//   V31: Arquivo reescrito de forma legível (estava minificado).
//   V31: NMS IoU threshold para Vest reduzido: 0.50 → 0.42
//        (elimina duplicatas de colete mais agressivamente)
//   V31: MIN_AREA_THRESHOLD para Vest via classe: 800 em vez de 500
//        (evita detecções minúsculas de colete = ruído de compressão)

import { CLASS_NAMES, MIN_AREA_THRESHOLD, MODEL_SIZE } from "./constants";
import type { Detection, PPEConfig } from "./types";
import { getClassConfig } from "./config";

// ── Classes que se beneficiam de multi-scale (região da cabeça) ──────────────
export const HEAD_PPE_CLASSES = new Set(["Helmet", "Glass", "Mask", "Ear-protection"]);

// IoU threshold por classe para soft-NMS
// Vest reduzido de 0.50 para 0.42: coletes quase sobrepostos são o mesmo objeto
const CLASS_IOU_THRESHOLDS: Record<string, number> = {
  Boots:            0.50,
  "Ear-protection": 0.45,
  Glass:            0.45,
  Glove:            0.45,
  Helmet:           0.50,
  Mask:             0.45,
  Person:           0.55,
  Vest:             0.42,  // V31: reduzido de 0.50 — NMS mais agressivo para colete
};

// Área mínima por classe (em pixels do modelo 640×640, area = w×h)
// Vest tem threshold maior: evita detecções minúsculas de roupa = ruído
const MIN_AREA_BY_CLASS: Record<string, number> = {
  Vest:   800,   // V31: ~28×28px mínimo para colete (antes: 500 para todos)
};

function iou(a: Detection, b: Detection): number {
  const ax1 = a.x - a.w / 2, ay1 = a.y - a.h / 2;
  const ax2 = a.x + a.w / 2, ay2 = a.y + a.h / 2;
  const bx1 = b.x - b.w / 2, by1 = b.y - b.h / 2;
  const bx2 = b.x + b.w / 2, by2 = b.y + b.h / 2;

  const interW = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const interH = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter  = interW * interH;

  return inter / (a.w * a.h + b.w * b.h - inter + 1e-6);
}

function softNms(detections: Detection[]): Detection[] {
  const dets = detections.map(d => ({ ...d }));
  dets.sort((a, b) => b.confidence - a.confidence);
  const result: Detection[] = [];

  while (dets.length > 0) {
    const best = dets.shift()!;
    result.push(best);

    const iouThreshold = CLASS_IOU_THRESHOLDS[best.className] ?? 0.50;
    const sigma        = 0.35;  // Gaussian penalty factor

    for (const det of dets) {
      if (det.classId !== best.classId) continue;
      const overlap = iou(best, det);
      if (overlap > iouThreshold) {
        // Penalidade Gaussiana: score decai com overlap, não corte abrupto
        det.confidence *= Math.exp(-(overlap * overlap) / sigma);
      }
    }

    // Remover detecções com score muito baixo após penalidade
    for (let i = dets.length - 1; i >= 0; i--) {
      if (dets[i].confidence < 0.12) dets.splice(i, 1);
    }
  }

  return result;
}

export function parseOutput(
  data:          Float32Array,
  numDetections: number,
  config?:       PPEConfig
): Detection[] {
  const numClasses = CLASS_NAMES.length;

  // Pré-computar thresholds e flags de habilitação por classe
  const thresholds = new Float32Array(numClasses);
  const enabled    = new Uint8Array(numClasses);

  for (let c = 0; c < numClasses; c++) {
    const className = CLASS_NAMES[c];
    if (config) {
      const cc = getClassConfig(config, className);
      thresholds[c] = cc ? cc.confidence : 0.25;
      enabled[c]    = cc?.enabled ? 1 : 0;
    } else {
      thresholds[c] = 0.25;
      enabled[c]    = 1;
    }
  }

  const detections: Detection[] = [];

  for (let i = 0; i < numDetections; i++) {
    const cx = data[i];
    const cy = data[numDetections + i];
    const w  = data[2 * numDetections + i];
    const h  = data[3 * numDetections + i];

    // Filtrar por área mínima global
    if (w * h < MIN_AREA_THRESHOLD) continue;

    // Achar classe de maior confiança
    let maxConf = 0;
    let maxIdx  = 0;
    for (let c = 0; c < numClasses; c++) {
      const conf = data[(4 + c) * numDetections + i];
      if (conf > maxConf) { maxConf = conf; maxIdx = c; }
    }

    if (!enabled[maxIdx] || maxConf < thresholds[maxIdx]) continue;

    // V31: filtro de área por classe (Vest tem limiar maior)
    const className    = CLASS_NAMES[maxIdx];
    const classMinArea = MIN_AREA_BY_CLASS[className] ?? MIN_AREA_THRESHOLD;
    if (w * h < classMinArea) continue;

    detections.push({ classId: maxIdx, className, confidence: maxConf, x: cx, y: cy, w, h });
  }

  return softNms(detections);
}

// ── Multi-Scale: remap de coordenadas crop → frame completo ─────────────────
//
// Fluxo de coordenadas:
//   1. Detecção em crop model space (640×640 do crop)
//   2. → Undo letterbox do crop → posição em pixels do crop
//   3. → Offset pela posição do crop no vídeo → pixels no vídeo completo
//   4. → Apply letterbox do frame completo → full-frame model space (640×640)
//
// Resultado: detecção comparável às do frame completo, pode ser merged + NMS.

export function remapCropDetections(
  detections: Detection[],
  cropX: number, cropY: number, cropW: number, cropH: number,
  videoW: number, videoH: number
): Detection[] {
  // Parâmetros do letterbox do crop
  const cropScale = Math.min(MODEL_SIZE / cropW, MODEL_SIZE / cropH);
  const cropDx    = (MODEL_SIZE - cropW * cropScale) / 2;
  const cropDy    = (MODEL_SIZE - cropH * cropScale) / 2;

  // Parâmetros do letterbox do frame completo
  const fullScale = Math.min(MODEL_SIZE / videoW, MODEL_SIZE / videoH);
  const fullDx    = (MODEL_SIZE - videoW * fullScale) / 2;
  const fullDy    = (MODEL_SIZE - videoH * fullScale) / 2;

  return detections.map(det => {
    // Crop model space → pixels no vídeo
    const vidX = (det.x - cropDx) / cropScale + cropX;
    const vidY = (det.y - cropDy) / cropScale + cropY;
    const vidW = det.w / cropScale;
    const vidH = det.h / cropScale;

    // Pixels no vídeo → full-frame model space
    return {
      ...det,
      x: vidX * fullScale + fullDx,
      y: vidY * fullScale + fullDy,
      w: vidW * fullScale,
      h: vidH * fullScale,
    };
  });
}

/**
 * Merge detecções de duas escalas e aplica NMS para deduplicar.
 * Detecções do crop que conflitam com detecções do frame completo
 * são resolvidas pela soft-NMS (a de maior confiança prevalece).
 */
export function mergeMultiScaleDetections(
  fullFrameDets: Detection[],
  cropDets: Detection[]
): Detection[] {
  // Filtrar crop dets para manter apenas classes head-PPE
  const headDets = cropDets.filter(d => HEAD_PPE_CLASSES.has(d.className));
  return softNms([...fullFrameDets, ...headDets]);
}
