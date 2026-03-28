// association.ts — V33
//
// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  POSE-FIRST + TEMPORAL CONFIDENCE FUSION + ADAPTIVE DISTANCE THRESHOLDS    ║
// ║                                                                              ║
// ║  Melhorias implementadas:                                                    ║
// ║    1. Temporal Fusion: smoother usa confiança ponderada com decay             ║
// ║       exponencial em vez de voto binário majoritário. Uma detecção com        ║
// ║       0.92 de confiança "sobrevive" um frame de falha, enquanto uma          ║
// ║       detecção marginal de 0.41 não persiste.                                ║
// ║    2. Adaptive Thresholds: limiar do smoother e gates de associação           ║
// ║       adaptam-se à distância da pessoa (área do bbox como proxy).            ║
// ║       Pessoa perto: thresholds normais. Pessoa longe: thresholds relaxados   ║
// ║       mas exigem consistência temporal para confirmar.                        ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// Fluxo:
//   1. PoseResult (landmarks + bodyRegions + bbox) chega do Index.tsx
//   2. Para cada EPI habilitado no config:
//      a. Obter região anatômica correta (head, torso, hands, feet)
//      b. Buscar no TrackedDetection[] a melhor instância da classe nessa região
//      c. Critério: region_iou >= gate E inside_fraction >= gate (ambos adaptativos)
//   3. Temporal smoother (janela 7 frames, confiança ponderada + decay exponencial)
//   4. Fallback: se sem pose → usar ONNX Person bbox como antes (V27-V31)

import { MODEL_SIZE } from "./constants";
import { getRequiredClasses, getOptionalClasses, getClassConfig } from "./config";
import type {
  TrackedDetection,
  TrackedPerson,
  PPEStatus,
  PPEConfig,
  BodyRegions,
  PoseLandmark,
  PoseResult,
  PersonStatusLevel,
} from "./types";

// ── Temporal Smoother — Confidence-Weighted com Decay Exponencial ───────
//
// Antes (≤V32): armazenava boolean[] e usava voto majoritário (4 de 7 frames).
//   Problema: trata frame com confiança 0.92 igual a frame com confiança 0.41.
//
// Agora: armazena a confiança real (0 se não detectado) e calcula média
//   ponderada com decay exponencial. Frames recentes pesam mais.
//   O limiar de aceitação adapta-se à distância da pessoa.

const SMOOTHER_WINDOW = 7;
const SMOOTHER_DECAY  = 0.85;  // peso decai 15% por frame de idade

// ── Thresholds adaptativos por distância ────────────────────────────────
//
// Usa área do bbox da pessoa (normalizada, 0–1 do frame) como proxy de distância.
// Pessoa perto → bbox grande → threshold mais alto (exige alta confiança).
// Pessoa longe → bbox pequeno → threshold mais baixo (aceita confiança menor,
//   mas a consistência temporal ainda filtra falsos positivos esporádicos).

const DISTANCE_CLOSE_AREA = 0.15;  // > 15% do frame = pessoa próxima
const DISTANCE_FAR_AREA   = 0.04;  // < 4% do frame = pessoa distante

const SMOOTH_THRESHOLD_CLOSE = 0.35;  // perto: exige smoothed confidence alta
const SMOOTH_THRESHOLD_MID   = 0.28;  // distância média (interpolado)
const SMOOTH_THRESHOLD_FAR   = 0.20;  // longe: aceita menor, temporal filtra ruído

// Fator de relaxamento dos gates de associação para pessoa distante
// (bbox pequeno → EPIs com posição menos precisa → gates mais permissivos)
const GATE_RELAX_FAR = 0.65;  // gates multiplicados por 0.65 (35% mais permissivo)

class PPESmoother {
  private history = new Map<string, number[]>();

