import { usePPEConfig } from "@/hooks/usePPEConfig";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Settings, RotateCcw, X, Activity } from "lucide-react";
const PPE_LABELS: Record<string, string> = { Helmet: "Capacete", Vest: "Colete", Boots: "Botas", Glass: "Óculos", Glove: "Luvas", Mask: "Máscara", "Ear-protection": "Prot.Auricular", Person: "Pessoa" };
interface PPESettingsPanelProps { open: boolean; onClose: () => void; }
export function PPESettingsPanel({ open, onClose }: PPESettingsPanelProps) {
  const { config, updateClassConfig, setPoseEnabled, setPoseEveryNFrames, resetConfig } = usePPEConfig();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto w-80 max-w-full bg-card border-l border-border h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-card z-10 p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2"><Settings className="h-4 w-4 text-primary" /><span className="text-sm font-bold text-foreground tracking-wider">CONFIGURAÇÕES</span></div>
          <div className="flex items-center gap-2"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={resetConfig}><RotateCcw className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}><X className="h-3.5 w-3.5" /></Button></div>
        </div>
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center gap-2"><Activity className="h-3.5 w-3.5 text-primary" /><span className="text-xs font-bold text-foreground tracking-wider">POSE LANDMARKER</span></div>
          <div className="flex items-center justify-between"><Label className="text-xs text-muted-foreground">Pose ativa</Label><Switch checked={config.poseEnabled} onCheckedChange={setPoseEnabled} /></div>
          {config.poseEnabled && (<div className="space-y-1"><div className="flex items-center justify-between"><Label className="text-xs text-muted-foreground">A cada N frames</Label><span className="text-xs font-mono text-foreground">{config.poseEveryNFrames}</span></div><Slider value={[config.poseEveryNFrames]} onValueChange={([v]) => setPoseEveryNFrames(v)} min={1} max={10} step={1} className="w-full" /></div>)}
        </div>
        <div className="p-4 space-y-4">
          <span className="text-xs font-bold text-foreground tracking-wider">CLASSES</span>
          {config.classes.map(cls => {
            const label = PPE_LABELS[cls.name] || cls.name, isPerson = cls.name === "Person";
            return (<div key={cls.name} className="space-y-2 p-3 rounded-lg bg-secondary/50 border border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2"><span className="text-xs font-bold text-foreground">{label}</span>{cls.required && <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-primary/40 text-primary">Obrigatório</Badge>}</div>
                <Switch checked={cls.enabled} onCheckedChange={c => updateClassConfig(cls.name, { enabled: c })} disabled={isPerson} />
              </div>
              {cls.enabled && (<>
                {!isPerson && (<div className="flex items-center justify-between"><Label className="text-[11px] text-muted-foreground">Obrigatório</Label><Switch checked={cls.required} onCheckedChange={c => updateClassConfig(cls.name, { required: c })} /></div>)}
                <div className="space-y-1"><div className="flex items-center justify-between"><Label className="text-[11px] text-muted-foreground">Confiança</Label><span className="text-[11px] font-mono text-foreground">{(cls.confidence*100).toFixed(0)}%</span></div><Slider value={[cls.confidence*100]} onValueChange={([v]) => updateClassConfig(cls.name, { confidence: v/100 })} min={10} max={90} step={5} className="w-full" /></div>
              </>)}
            </div>);
          })}
        </div>
      </div>
    </div>
  );
}
