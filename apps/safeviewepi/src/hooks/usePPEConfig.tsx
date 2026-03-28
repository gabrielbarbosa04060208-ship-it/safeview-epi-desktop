import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { createDefaultConfig } from "@/lib/ppe/config";
import type { PPEConfig, PPEClassConfig } from "@/lib/ppe/types";
interface PPEConfigContextType { config: PPEConfig; updateClassConfig: (n: string, u: Partial<PPEClassConfig>) => void; setPoseEnabled: (e: boolean) => void; setPoseEveryNFrames: (n: number) => void; resetConfig: () => void; }
const PPEConfigContext = createContext<PPEConfigContextType | null>(null);
export function PPEConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PPEConfig>(createDefaultConfig);
  const updateClassConfig = useCallback((name: string, updates: Partial<PPEClassConfig>) => setConfig(p => ({ ...p, classes: p.classes.map(c => c.name === name ? { ...c, ...updates } : c) })), []);
  const setPoseEnabled = useCallback((enabled: boolean) => setConfig(p => ({ ...p, poseEnabled: enabled })), []);
  const setPoseEveryNFrames = useCallback((n: number) => setConfig(p => ({ ...p, poseEveryNFrames: Math.max(1, Math.min(10, n)) })), []);
  const resetConfig = useCallback(() => setConfig(createDefaultConfig()), []);
  return <PPEConfigContext.Provider value={{ config, updateClassConfig, setPoseEnabled, setPoseEveryNFrames, resetConfig }}>{children}</PPEConfigContext.Provider>;
}
export function usePPEConfig(): PPEConfigContextType {
  const ctx = useContext(PPEConfigContext);
  if (!ctx) throw new Error("usePPEConfig must be used within PPEConfigProvider");
  return ctx;
}