  /**
   * Atualiza o histórico de confiança para uma classe de EPI e retorna
   * a confiança suavizada e se deve ser considerada "detectada".
   *
   * @param className - classe do EPI (ex: "Helmet", "Vest")
   * @param confidence - confiança da detecção (0 se não detectado neste frame)
   * @param personAreaFraction - área do bbox da pessoa / área do frame (0–1)
   */
  update(
    className: string,
    confidence: number,
    personAreaFraction: number
  ): { smoothed: number; detected: boolean } {
    if (!this.history.has(className)) this.history.set(className, []);
    const frames = this.history.get(className)!;
    frames.push(confidence);
    if (frames.length > SMOOTHER_WINDOW) frames.shift();

    // Média ponderada com decay exponencial: frames recentes pesam mais
    let weightedSum = 0;
    let weightSum   = 0;
    for (let i = 0; i < frames.length; i++) {
      const age    = frames.length - 1 - i;
      const weight = SMOOTHER_DECAY ** age;
      weightedSum += frames[i] * weight;
      weightSum   += weight;
    }

    const smoothed = weightSum > 0 ? weightedSum / weightSum : 0;

    // Threshold adaptativo por distância.
    // Vest usa sempre o threshold de "perto" independente da distância:
    // sem filtro de cor, a distância aumenta FPs e precisamos ser estritos.
    let threshold: number;
    if (className === "Vest" || personAreaFraction >= DISTANCE_CLOSE_AREA) {
      threshold = SMOOTH_THRESHOLD_CLOSE;
    } else if (personAreaFraction <= DISTANCE_FAR_AREA) {
      threshold = SMOOTH_THRESHOLD_FAR;
    } else {
      const t = (personAreaFraction - DISTANCE_FAR_AREA)
              / (DISTANCE_CLOSE_AREA - DISTANCE_FAR_AREA);
      threshold = SMOOTH_THRESHOLD_FAR + t * (SMOOTH_THRESHOLD_CLOSE - SMOOTH_THRESHOLD_FAR);
    }

    return { smoothed, detected: smoothed >= threshold };
  }

  reset(): void { this.history.clear(); }
}

const _smoother = new PPESmoother();
export function resetSmoother(): void { _smoother.reset(); }

const NO_PERSON_RESET_FRAMES = 10;
let _noPersonFrameCount = 0;

// ── Labels ────────────────────────────────────────────────────────────────────

export const PPE_DISPLAY_NAMES: Record<string, string> = {
  Helmet:           "CAPACETE",
  Vest:             "COLETE",
  Glass:            "ÓCULOS",
  Glove:            "LUVAS",
  Boots:            "BOTAS",
  Mask:             "MÁSCARA",
  "Ear-protection": "PROTEÇÃO AURICULAR",
};

const PPE_VIOLATION_LABELS: Record<string, string> = {
  Helmet:           "SEM CAPACETE",
  Vest:             "SEM COLETE",
  Glass:            "SEM ÓCULOS",
  Glove:            "SEM LUVAS",
  Boots:            "SEM BOTAS",
  Mask:             "SEM MÁSCARA",
  "Ear-protection": "SEM PROTEÇÃO AURICULAR",
};

// ── Geometria ─────────────────────────────────────────────────────────────────

function toVideoNorm(
  det: TrackedDetection, vW: number, vH: number
): { cx: number; cy: number; w: number; h: number } {
  const scale = Math.min(MODEL_SIZE / vW, MODEL_SIZE / vH);
  const dx    = (MODEL_SIZE - vW * scale) / 2;
  const dy    = (MODEL_SIZE - vH * scale) / 2;
  return {
    cx: (det.x - dx) / scale / vW,
    cy: (det.y - dy) / scale / vH,
    w:  det.w / scale / vW,
    h:  det.h / scale / vH,
  };
}

function rectIoU(
  acx: number, acy: number, aw: number, ah: number,
  bcx: number, bcy: number, bw: number, bh: number
): number {
  const ix = Math.max(0, Math.min(acx + aw/2, bcx + bw/2) - Math.max(acx - aw/2, bcx - bw/2));
  const iy = Math.max(0, Math.min(acy + ah/2, bcy + bh/2) - Math.max(acy - ah/2, bcy - bh/2));
  return (ix * iy) / (aw*ah + bw*bh - ix*iy + 1e-6);
}

