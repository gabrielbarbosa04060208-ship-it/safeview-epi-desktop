// PATCH: src/lib/ppe/constants.ts
// Correção de precisão: MIN_AREA_THRESHOLD 150 → 500
// 150 (~12×12px) é permissivo demais; qualquer artefato de compressão de câmera passa.
// 500 (~22×22px) ainda captura EPIs distantes mas elimina ruído de pixel.

export const CLASS_NAMES = [
  "Boots",
  "Ear-protection",
  "Glass",
  "Glove",
  "Helmet",
  "Mask",
  "Person",
  "Vest",
] as const;

export type ClassName = (typeof CLASS_NAMES)[number];

export const CLASS_COLORS: Record<string, string> = {
  Boots:            "#f59e0b",
  "Ear-protection": "#8b5cf6",
  Glass:            "#06b6d4",
  Glove:            "#ec4899",
  Helmet:           "#22c55e",
  Mask:             "#3b82f6",
  Person:           "#ef4444",
  Vest:             "#f97316",
};

export const CLASS_IOU_THRESHOLDS: Record<string, number> = {
  Boots:            0.50,
  "Ear-protection": 0.45,
  Glass:            0.45,
  Glove:            0.45,
  Helmet:           0.50,
  Mask:             0.45,
  Person:           0.55,
  Vest:             0.50,
};

// Aumentado de 150 para 500: elimina detecções de ruído tiny (~22×22px mínimo)
// sem descartar EPIs legítimas a distância moderada.
export const MIN_AREA_THRESHOLD = 500;

export const MODEL_SIZE = 640;


export const REQUIRED_PPE: ClassName[] = ["Helmet", "Vest"];
export const PPE_CLASSES: ClassName[]  = CLASS_NAMES.filter(c => c !== "Person") as ClassName[];
