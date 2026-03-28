// drawing.ts — V30
// Renderização completa: boxes, esqueleto MediaPipe Pose, regiões corporais, debug overlay
// CORRECAO: drawing.ts do V8 estava minificado e sem renderização de pose.
// Este arquivo restaura drawPoseSkeleton e drawRegionBox.

import { CLASS_COLORS, MODEL_SIZE } from "./constants";
import { POSE_CONNECTIONS } from "./pose";
import { PPE_DISPLAY_NAMES } from "./association";  // BUG-H4 FIX
import type { TrackedDetection, TrackedPerson, PoseLandmark } from "./types";

export function drawDetections(
  ctx: CanvasRenderingContext2D,
  persons: TrackedPerson[],
  allDetections: TrackedDetection[],
  videoWidth: number,
  videoHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  showDebug: boolean
): void {
  // Coordenadas: modelo (640x640 letterboxed) → canvas espelhado via CSS scaleX(-1)
  // O canvas tem transform scaleX(-1) no DOM, então desenhamos normalmente
  // e o espelhamento do vídeo é tratado pelo CSS.
  const scale = Math.min(MODEL_SIZE / videoWidth, MODEL_SIZE / videoHeight);
  const dx = (MODEL_SIZE - videoWidth * scale) / 2;
  const dy = (MODEL_SIZE - videoHeight * scale) / 2;

  function toCanvas(det: TrackedDetection) {
    const x = ((det.x - dx) / scale) * (canvasWidth / videoWidth);
    const y = ((det.y - dy) / scale) * (canvasHeight / videoHeight);
    const w = (det.w / scale) * (canvasWidth / videoWidth);
    const h = (det.h / scale) * (canvasHeight / videoHeight);
    return { x, y, w, h };
  }

  // Label com fundo colorido — escrita espelhada para ler corretamente no canvas scaleX(-1)
  // FIX V7: y clampado a mínimo 18px para não sair acima do canvas
  function drawLabel(text: string, x1: number, y1Raw: number, color: string) {
    const y1 = Math.max(y1Raw, 18);
    ctx.font = "bold 12px monospace";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x1, y1 - 18, tw + 8, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.save();
    ctx.translate(x1 + tw + 4, y1 - 4);
    ctx.scale(-1, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // ── 1. Todas as detecções (boxes + labels) ──────────────────────────────────
  for (const det of allDetections) {
    const { x, y, w, h } = toCanvas(det);
    const x1 = x - w / 2;
    const y1 = y - h / 2;
    const color = CLASS_COLORS[det.className] || "#fff";

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, w, h);

    const label = showDebug
      ? `#${det.trackId} ${det.className} ${(det.confidence * 100).toFixed(0)}%`
      : `${det.className} ${(det.confidence * 100).toFixed(0)}%`;
    drawLabel(label, x1, y1, color);
  }

  // ── 2. Overlay por pessoa ───────────────────────────────────────────────────
  for (const person of persons) {
    const pc = toCanvas(person);

    // Barra de status no topo da box da pessoa
    const statusColor =
      person.statusLevel === "SAFE"
        ? "rgba(34,197,94,0.7)"
        : person.statusLevel === "WARNING"
        ? "rgba(234,179,8,0.7)"
        : "rgba(239,68,68,0.7)";
    ctx.fillStyle = statusColor;
    ctx.fillRect(pc.x - pc.w / 2, pc.y - pc.h / 2 - 4, pc.w, 4);

    if (showDebug) {
      // Linhas tracejadas conectando pessoa às EPIs associadas
      for (const ppe of person.associatedPPE) {
        const ppec = toCanvas(ppe);
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pc.x, pc.y);
        ctx.lineTo(ppec.x, ppec.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── Esqueleto MediaPipe Pose ─────────────────────────────────────────
      if (person.landmarks && person.landmarks.length > 0) {
        drawPoseSkeleton(ctx, person.landmarks, canvasWidth, canvasHeight);
      }

      // ── Regiões corporais (head / torso) ─────────────────────────────────
      if (person.bodyRegions) {
        if (person.bodyRegions.head) {
          drawRegionBox(ctx, person.bodyRegions.head, canvasWidth, canvasHeight,
            "rgba(59,130,246,0.6)", "HEAD");
        }
        if (person.bodyRegions.torso) {
          drawRegionBox(ctx, person.bodyRegions.torso, canvasWidth, canvasHeight,
            "rgba(249,115,22,0.6)", "TORSO");
        }
      }

      // EPIs faltando em vermelho abaixo da box
      if (person.missingPPE.length > 0) {
        const x1 = pc.x - pc.w / 2;
        const y = pc.y + pc.h / 2 + 14;
        // BUG-H4 FIX: mapear class names para labels PT-BR
        const missingLabels = person.missingPPE.map((n) => PPE_DISPLAY_NAMES[n] || n);
        const text = `FALTANDO: ${missingLabels.join(", ")}`;
        drawLabel(text, x1, y, "rgba(239,68,68,0.9)");
      }
    }
  }

  // B7 FIX: restaurar lineWidth e lineDash ao padrão — evita artefatos visuais em draws futuros
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
}

// ── Esqueleto MediaPipe Pose ──────────────────────────────────────────────────
function drawPoseSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: PoseLandmark[],
  canvasWidth: number,
  canvasHeight: number
): void {
  // Ossos
  ctx.strokeStyle = "rgba(0,255,180,0.75)";
  ctx.lineWidth = 2;
  ctx.setLineDash([]);

  for (const [i, j] of POSE_CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    if ((a.visibility ?? 0) < 0.3 || (b.visibility ?? 0) < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(a.x * canvasWidth, a.y * canvasHeight);
    ctx.lineTo(b.x * canvasWidth, b.y * canvasHeight);
    ctx.stroke();
  }

  // Articulações
  for (const lm of landmarks) {
    if ((lm.visibility ?? 0) < 0.3) continue;
    ctx.fillStyle = "rgba(0,255,180,0.9)";
    ctx.beginPath();
    ctx.arc(lm.x * canvasWidth, lm.y * canvasHeight, 4, 0, Math.PI * 2);
    ctx.fill();
    // Borda branca para contraste
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ── Regiões corporais (debug) ─────────────────────────────────────────────────
function drawRegionBox(
  ctx: CanvasRenderingContext2D,
  region: { x: number; y: number; w: number; h: number },
  canvasWidth: number,
  canvasHeight: number,
  color: string,
  label: string
): void {
  const rx = region.x * canvasWidth;
  const ry = region.y * canvasHeight;
  const rw = region.w * canvasWidth;
  const rh = region.h * canvasHeight;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(rx - rw / 2, ry - rh / 2, rw, rh);
  ctx.setLineDash([]);

  // Label da região (espelhado como os demais)
  ctx.font = "bold 10px monospace";
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  const lx = rx - rw / 2 + 2;
  const ly = ry - rh / 2 - 2;
  ctx.save();
  ctx.translate(lx + ctx.measureText(label).width, ly);
  ctx.scale(-1, 1);
  ctx.fillText(label, 0, 0);
  ctx.restore();
  ctx.globalAlpha = 1;
}