function insideFraction(
  ppeCx: number, ppeCy: number, pW: number, pH: number,
  pCx:   number, pCy:   number, bW: number, bH: number
): number {
  const ix = Math.max(0, Math.min(ppeCx+pW/2, pCx+bW/2) - Math.max(ppeCx-pW/2, pCx-bW/2));
  const iy = Math.max(0, Math.min(ppeCy+pH/2, pCy+bH/2) - Math.max(ppeCy-pH/2, pCy-bH/2));
  const a  = pW * pH;
  return a > 0 ? (ix * iy) / a : 0;
}

// ── Estimativa de bbox a partir de landmarks ──────────────────────────────────

/**
 * Calcula o bounding box da pessoa inteira a partir dos landmarks visíveis.
 * Retorna coordenadas normalizadas (0-1) relativas ao frame.
 */
export function estimateBboxFromLandmarks(
  landmarks: PoseLandmark[]
): { cx: number; cy: number; w: number; h: number } {
  const CONF = 0.25;
  const visible = landmarks.filter(lm => lm.visibility > CONF);

  if (visible.length < 3) {
    // Poucos landmarks — usar bbox conservadora centralizada
    return { cx: 0.5, cy: 0.5, w: 0.4, h: 0.7 };
  }

  const xs = visible.map(lm => lm.x);
  const ys = visible.map(lm => lm.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Padding para incluir extremidades não detectadas (pés fora do frame, etc.)
  const padX = (maxX - minX) * 0.08;
  const padY = (maxY - minY) * 0.05;

  const x1 = Math.max(0, minX - padX);
  const y1 = Math.max(0, minY - padY);
  const x2 = Math.min(1, maxX + padX);
  const y2 = Math.min(1, maxY + padY);

  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    w:  x2 - x1,
    h:  y2 - y1,
  };
}

// ── Gates de associação ───────────────────────────────────────────────────────

// Sobreposição mínima com a região anatômica do pose (valores base para pessoa próxima)
const REGION_IOU_GATE: Record<string, number> = {
  Helmet:           0.10,
  Glass:            0.08,
  Mask:             0.10,
  "Ear-protection": 0.06,
  Vest:             0.20,
  Glove:            0.06,
  Boots:            0.06,
};

// Fração mínima do EPI dentro do bbox da pessoa (valores base para pessoa próxima)
const INSIDE_FRACTION_GATE: Record<string, number> = {
  Helmet:           0.30,
  Glass:            0.25,
  Mask:             0.30,
  "Ear-protection": 0.20,
  Vest:             0.45,
  Glove:            0.08,
  Boots:            0.08,
};

// Classes para as quais NÃO relaxamos gates à distância.
// Vest é a mais propensa a falsos positivos com roupas comuns a distância —
// sem o filtro de cor, relaxar os gates ampliaria esse problema.
const DISTANCE_GATE_STRICT = new Set(["Vest"]);

/**
 * Retorna gate adaptado à distância. Pessoa distante → gate mais permissivo,
 * EXCETO para classes em DISTANCE_GATE_STRICT (ex: Vest), onde o gate
 * base é sempre mantido independente da distância.
 */
function adaptiveGate(baseGate: number, personAreaFraction: number, className: string): number {
  if (DISTANCE_GATE_STRICT.has(className)) return baseGate;
  if (personAreaFraction >= DISTANCE_CLOSE_AREA) return baseGate;
  if (personAreaFraction <= DISTANCE_FAR_AREA)   return baseGate * GATE_RELAX_FAR;
  const t = (personAreaFraction - DISTANCE_FAR_AREA)
          / (DISTANCE_CLOSE_AREA - DISTANCE_FAR_AREA);
  return baseGate * (GATE_RELAX_FAR + t * (1 - GATE_RELAX_FAR));
}

// ── Regiões do bbox (fallback sem pose) ──────────────────────────────────────

