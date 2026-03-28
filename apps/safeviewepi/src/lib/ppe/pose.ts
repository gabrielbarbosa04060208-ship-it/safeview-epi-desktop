// pose.ts — V33
// P4: detectar no frame inteiro, sem recortar ROI de pessoa.
//
//     PROBLEMA DO ROI (V1-V23):
//       1. Corta o video, redimensiona para um canvas quadrado
//       2. Passa o crop ao MediaPipe
//       3. Reprojecta landmarks de volta para coordenadas de video
//     = tres transformadas de coordenadas encadeadas → erro geometrico acumulado
//     = MediaPipe foi projetado para o frame inteiro — landmarks ja vem normalizados (0-1)
//
//     SOLUCAO (V24):
//       detectPoseFromVideo(video, timestamp) passa o HTMLVideoElement diretamente.
//       Landmarks retornam em coordenadas (0-1) relativas ao frame completo — sem reprojecao.
//
//     P4 BONUS: score = min(visibility, presence)
//       MediaPipe expoe dois campos independentes:
//         visibility = o landmark esta visivel (nao ocluido)?
//         presence   = o landmark esta dentro do frame?
//       Usar apenas visibility pode incluir landmarks fora do frame (presence baixo).
//       min() descarta ambos os casos errados.

import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { PoseLandmark, BodyRegions } from "./types";

let poseLandmarker: PoseLandmarker | null = null;
let lastPoseTimestamp = -1;

function resolveDistPath(relativePath: string): string {
  return new URL(relativePath, window.location.href).href;
}

export async function loadPoseLandmarker(): Promise<void> {
  const wasmPath  = resolveDistPath("./mediapipe-wasm/");
  const modelPath = resolveDistPath("./models/pose_landmarker_lite.task");

  const vision = await FilesetResolver.forVisionTasks(wasmPath);
  const baseOptions = { modelAssetPath: modelPath };
  const commonOpts  = { runningMode: "VIDEO" as const, numPoses: 1 };  // single-person mode

  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      ...commonOpts,
      baseOptions: { ...baseOptions, delegate: "GPU" },
    });
    console.log("[Pose] delegate: GPU | numPoses: 1");
  } catch {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      ...commonOpts,
      baseOptions: { ...baseOptions, delegate: "CPU" },
    });
    console.log("[Pose] delegate: CPU | numPoses: 1");
  }

  lastPoseTimestamp = -1;
}

export function resetPoseTimestamp(): void { lastPoseTimestamp = -1; }
export function isPoseLoaded(): boolean { return poseLandmarker !== null; }

// Single-person mode (numPoses:1): detecta pose no frame inteiro sem ROI.
// Landmarks já em coordenadas vídeo-normalizadas (0-1) — sem reprojeção.
// Score = min(visibility, presence): filtra landmarks ocluídos E fora do frame.
export function detectPoseFromVideo(
  video: HTMLVideoElement,
  timestamp: number
): PoseLandmark[] | null {
  if (!poseLandmarker) return null;

  try {
    const ts      = Math.round(timestamp);
    const safeTs  = ts <= lastPoseTimestamp ? lastPoseTimestamp + 1 : ts;
    lastPoseTimestamp = safeTs;

    const result = poseLandmarker.detectForVideo(video, safeTs);
    if (!result.landmarks || result.landmarks.length === 0) return null;

    // numPoses:1 → result.landmarks[0] é a única pessoa detectada
    return result.landmarks[0].map((lm: any) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z ?? 0,
      visibility: Math.min(lm.visibility ?? 0, lm.presence ?? 1),
    }));
  } catch {
    return null;
  }
}

/**
 * Extrai regiões corporais de landmarks normalizados (0-1 do frame).
 * Threshold elevado para 0.4 porque agora usamos min(visibility, presence) — score mais exigente.
 */
export function extractBodyRegions(landmarks: PoseLandmark[]): BodyRegions {
  const CONF = 0.40;  // era 0.30 — score combinado e mais exigente

  const nose          = landmarks[0];
  const leftEye       = landmarks[2];
  const rightEye      = landmarks[5];
  const leftShoulder  = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip       = landmarks[23];
  const rightHip      = landmarks[24];
  const leftWrist     = landmarks[15];
  const rightWrist    = landmarks[16];
  const leftAnkle     = landmarks[27];
  const rightAnkle    = landmarks[28];

  // Cabeca: centrada no nariz, largura estimada pelo span dos olhos
  let head: BodyRegions["head"] = null;
  if ((nose?.visibility ?? 0) > CONF) {
    const eyeSpan = Math.abs((leftEye?.x ?? nose.x - 0.04) - (rightEye?.x ?? nose.x + 0.04));
    const headW   = Math.max(eyeSpan * 3.0, 0.08);
    const headH   = Math.max(eyeSpan * 3.5, 0.11);
    head = { x: nose.x, y: nose.y - headH * 0.15, w: headW, h: headH };
  }

  // Tronco: entre ombros e quadril
  let torso: BodyRegions["torso"] = null;
  if ((leftShoulder?.visibility ?? 0) > CONF && (rightShoulder?.visibility ?? 0) > CONF) {
    const sMx = (leftShoulder.x + rightShoulder.x) / 2;
    const sMy = (leftShoulder.y + rightShoulder.y) / 2;
    const sw  = Math.abs(leftShoulder.x - rightShoulder.x);
    const tw  = sw * 1.35;

    if ((leftHip?.visibility ?? 0) > CONF && (rightHip?.visibility ?? 0) > CONF) {
      const hMx = (leftHip.x + rightHip.x) / 2;
      const hMy = (leftHip.y + rightHip.y) / 2;
      torso = {
        x: (sMx + hMx) / 2,
        y: (sMy + hMy) / 2,
        w: Math.max(tw, 0.10),
        h: Math.max(Math.abs(hMy - sMy) * 1.15, 0.10),
      };
    } else {
      const estH = sw * 1.8;
      torso = {
        x: sMx,
        y: sMy + estH * 0.3,
        w: Math.max(tw, 0.10),
        h: Math.max(estH, 0.10),
      };
    }
  }

  return {
    head,
    torso,
    hands: {
      left:  (leftWrist?.visibility  ?? 0) > CONF ? { x: leftWrist.x,  y: leftWrist.y  } : null,
      right: (rightWrist?.visibility ?? 0) > CONF ? { x: rightWrist.x, y: rightWrist.y } : null,
    },
    feet: {
      left:  (leftAnkle?.visibility  ?? 0) > CONF ? { x: leftAnkle.x,  y: leftAnkle.y  } : null,
      right: (rightAnkle?.visibility ?? 0) > CONF ? { x: rightAnkle.x, y: rightAnkle.y } : null,
    },
  };
}

/**
 * V33: Constrói um PoseResult completo a partir de landmarks.
 * Usado pelo Index.tsx para passar ao analyzePPEStatus.
 */
import { estimateBboxFromLandmarks } from "./association";
import type { PoseResult } from "./types";

export function buildPoseResult(landmarks: PoseLandmark[]): PoseResult {
  const bodyRegions = extractBodyRegions(landmarks);
  const bbox        = estimateBboxFromLandmarks(landmarks);
  return { landmarks, bodyRegions, bbox };
}

export const POSE_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
];
