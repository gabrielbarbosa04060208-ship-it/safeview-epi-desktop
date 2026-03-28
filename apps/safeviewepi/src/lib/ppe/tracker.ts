// tracker.ts — V31
//
// Bugs corrigidos nesta versão:
//   V31: Arquivo reescrito de forma legível (estava minificado).
//   V31-T1: MAX_AGE 15 → 10: tracks mortos saem mais rápido do sistema
//            (antes um FP de Vest vivia 15 frames após perder detecção)
//   V31-T2: MAX_COAST_AGE 4 → 3: track coasting reduzido
//            (coast = continuar mostrando detection sem nova evidência)
//   V31-T3: Confidence decay para Vest mais agressivo: 0.80 → 0.70 por frame
//            (track de Vest sem nova detecção decai mais rápido)
//   V31-T4: CONFIRMATION_FRAMES mantido em 1 (mostrar imediatamente)

import type { Detection, TrackedDetection } from "./types";

let nextId = 1;

const MAX_AGE           = 10;   // V31: reduzido de 15 (FPs saem mais rápido)
const CONFIRMATION_FRAMES = 1;  // mostrar detecção desde o primeiro frame
const MAX_COAST_AGE     = 3;    // V31: reduzido de 4 (menos coasting sem evidência)

// Confidence decay por frame quando track não tem correspondência.
// Vest tem decay mais agressivo: falsos positivos desaparecem mais rápido.
const CONFIDENCE_DECAY_DEFAULT = { young: 0.80, mid: 0.92, veteran: 0.96 };
const CONFIDENCE_DECAY: Record<string, typeof CONFIDENCE_DECAY_DEFAULT> = {
  Vest: { young: 0.70, mid: 0.85, veteran: 0.92 },  // V31: decay agressivo
};

interface Track {
  id:        number;
  detection: Detection;
  age:       number;
  hits:      number;
  totalHits: number;
}

let tracks: Track[] = [];

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

function matchCost(track: Track, det: Detection): number {
  // Usar posição atual do track (sem predição de velocidade)
  const iouScore = iou(track.detection, det);
  const dx = track.detection.x - det.x;
  const dy = track.detection.y - det.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Combinar IoU (0.6) e distância normalizada (0.4)
  return (1 - iouScore) * 0.6 + (dist / 640) * 0.4;
}

function getDecayForTrack(track: Track): number {
  const decay = CONFIDENCE_DECAY[track.detection.className] ?? CONFIDENCE_DECAY_DEFAULT;
  if (track.totalHits > 10) return decay.veteran;
  if (track.totalHits > 4)  return decay.mid;
  return decay.young;
}

export function updateTracks(detections: Detection[]): TrackedDetection[] {
  const usedTrackIds  = new Set<number>();
  const usedDetIdxs   = new Set<number>();

  // ── Fase 1: Matching hungarian (greedy por custo) ─────────────────────────
  const assignments: { ti: number; di: number; cost: number }[] = [];

  for (let ti = 0; ti < tracks.length; ti++) {
    for (let di = 0; di < detections.length; di++) {
      if (tracks[ti].detection.classId !== detections[di].classId) continue;
      const cost      = matchCost(tracks[ti], detections[di]);
      const threshold = tracks[ti].totalHits > 5 ? 0.80 : 0.70;
      if (cost < threshold) assignments.push({ ti, di, cost });
    }
  }

  assignments.sort((a, b) => a.cost - b.cost);

  for (const { ti, di } of assignments) {
    if (usedTrackIds.has(tracks[ti].id) || usedDetIdxs.has(di)) continue;
    usedTrackIds.add(tracks[ti].id);
    usedDetIdxs.add(di);

    const t = tracks[ti];
    const d = detections[di];

    // Suavizar tamanho levemente (reduz jitter de bbox) — posição atualiza imediatamente
    const sizeAlpha = 0.80;

    t.detection = {
      ...d,
      x:          d.x,
      y:          d.y,
      w:          t.detection.w * (1 - sizeAlpha) + d.w * sizeAlpha,
      h:          t.detection.h * (1 - sizeAlpha) + d.h * sizeAlpha,
      confidence: Math.max(t.detection.confidence * 0.30 + d.confidence * 0.70, d.confidence),
    };
    t.age = 0;
    t.hits++;
    t.totalHits++;
  }

  // ── Fase 2: Envelhecer tracks não casados ────────────────────────────────
  for (const track of tracks) {
    if (!usedTrackIds.has(track.id)) {
      track.age++;
      track.detection.confidence *= getDecayForTrack(track);
    }
  }

  // V31-T1: remover tracks antigos (MAX_AGE reduzido de 15 para 10)
  tracks = tracks.filter(t => t.age < MAX_AGE);

  // ── Fase 3: Criar novos tracks para detecções sem correspondência ─────────
  for (let di = 0; di < detections.length; di++) {
    if (usedDetIdxs.has(di)) continue;
    const det = detections[di];

    // Verificar se há um track próximo não casado (evitar duplicatas por ID)
    const nearbyIdx = tracks.findIndex(t => {
      if (usedTrackIds.has(t.id) || t.detection.classId !== det.classId) return false;
      const dx = t.detection.x - det.x;
      const dy = t.detection.y - det.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const size = Math.max(t.detection.w, t.detection.h, det.w, det.h);
      return dist < size * 0.40;
    });

    if (nearbyIdx >= 0) {
      const t = tracks[nearbyIdx];
      t.detection = det;
      t.age       = 0;
      t.hits++;
      t.totalHits++;
      usedTrackIds.add(t.id);
    } else {
      tracks.push({ id: nextId++, detection: det, age: 0, hits: 1, totalHits: 1 });
    }
  }

  // Retornar apenas tracks confirmados e não muito velhos
  return tracks
    .filter(t => t.totalHits >= CONFIRMATION_FRAMES && t.age <= MAX_COAST_AGE)
    .map(t => ({ ...t.detection, trackId: t.id }));
}

export function resetTracks(): void {
  tracks  = [];
  nextId  = 1;
}