type BboxRegions = {
  head:        { x: number; y: number; w: number; h: number };
  torso:       { x: number; y: number; w: number; h: number };
  handsRegion: { x: number; y: number; w: number; h: number };
  feetRegion:  { x: number; y: number; w: number; h: number };
};

function computeBboxRegions(
  cx: number, cy: number, pw: number, ph: number
): BboxRegions {
  const top   = cy - ph / 2;
  const headH = ph * 0.26;
  const torsoH = ph * 0.52;
  return {
    head:        { x: cx, y: top + headH / 2,                 w: pw * 0.56, h: headH    },
    torso:       { x: cx, y: top + headH + torsoH / 2,         w: pw * 0.80, h: torsoH   },
    handsRegion: { x: cx, y: top + ph * 0.69,                 w: pw * 0.90, h: ph * 0.38 },
    feetRegion:  { x: cx, y: top + ph * 0.90,                 w: pw * 0.80, h: ph * 0.20 },
  };
}

// ── Seletor de região ─────────────────────────────────────────────────────────

function getRegion(
  bodyRegion: string,
  pose: BodyRegions | null,
  bbox: BboxRegions
): { x: number; y: number; w: number; h: number } | null {
  switch (bodyRegion) {
    case "head":  return pose?.head   ?? bbox.head;
    case "torso": return pose?.torso  ?? bbox.torso;
    case "hands": return bbox.handsRegion;
    case "feet":  return bbox.feetRegion;
    default:      return null;
  }
}

// ── Geometric Context — validação de coerência geométrica ───────────────────
//
// Verifica se a detecção de EPI tem proporções e posição coerentes com a
// região anatômica. Exemplos:
//   - Helmet deve ter ~50-140% da largura da cabeça
//   - Helmet deve estar ACIMA do centro da cabeça, não abaixo
//   - Vest deve ter largura proporcional ao torso
//   - Glass deve estar na altura dos olhos
//
// Retorna multiplicador 0-1 que penaliza detecções geometricamente incoerentes.

function computeGeometricScore(
  className: string,
  ppeCx: number, ppeCy: number, ppeW: number, ppeH: number,
  region: { x: number; y: number; w: number; h: number },
  poseRegions: BodyRegions | null
): number {
  let score = 1.0;

  if (className === "Helmet") {
    // Proporção: helmet deve ter ~50-140% da largura da região da cabeça
    const widthRatio = ppeW / Math.max(region.w, 0.001);
    if (widthRatio < 0.35 || widthRatio > 2.0) score *= 0.20;
    else if (widthRatio < 0.50 || widthRatio > 1.40) score *= 0.65;

    // Posição vertical: helmet deve estar na metade superior da região da cabeça
    const headBottom = region.y + region.h / 2;
    if (ppeCy > headBottom + region.h * 0.15) score *= 0.15;  // muito abaixo = não é capacete
  }

  if (className === "Vest") {
    const torso = poseRegions?.torso ?? region;
    // Proporção: vest deve cobrir boa parte do torso
    const widthRatio = ppeW / Math.max(torso.w, 0.001);
    if (widthRatio < 0.25 || widthRatio > 2.0) score *= 0.25;
    else if (widthRatio < 0.40 || widthRatio > 1.60) score *= 0.65;

    const heightRatio = ppeH / Math.max(torso.h, 0.001);
    if (heightRatio < 0.15 || heightRatio > 2.0) score *= 0.30;
  }

  if (className === "Glass" || className === "Mask") {
    // Posição vertical: deve estar próximo ao centro da região da cabeça
    const distFromCenter = Math.abs(ppeCy - region.y) / Math.max(region.h, 0.001);
    // Glass: próximo da linha dos olhos (acima do centro). Mask: abaixo do centro.
    const expectedOffset = className === "Glass" ? -0.15 : 0.20;
    const adjustedDist = Math.abs((ppeCy - region.y) / Math.max(region.h, 0.001) - expectedOffset);
    if (adjustedDist > 0.80) score *= 0.25;
    else if (adjustedDist > 0.50) score *= 0.60;

    // Largura: não deve ser muito maior que a cabeça
    const widthRatio = ppeW / Math.max(region.w, 0.001);
    if (widthRatio > 2.0) score *= 0.30;
  }

  return Math.max(score, 0.05);  // floor: nunca zero (permite override por alta IoU)
}

