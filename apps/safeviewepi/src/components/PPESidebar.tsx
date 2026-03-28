// PPESidebar.tsx — V27 single-person
// Removido: multiplePersonsWarning, loop persons[], detalhes por pessoa múltipla
// Mantido: status por classe EPI, violações, debug toggle, FPS

import { Shield, ShieldCheck, ShieldAlert, ShieldOff, Eye, EyeOff, Settings } from "lucide-react";
import type { PPEStatus, PPEConfig } from "@/lib/ppe";
import { Badge } from "@/components/ui/badge";

const PPE_LABELS: Record<string, string> = {
  Helmet:           "Capacete",
  Vest:             "Colete",
  Boots:            "Botas",
  Glass:            "Óculos",
  Glove:            "Luvas",
  Mask:             "Máscara",
  "Ear-protection": "Proteção Auricular",
};

interface PPESidebarProps {
  ppeStatus:       PPEStatus;
  running:         boolean;
  showDebug:       boolean;
  onToggleDebug:   () => void;
  onOpenSettings:  () => void;
  fps:             number;
  config:          PPEConfig;
}

export function PPESidebar({ ppeStatus, running, showDebug, onToggleDebug, onOpenSettings, fps, config }: PPESidebarProps) {
  const enabledPPE = config.classes.filter((c) => c.enabled && c.name !== "Person");
  const person     = ppeStatus.person;

  return (
    <div className="w-64 border-l border-border bg-card flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <span className="text-xs font-bold text-foreground tracking-wider">STATUS EPI</span>
          {running && (
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
              ppeStatus.poseActive
                ? "bg-primary/20 text-primary"
                : "bg-muted text-muted-foreground"
            }`}>
              {ppeStatus.poseActive ? "POSE" : "BBOX"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {running && (
            <Badge variant="outline" className="font-mono text-[10px] border-muted-foreground/30">
              {fps} FPS
            </Badge>
          )}
          <button onClick={onOpenSettings} className="p-1 rounded hover:bg-secondary transition-colors" title="Configurações">
            <Settings className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
          </button>
        </div>
      </div>

      {/* Pessoa detectada */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Pessoa detectada</span>
          <span className="text-sm font-bold text-foreground font-mono">
            {running ? (ppeStatus.personCount > 0 ? "SIM" : "NÃO") : "—"}
          </span>
        </div>
        {running && person && (
          <div className="mt-1 text-[9px] text-muted-foreground font-mono">
            conf: {(person.confidence * 100).toFixed(0)}%
            {person.landmarks ? " · pose ✓" : " · pose ✗"}
          </div>
        )}
      </div>

      {/* Status por classe EPI */}
      <div className="flex-1 p-2 space-y-1">
        {enabledPPE.map((cls) => {
          const status = ppeStatus.classStatus[cls.name] || "not_detected";
          const label  = PPE_LABELS[cls.name] || cls.name;

          let bgClass    = "bg-secondary";
          let textClass  = "text-muted-foreground";
          let Icon       = ShieldOff;
          let statusLbl  = "N/D";

          if (running && ppeStatus.personCount > 0) {
            if (status === "compliant") {
              bgClass   = "bg-safe/15 border border-safe/30";
              textClass = "text-safe";
              Icon      = ShieldCheck;
              statusLbl = "OK";
            } else if (status === "violation") {
              bgClass   = "bg-destructive/15 border border-destructive/30";
              textClass = "text-destructive";
              Icon      = ShieldAlert;
              statusLbl = "FALTA";
            }
          }

          return (
            <div key={cls.name} className={`flex items-center justify-between px-3 py-2 rounded-md ${bgClass} transition-colors`}>
              <div className="flex items-center gap-2">
                <Icon className={`h-3.5 w-3.5 ${textClass}`} />
                <span className={`text-xs font-medium ${running && ppeStatus.personCount > 0 ? textClass : "text-muted-foreground"}`}>
                  {label}
                </span>
                {!cls.required && <span className="text-[8px] text-muted-foreground/60 font-mono">OPC</span>}
              </div>
              <span className={`text-[10px] font-bold font-mono ${textClass}`}>
                {running ? statusLbl : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Violações */}
      {running && ppeStatus.violations.length > 0 && (
        <div className="p-3 border-t border-border space-y-1">
          <span className="text-[10px] text-destructive font-bold tracking-wider">⚠ VIOLAÇÕES</span>
          {ppeStatus.violations.map((v) => (
            <div key={v} className="bg-destructive/20 text-destructive text-[10px] font-bold px-2 py-1 rounded font-mono animate-pulse-alert">
              {v}
            </div>
          ))}
        </div>
      )}

      {/* EPIs presentes — lista rápida */}
      {running && person && person.presentPPE.length > 0 && (
        <div className="p-3 border-t border-border">
          <span className="text-[10px] text-muted-foreground font-bold tracking-wider">EPIs DETECTADOS</span>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {person.presentPPE.map((cls) => (
              <span key={cls} className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-safe/20 text-safe">
                ✔ {PPE_LABELS[cls] || cls}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Debug toggle */}
      <div className="p-3 border-t border-border">
        <button
          onClick={onToggleDebug}
          className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-secondary hover:bg-secondary/80 transition-colors text-xs"
        >
          <span className="text-muted-foreground">Debug Overlay</span>
          {showDebug ? <Eye className="h-3.5 w-3.5 text-primary" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
        </button>
      </div>
    </div>
  );
}
