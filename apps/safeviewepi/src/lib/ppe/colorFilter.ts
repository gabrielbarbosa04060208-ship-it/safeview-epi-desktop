// colorFilter.ts — V31
//
// FALSO POSITIVO DE VEST — ANÁLISE E FIX:
//
// SINTOMA: Pessoa distante (corpo inteiro) → Vest detectado incorretamente.
//          Pessoa perto (só peito) → ausência detectada corretamente.
//
// ROOT CAUSE (bug da versão anterior):
//   A lógica usava BLACKLIST (rejeitar se tem muita pele):
//     isFalsePositive = skinFraction > 0.45 AND safetyColorFraction < 0.15
//
//   Quando corpo inteiro + roupa comum (azul/preto/cinza):
//     skinFraction ≈ 0.03  → pouca pele visível (longe, bbox pequeno)
//     safetyColorFraction ≈ 0.02  → roupa não é cor de colete
//     → isFalsePositive = false  → detecção PASSA ilegitimamente!
//
// FIX: Mudar para WHITELIST (aceitar SOMENTE se cor de colete confirmada):
//   1. sampleCount == 0 → rejeitar (bbox too small = provável ruído)
//   2. safetyColorFraction >= VEST_POSITIVE_THRESHOLD → aceitar
//   3. skinFraction > SKIN_REJECT_THRESHOLD → rejeitar (pele mascarando colete)
//   4. Padrão → rejeitar (roupa comum sem cor de colete = não é colete)
//
// Classes filtradas por cor: Vest (única com falso positivo cromático documentado)

import { MODEL_SIZE } from "./constants";
import type { Detection } from "./types";

// ── RGB → HSV ─────────────────────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d   = max - min;
  const v   = max;
  const s   = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if      (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else                 h = ((rn - gn) / d + 4) / 6;
  }
  return [h * 360, s, v]; // H: 0–360, S: 0–1, V: 0–1
}

// ── Classificadores ───────────────────────────────────────────────────────────

function isSkinPixel(h: number, s: number, v: number): boolean {
  // Pele humana (tons claros e escuros): H 0–25° ou ≥335°, saturação moderada
  return (h <= 25 || h >= 335) && s >= 0.10 && s <= 0.75 && v >= 0.22 && v <= 0.96;
}

function isSafetyVestColor(h: number, s: number, v: number): boolean {
  // Coletes de segurança padronizados:
  //   Laranja:      H 10–42°,   S > 0.55, V > 0.40
  //   Amarelo:      H 42–75°,   S > 0.45, V > 0.48
  //   Verde-limão:  H 70–135°,  S > 0.48, V > 0.28
  //   Vermelho:     H ≤12° ou ≥348°, S > 0.55, V > 0.38
  //   Branco/prata reflectivo: S < 0.18, V > 0.72
  if (s < 0.18 && v > 0.72)                                 return true;  // reflectivo
  if (h >= 10  && h <= 42  && s > 0.55 && v > 0.40)        return true;  // laranja
  if (h >  42  && h <= 75  && s > 0.45 && v > 0.48)        return true;  // amarelo
  if (h >  70  && h <= 135 && s > 0.48 && v > 0.28)        return true;  // verde-limão
  if ((h <= 12 || h >= 348) && s > 0.55 && v > 0.38)       return true;  // vermelho
  return false;
}

// ── Amostragem do bbox no espaço do vídeo ────────────────────────────────────

const SAMPLE_SIZE = 48;  // 48×48: suficiente para análise de cor, mais rápido que 64×64
let _canvas: OffscreenCanvas | null = null;
let _ctx:    OffscreenCanvasRenderingContext2D | null = null;

function getSampleCtx(): OffscreenCanvasRenderingContext2D {
  if (!_canvas) {
    _canvas = new OffscreenCanvas(SAMPLE_SIZE, SAMPLE_SIZE);
    _ctx    = _canvas.getContext("2d", { willReadFrequently: true, alpha: false }) as OffscreenCanvasRenderingContext2D;
  }
  return _ctx!;
}

interface ColorStats {
  skinFraction:  number;
  vestFraction:  number;
  sampleCount:   number;
  bboxPixelArea: number;  // área do bbox em pixels de vídeo (diagnóstico)
}