// ── Core: associar EPIs a uma pessoa ─────────────────────────────────────────
//
// Retorna:
//   associated: detecções que passaram nos gates
//   presentRawConf: Map<className, confidence> — confiança real de cada EPI detectado
//     (0 implícito para classes ausentes — não incluídas no Map)

function associatePPE(
  personCx:            number,
  personCy:            number,
  personW:             number,
  personH:             number,
  poseRegions:         BodyRegions | null,
  ppeItems:            TrackedDetection[],
  config:              PPEConfig,
  vW:                  number,
  vH:                  number,
  personAreaFraction:  number
): { associated: TrackedDetection[]; presentRawConf: Map<string, number> } {
  const bbox = computeBboxRegions(personCx, personCy, personW, personH);

  const associated:     TrackedDetection[]    = [];
  const presentRawConf: Map<string, number>   = new Map();

  // Agrupar EPIs por classe e pegar o de maior score por região
  const ppeByClass = new Map<string, TrackedDetection[]>();
  for (const ppe of ppeItems) {
    const cc = getClassConfig(config, ppe.className);
    if (!cc || !cc.enabled) continue;
    if (!ppeByClass.has(ppe.className)) ppeByClass.set(ppe.className, []);
    ppeByClass.get(ppe.className)!.push(ppe);
  }

  for (const [className, ppes] of ppeByClass) {
    const cc = getClassConfig(config, className);
    if (!cc) continue;

    const region = getRegion(cc.bodyRegion, poseRegions, bbox);
    if (!region) continue;

    // Gates adaptativos: pessoa distante → gates relaxados (exceto classes em DISTANCE_GATE_STRICT)
    const riouGate = adaptiveGate(REGION_IOU_GATE[className] ?? 0.08, personAreaFraction, className);
    const fracGate = adaptiveGate(INSIDE_FRACTION_GATE[className] ?? 0.30, personAreaFraction, className);

    let bestPpe:   TrackedDetection | null = null;
    let bestScore  = 0;

    for (const ppe of ppes) {
      const p    = toVideoNorm(ppe, vW, vH);
      const rIoU = rectIoU(p.cx, p.cy, p.w, p.h, region.x, region.y, region.w, region.h);
      if (rIoU < riouGate) continue;

      const frac = insideFraction(p.cx, p.cy, p.w, p.h, personCx, personCy, personW, personH);
      if (frac < fracGate) continue;

      // Aspect ratio check para Vest (V31)
      if (className === "Vest") {
        const ar = p.w / Math.max(p.h, 0.001);
        if (ar < 0.60) continue;
      }

      // Geometric context: penaliza detecções com proporção/posição incoerente
      const geoScore = computeGeometricScore(
        className, p.cx, p.cy, p.w, p.h, region, poseRegions
      );

      // Score final: IoU + fração + contexto geométrico
      const score = rIoU * 0.50 + frac * 0.20 + geoScore * 0.30;
      if (score > bestScore) { bestScore = score; bestPpe = ppe; }
    }

    if (bestPpe) {
      associated.push(bestPpe);
      presentRawConf.set(className, bestPpe.confidence);
    }
  }

  return { associated, presentRawConf };
}

// ── Construir TrackedPerson ───────────────────────────────────────────────────

