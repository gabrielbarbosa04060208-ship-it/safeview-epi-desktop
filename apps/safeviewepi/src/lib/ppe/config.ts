// config.ts — V24
// P6: Threshold tuning baseado no dataset e no Python original (workplace_safety_monitor.py).
//     Valores originais recomendados: conf_helmet=0.65, conf_vest=0.70.
//     Para ONNX web (float16 quantizado) usamos 0.55/0.60 — ligeiramente mais permissivos
//     que o .pt PyTorch porque a quantizacao reduz scores absolutos em ~5-10%.
//     Person: 0.30 → 0.40 (reduz deteccoes espurias de areas sem pessoa).

import type { PPEClassConfig, PPEConfig } from "./types";
import { CLASS_NAMES } from "./constants";

const BODY_REGION_MAP: Record<string, PPEClassConfig["bodyRegion"]> = {
  Helmet:           "head",
  Glass:            "head",
  Mask:             "head",
  "Ear-protection": "head",
  Vest:             "torso",
  Glove:            "hands",
  Boots:            "feet",
};

// P6: Thresholds calibrados para o modelo ONNX exportado do dataset Construction Site Safety
// Python original: conf_helmet=0.65, conf_vest=0.70
// ONNX quantizado (float16): ~-0.08 de reducao media nos scores absolutos
const DEFAULT_CONFIDENCE: Record<string, number> = {
  Person:           0.40,  // era 0.30 — menos deteccoes espurias
  Helmet:           0.55,  // era 0.40 — Python recomenda 0.65 para .pt
  Vest:             0.60,  // era 0.40 — Python recomenda 0.70 para .pt
  Glass:            0.45,  // era 0.40
  Mask:             0.45,  // era 0.40
  Glove:            0.45,  // era 0.35
  Boots:            0.45,  // era 0.35
  "Ear-protection": 0.40,  // era 0.35
};

const DEFAULT_ENABLED: Record<string, boolean> = {
  Person:           true,
  Helmet:           true,
  Vest:             true,
  Glass:            false,
  Mask:             false,
  Glove:            false,
  Boots:            false,
  "Ear-protection": false,
};

export function createDefaultConfig(): PPEConfig {
  const ppeClasses: PPEClassConfig[] = CLASS_NAMES
    .filter((c) => c !== "Person")
    .map((name) => ({
      name,
      enabled:    DEFAULT_ENABLED[name] ?? false,
      required:   name === "Helmet" || name === "Vest",
      confidence: DEFAULT_CONFIDENCE[name] ?? 0.45,
      bodyRegion: BODY_REGION_MAP[name] || "torso",
    }));

  ppeClasses.push({
    name:       "Person",
    enabled:    true,
    required:   true,
    confidence: DEFAULT_CONFIDENCE["Person"],
    bodyRegion: "torso",
  });

  return {
    classes:          ppeClasses,
    poseEnabled:      true,
    poseEveryNFrames: 3,  // V31: mantido em 3 — bom equilíbrio fps/acurácia de pose
  };
}

export function getClassConfig(config: PPEConfig, className: string): PPEClassConfig | undefined {
  return config.classes.find((c) => c.name === className);
}

export function getEnabledClasses(config: PPEConfig): PPEClassConfig[] {
  return config.classes.filter((c) => c.enabled);
}

export function getRequiredClasses(config: PPEConfig): PPEClassConfig[] {
  return config.classes.filter((c) => c.enabled && c.required && c.name !== "Person");
}

export function getOptionalClasses(config: PPEConfig): PPEClassConfig[] {
  return config.classes.filter((c) => c.enabled && !c.required && c.name !== "Person");
}
