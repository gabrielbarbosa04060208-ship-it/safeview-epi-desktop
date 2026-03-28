// types.ts — V33

export interface Detection {
  classId: number; className: string; confidence: number;
  x: number; y: number; w: number; h: number;
}

export interface TrackedDetection extends Detection { trackId: number; }

export interface PoseLandmark {
  x: number; y: number; z: number; visibility: number;
}

export interface BodyRegions {
  head:  { x: number; y: number; w: number; h: number } | null;
  torso: { x: number; y: number; w: number; h: number } | null;
  hands: { left: { x: number; y: number } | null; right: { x: number; y: number } | null };
  feet:  { left: { x: number; y: number } | null; right: { x: number; y: number } | null };
}

// V33: resultado de pose — fonte primária de detecção de presença humana
export interface PoseResult {
  landmarks:   PoseLandmark[];
  bodyRegions: BodyRegions;
  // bbox estimado a partir dos landmarks (para exibição e fallback de associação)
  bbox: { cx: number; cy: number; w: number; h: number };
}

export type PersonStatusLevel = "SAFE" | "WARNING" | "VIOLATION";

export interface TrackedPerson extends TrackedDetection {
  associatedPPE: TrackedDetection[];
  missingPPE:    string[];
  presentPPE:    string[];
  statusLevel:   PersonStatusLevel;
  landmarks?:    PoseLandmark[];
  bodyRegions?:  BodyRegions;
  // V33: indica se a pessoa foi detectada via Pose (true) ou fallback ONNX (false)
  detectedByPose: boolean;
}

export interface PPEStatus {
  person:      TrackedPerson | null;
  personCount: number;           // 0 ou 1
  violations:  string[];
  classStatus: Record<string, "compliant" | "violation" | "not_detected">;
  poseActive:  boolean;          // V33: indica se pose está sendo usado ativamente
}

export interface PPEClassConfig {
  name: string; enabled: boolean; required: boolean;
  confidence: number; bodyRegion: "head" | "torso" | "hands" | "feet";
}

export interface PPEConfig {
  classes:          PPEClassConfig[];
  poseEnabled:      boolean;
  poseEveryNFrames: number;
}