function buildTrackedPerson(
  trackId:            number,
  personCx:           number,
  personCy:           number,
  personW:            number,
  personH:            number,
  confidence:         number,
  landmarks:          PoseLandmark[] | undefined,
  bodyRegions:        BodyRegions | undefined,
  associated:         TrackedDetection[],
  presentRawConf:     Map<string, number>,
  config:             PPEConfig,
  detectedByPose:     boolean,
  personAreaFraction: number,
  vW:                 number,
  vH:                 number
): TrackedPerson {
  const requiredClasses = getRequiredClasses(config);
  const optionalClasses = getOptionalClasses(config);

  // Temporal smoother com confiança ponderada + threshold adaptativo por distância
  const presentPPE: string[] = [];
  for (const cls of [...requiredClasses, ...optionalClasses]) {
    const conf = presentRawConf.get(cls.name) ?? 0;
    const { detected } = _smoother.update(cls.name, conf, personAreaFraction);
    if (detected) {
      presentPPE.push(cls.name);
    }
  }

  const missingRequired = requiredClasses
    .filter(rc => !presentPPE.includes(rc.name))
    .map(rc => rc.name);
  const missingOptional = optionalClasses
    .filter(oc => !presentPPE.includes(oc.name))
    .map(oc => oc.name);

  let statusLevel: PersonStatusLevel = "SAFE";
  if (missingRequired.length > 0)      statusLevel = "VIOLATION";
  else if (missingOptional.length > 0) statusLevel = "WARNING";

  // Converter bbox normalizado (0-1) de volta para espaço do modelo (para TrackedDetection)
  const scale = Math.min(MODEL_SIZE / vW, MODEL_SIZE / vH);
  const dxM   = (MODEL_SIZE - vW * scale) / 2;
  const dyM   = (MODEL_SIZE - vH * scale) / 2;

  const modelX = personCx * vW * scale + dxM;
  const modelY = personCy * vH * scale + dyM;
  const modelW = personW  * vW * scale;
  const modelH = personH  * vH * scale;

  return {
    trackId,
    classId:    6,         // índice de "Person" no CLASS_NAMES
    className:  "Person",
    confidence,
    x: modelX, y: modelY, w: modelW, h: modelH,
    associatedPPE: associated,
    missingPPE:    missingRequired,
    presentPPE,
    statusLevel,
    landmarks,
    bodyRegions,
    detectedByPose,
  };
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Analisa status de EPI para a pessoa no frame.
 *
 * V33 — Pose-first:
 *   Se `poseResult` fornecido → MediaPipe é a fonte de verdade para presença humana.
 *   ONNX Person é usado apenas como bbox de exibição (se disponível) e fallback.
 *
 *   Se `poseResult` não fornecido → fallback para ONNX Person (comportamento V27-V31).
 *
 * Melhorias — Temporal Fusion + Adaptive Distance:
 *   Smoother usa confiança real ponderada (não voto binário).
 *   Gates de associação e threshold do smoother adaptam-se à distância da pessoa.
 */
export function analyzePPEStatus(
  trackedDetections: TrackedDetection[],
  config:      PPEConfig,
  videoWidth:  number = 640,
  videoHeight: number = 480,
  poseResult?: PoseResult | null
): PPEStatus {
  const ppeItems   = trackedDetections.filter(d => d.className !== "Person");
  const allPersons = trackedDetections.filter(d => d.className === "Person");

  // ── POSE-FIRST PATH ───────────────────────────────────────────────────────
  if (poseResult) {
    _noPersonFrameCount = 0;

    const { landmarks, bodyRegions, bbox } = poseResult;

    // Tentar obter bbox ONNX para melhor exibição (mais preciso para corpo inteiro)
    // Se não disponível, usar bbox estimado dos landmarks
    const onnxPerson = allPersons.length > 0
      ? allPersons.reduce((b, p) => p.confidence > b.confidence ? p : b)
      : null;

    let personCx: number, personCy: number, personW: number, personH: number;
    let confidence: number;
    let trackId: number;

    if (onnxPerson) {
      // Usar bbox ONNX — mais preciso para o contorno visual
      const norm = {
        cx: (onnxPerson.x - (MODEL_SIZE - videoWidth * Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight)) / 2)
            / Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight) / videoWidth,
        cy: (onnxPerson.y - (MODEL_SIZE - videoHeight * Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight)) / 2)
            / Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight) / videoHeight,
        w: onnxPerson.w / Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight) / videoWidth,
        h: onnxPerson.h / Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight) / videoHeight,
      };
      personCx   = norm.cx;
      personCy   = norm.cy;
      personW    = norm.w;
      personH    = norm.h;
      confidence = onnxPerson.confidence;
      trackId    = onnxPerson.trackId;
    } else {
      // Fallback: bbox estimado dos landmarks
      personCx   = bbox.cx;
      personCy   = bbox.cy;
      personW    = bbox.w;
      personH    = bbox.h;
      confidence = 0.85;  // pose tem alta confiança por padrão
      trackId    = 0;
    }

    // Área da pessoa como fração do frame (proxy de distância)
    const personAreaFraction = personW * personH;

    const { associated, presentRawConf } = associatePPE(
      personCx, personCy, personW, personH,
      bodyRegions,
      ppeItems, config, videoWidth, videoHeight,
      personAreaFraction
    );

    const person = buildTrackedPerson(
      trackId, personCx, personCy, personW, personH, confidence,
      landmarks, bodyRegions,
      associated, presentRawConf, config, true, personAreaFraction,
      videoWidth, videoHeight
    );

    const violations: string[] = [];
    for (const missing of person.missingPPE) {
      violations.push(PPE_VIOLATION_LABELS[missing] ?? `SEM ${missing.toUpperCase()}`);
    }

    return {
      person,
      personCount: 1,
      violations,
      classStatus: buildClassStatus(person, config),
      poseActive: true,
    };
  }

  // ── FALLBACK: sem pose → usar ONNX Person ────────────────────────────────
  const primaryPerson = allPersons.length > 0
    ? allPersons.reduce((best, p) => p.confidence > best.confidence ? p : best)
    : null;

  if (!primaryPerson) {
    _noPersonFrameCount++;
    if (_noPersonFrameCount >= NO_PERSON_RESET_FRAMES) {
      _smoother.reset();
      _noPersonFrameCount = 0;
    }
    return emptyStatus(config);
  }

  _noPersonFrameCount = 0;

  const pNorm = toVideoNorm(primaryPerson, videoWidth, videoHeight);

  // Área da pessoa como fração do frame (proxy de distância)
  const personAreaFraction = pNorm.w * pNorm.h;

  const { associated, presentRawConf } = associatePPE(
    pNorm.cx, pNorm.cy, pNorm.w, pNorm.h,
    null,   // sem pose
    ppeItems, config, videoWidth, videoHeight,
    personAreaFraction
  );

  const person = buildTrackedPerson(
    primaryPerson.trackId,
    pNorm.cx, pNorm.cy, pNorm.w, pNorm.h,
    primaryPerson.confidence,
    undefined, undefined,
    associated, presentRawConf, config, false, personAreaFraction,
    videoWidth, videoHeight
  );

  const violations: string[] = [];
  for (const missing of person.missingPPE) {
    violations.push(PPE_VIOLATION_LABELS[missing] ?? `SEM ${missing.toUpperCase()}`);
  }

  return {
    person,
    personCount: 1,
    violations,
    classStatus: buildClassStatus(person, config),
    poseActive: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildClassStatus(
  person: TrackedPerson,
  config: PPEConfig
): Record<string, "compliant" | "violation" | "not_detected"> {
  const enabledPPE = config.classes.filter(c => c.enabled && c.name !== "Person");
  const result: Record<string, "compliant" | "violation" | "not_detected"> = {};
  for (const cls of enabledPPE) {
    const has = person.presentPPE.includes(cls.name);
    if (cls.required) {
      result[cls.name] = has ? "compliant" : "violation";
    } else {
      result[cls.name] = has ? "compliant" : "not_detected";
    }
  }
  return result;
}

function emptyStatus(config: PPEConfig): PPEStatus {
  const enabledPPE = config.classes.filter(c => c.enabled && c.name !== "Person");
  const classStatus: Record<string, "compliant" | "violation" | "not_detected"> = {};
  for (const cls of enabledPPE) classStatus[cls.name] = "not_detected";
  return {
    person:      null,
    personCount: 0,
    violations:  [],
    classStatus,
    poseActive:  false,
  };
}