function sampleBboxColor(
  video: HTMLVideoElement,
  det:   Detection,
  vW:    number,
  vH:    number
): ColorStats {
  // Converter bbox do espaço do modelo (640×640 letterboxed) para pixels de vídeo
  const scale = Math.min(MODEL_SIZE / vW, MODEL_SIZE / vH);
  const dx    = (MODEL_SIZE - vW * scale) / 2;
  const dy    = (MODEL_SIZE - vH * scale) / 2;

  const cx = (det.x - dx) / scale;          // centro X em pixels de vídeo
  const cy = (det.y - dy) / scale;          // centro Y em pixels de vídeo
  const bw = det.w / scale;                 // largura em pixels de vídeo
  const bh = det.h / scale;                 // altura em pixels de vídeo

  const bboxPixelArea = bw * bh;

  // IMPORTANTE: amostrar a região CENTRAL do bbox (60% da área, margin = 0.20).
  // Bordas são ruidosas e podem incluir fundo/outros objetos.
  // Reduzido de margin=0.25 para 0.20 para capturar mais área interna.
  const margin = 0.20;
  const sx = Math.max(0, cx - bw * (0.5 - margin));
  const sy = Math.max(0, cy - bh * (0.5 - margin));
  const sw = Math.min(vW - sx, bw * (1 - 2 * margin));
  const sh = Math.min(vH - sy, bh * (1 - 2 * margin));

  // Bbox minúsculo: bbox menor que 8×8 pixels de vídeo = ruído, não amostrar
  if (sw < 8 || sh < 8) {
    return { skinFraction: 0, vestFraction: 0, sampleCount: 0, bboxPixelArea };
  }

  const ctx = getSampleCtx();
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const pixels = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
  const total  = SAMPLE_SIZE * SAMPLE_SIZE;

  let skinCount = 0;
  let vestCount = 0;

  for (let i = 0; i < total * 4; i += 4) {
    const [h, s, v] = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (isSkinPixel(h, s, v))        skinCount++;
    if (isSafetyVestColor(h, s, v))  vestCount++;
  }

  return {
    skinFraction:  skinCount / total,
    vestFraction:  vestCount / total,
    sampleCount:   total,
    bboxPixelArea,
  };
}

// ── Thresholds de decisão ─────────────────────────────────────────────────────

// VEST_POSITIVE_THRESHOLD: mínimo de pixels com cor de colete para ACEITAR.
// 0.10 = 10% → conservador o suficiente para coletes parcialmente cobertos/mal iluminados.
// Muito abaixo disso = cor de colete insuficiente = provavelmente não é colete.
const VEST_POSITIVE_THRESHOLD = 0.10;

// SKIN_REJECT_THRESHOLD: máximo de pixels de pele para aceitar.
// Se houver muita pele, mesmo que algo tenha cor de colete, é suspeito.
// 0.38 = 38% → rejeita se mais de 1/3 são pele.
const SKIN_REJECT_THRESHOLD = 0.38;

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Filtra falsos positivos de "Vest" por análise de cor HSV.
 *
 * LÓGICA CORRIGIDA (whitelist):
 *   1. sampleCount == 0  → REJEITAR (bbox minúsculo = ruído)
 *   2. vestFraction >= VEST_POSITIVE_THRESHOLD  → ACEITAR (cor de colete confirmada)
 *   3. skinFraction > SKIN_REJECT_THRESHOLD  → REJEITAR (muita pele)
 *   4. Padrão → REJEITAR (roupa comum sem cor de colete = não é colete)
 *
 * Isto corrige o bug onde roupas comuns (azul/preto) passavam o filtro antigo
 * (que só rejeitava pele, não exigia cor de colete).
 */
export function applyColorFilter(
  detections: Detection[],
  video: HTMLVideoElement,
  vW: number,
  vH: number
): Detection[] {
  if (vW === 0 || vH === 0) return detections;

  return detections.filter((det) => {
    if (det.className !== "Vest") return true;

    try {
      const stats = sampleBboxColor(video, det, vW, vH);

      // Regra 1: bbox minúsculo (pessoa muito distante ou ruído)
      if (stats.sampleCount === 0) return false;

      // Regra 2 (WHITELIST): tem cor de colete suficiente → aceitar
      if (stats.vestFraction >= VEST_POSITIVE_THRESHOLD) return true;

      // Regra 3: muita pele → rejeitar (pele mascarando colete parcial)
      if (stats.skinFraction > SKIN_REJECT_THRESHOLD) return false;

      // Regra 4 (padrão): sem cor de colete confirmada → rejeitar
      // Aqui entra o caso do corpo inteiro com roupa comum: azul/preto/cinza
      // → skinFraction baixo, vestFraction baixo → REJEITADO corretamente
      return false;

    } catch {
      return true; // erro inesperado: manter detecção por segurança
    }
  });
}

/** Retorna estatísticas para debug overlay */
export function getVestColorStats(
  det:   Detection,
  video: HTMLVideoElement,
  vW:    number,
  vH:    number
): { skin: number; vestColor: number; bboxPx: number } | null {
  if (det.className !== "Vest" || vW === 0 || vH === 0) return null;
  try {
    const s = sampleBboxColor(video, det, vW, vH);
    return { skin: s.skinFraction, vestColor: s.vestFraction, bboxPx: s.bboxPixelArea };
  } catch {
    return null;
  }
}
