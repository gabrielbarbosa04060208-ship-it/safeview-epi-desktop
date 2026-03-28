// Index.tsx — V33
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  NOVA ARQUITETURA — POSE-FIRST                                           ║
// ║                                                                          ║
// ║  processFrame():                                                         ║
// ║    1. Pose roda primeiro (a cada poseEveryNFrames, sem depender de ONNX) ║
// ║    2. ONNX roda em paralelo — detecta apenas EPIs (Person é bônus)       ║
// ║    3. analyzePPEStatus recebe poseResult → usa regiões anatômicas reais  ║
// ║    4. Fallback: sem pose → usa ONNX Person bbox (V27-V31 behavior)       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Bugs corrigidos mantidos:
//   V1: skip se vídeo não pronto (videoWidth === 0)
//   V2: isActiveRef setado após play()
//   V3: loopGenRef invalida loops stale
//   V4: stream cleanup no catch
//   V5: resetPoseTimestamp em start/stop
//   V6: resetSmoother quando config muda
//   B1: verificação de loopGen após video.play()

import { useRef, useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge }  from "@/components/ui/badge";
import {
  loadModel, isModelLoaded, runInference, runInferenceOnCrop,
  parseOutput, updateTracks, resetTracks,
  remapCropDetections, mergeMultiScaleDetections, HEAD_PPE_CLASSES,
  analyzePPEStatus, drawDetections,
  loadPoseLandmarker, isPoseLoaded, detectPoseFromVideo,
  resetSmoother, resetPoseTimestamp, buildPoseResult,
  getEnabledClasses,
  type PPEStatus, type PoseResult,
} from "@/lib/ppe";
import { usePPEConfig }     from "@/hooks/usePPEConfig";
import { PPESidebar }       from "@/components/PPESidebar";
import { PPESettingsPanel } from "@/components/PPESettingsPanel";
import { Camera, CameraOff, Shield, Loader2 } from "lucide-react";

const Index = () => {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const streamRef    = useRef<MediaStream | null>(null);
  const frameCounterRef = useRef(0);
  const canvasSizeRef   = useRef({ w: 0, h: 0 });
  const inferringRef    = useRef(false);
  const isActiveRef     = useRef(false);
  const loopGenRef      = useRef(0);

  // Cache da pose — persiste entre frames não-pose (poseEveryNFrames)
  const cachedPoseRef = useRef<PoseResult | null>(null);

  const { config } = usePPEConfig();
  const configRef  = useRef(config);
  configRef.current = config;

  const [running,      setRunning]      = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelReady,   setModelReady]   = useState(false);
  const [modelError,   setModelError]   = useState<string | null>(null);
  const [fps,          setFps]          = useState(0);
  const [showDebug,    setShowDebug]    = useState(false);
  const showDebugRef   = useRef(showDebug);
  showDebugRef.current = showDebug;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ppeStatus, setPpeStatus] = useState<PPEStatus>({
    person:      null,
    personCount: 0,
    violations:  [],
    classStatus: {},
    poseActive:  false,
  });

  const lastStateUpdateRef = useRef(0);
  const lastPersonSeenRef  = useRef(0);

  // V6: resetar smoother quando config muda enquanto rodando
  useEffect(() => {
    if (isActiveRef.current) resetSmoother();
  }, [config]);

  // Canvas position sync (ResizeObserver)
  useEffect(() => {
    const video     = videoRef.current;
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!video || !canvas || !container) return;

    const sync = () => {
      const vr = video.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      canvas.style.left   = `${vr.left - cr.left}px`;
      canvas.style.top    = `${vr.top  - cr.top}px`;
      canvas.style.width  = `${vr.width}px`;
      canvas.style.height = `${vr.height}px`;
    };

    const ro = new ResizeObserver(sync);
    ro.observe(video);
    video.addEventListener("loadedmetadata", sync);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      ro.disconnect();
      video.removeEventListener("loadedmetadata", sync);
      window.removeEventListener("resize", sync);
    };
  }, [running]);

  // Model init — carrega ONNX e Pose em paralelo
  useEffect(() => {
    (async () => {
      setModelLoading(true);
      setModelError(null);
      try {
        await Promise.all([
          loadModel(),
          loadPoseLandmarker().catch(e => console.warn("Pose load failed:", e)),
        ]);
        setModelReady(true);
      } catch (err) {
        setModelError(err instanceof Error ? err.message : "Erro ao carregar modelo.");
      }
      setModelLoading(false);
    })();
  }, []);

  // ── processFrame — POSE-FIRST ────────────────────────────────────────────
  const processFrame = async (video: HTMLVideoElement, onFrameProcessed: () => void) => {
    // V1: vídeo ainda sem frames
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

    const cfg = configRef.current;
    frameCounterRef.current++;

    try {
      // ── Etapa 1: POSE (independente de detectar Person no ONNX) ───────────
      //
      // Pose roda a cada poseEveryNFrames.
      // Nos outros frames, usa o cache da última pose detectada.
      //
      const shouldRunPose =
        cfg.poseEnabled &&
        isPoseLoaded() &&
        frameCounterRef.current % cfg.poseEveryNFrames === 0;

      if (shouldRunPose) {
        const landmarks = detectPoseFromVideo(video, performance.now());
        if (landmarks) {
          cachedPoseRef.current = buildPoseResult(landmarks);
        } else {
          cachedPoseRef.current = null;
        }
      }

      const poseResult = cachedPoseRef.current;

      // ── Etapa 2: ONNX full-frame ─────────────────────────────────────────
      const { data, numDetections } = await runInference(video);
      let rawDets = parseOutput(data, numDetections, cfg);

      // ── Etapa 2b: Multi-Scale — crop da cabeça para EPIs pequenos ────────
      //
      // Se pose disponível e há classes head-PPE habilitadas,
      // roda segunda inferência no crop expandido da cabeça.
      // Efetivamente triplica a resolução para Glass/Mask/Ear-protection/Helmet.
      //
      if (poseResult?.bodyRegions?.head) {
        const hasHeadPPE = getEnabledClasses(cfg).some(
          c => HEAD_PPE_CLASSES.has(c.name) && c.name !== "Person"
        );
        if (hasHeadPPE) {
          const head = poseResult.bodyRegions.head;
          const expand = 1.6;
          const hcx = head.x * video.videoWidth;
          const hcy = head.y * video.videoHeight;
          const hw  = head.w * video.videoWidth * expand;
          const hh  = head.h * video.videoHeight * expand;

          const cx = Math.max(0, Math.round(hcx - hw / 2));
          const cy = Math.max(0, Math.round(hcy - hh / 2));
          const cw = Math.min(Math.round(hw), video.videoWidth  - cx);
          const ch = Math.min(Math.round(hh), video.videoHeight - cy);

          if (cw > 40 && ch > 40) {
            const cropResult = await runInferenceOnCrop(video, cx, cy, cw, ch);
            const cropDets   = parseOutput(cropResult.data, cropResult.numDetections, cfg);
            const remapped   = remapCropDetections(cropDets, cx, cy, cw, ch, video.videoWidth, video.videoHeight);
            rawDets = mergeMultiScaleDetections(rawDets, remapped);
          }
        }
      }

      const tracked = updateTracks(rawDets);

      // ── Etapa 3: Analisar PPE com Pose-first ──────────────────────────────
      const status = analyzePPEStatus(
        tracked, cfg, video.videoWidth, video.videoHeight, poseResult
      );

      // ── Etapa 4: Draw ─────────────────────────────────────────────────────
      const canvas = canvasRef.current;
      if (canvas) {
        if (
          canvasSizeRef.current.w !== video.videoWidth ||
          canvasSizeRef.current.h !== video.videoHeight
        ) {
          canvas.width  = video.videoWidth;
          canvas.height = video.videoHeight;
          canvasSizeRef.current = { w: video.videoWidth, h: video.videoHeight };
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawDetections(
            ctx,
            status.person ? [status.person] : [],
            tracked,
            video.videoWidth, video.videoHeight,
            canvas.width,     canvas.height,
            showDebugRef.current
          );
        }
      }

      if (status.personCount > 0) lastPersonSeenRef.current = performance.now();
      if (!isActiveRef.current) return;

      const now = performance.now();
      if (now - lastStateUpdateRef.current > 200) {
        lastStateUpdateRef.current = now;
        // Manter status anterior durante gap curto de detecção (oclusão momentânea)
        if (status.personCount === 0 && now - lastPersonSeenRef.current < 800) {
          // não atualizar
        } else {
          setPpeStatus(status);
        }
      }

      onFrameProcessed();
    } catch (err) {
      console.error("Inference error:", err);
    }
  };

  // ── startDetection ───────────────────────────────────────────────────────
  const startDetection = useCallback(async () => {
    if (!isModelLoaded()) return;

    loopGenRef.current++;
    const myGen = loopGenRef.current;

    resetTracks();
    resetSmoother();
    resetPoseTimestamp();
    cachedPoseRef.current   = null;
    frameCounterRef.current = 0;
    inferringRef.current    = false;

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      if (loopGenRef.current !== myGen) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      // B1: verificar geração após play() — stop pode ter sido chamado durante await
      if (loopGenRef.current !== myGen) {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        video.srcObject   = null;
        return;
      }

      isActiveRef.current = true;
      setRunning(true);

      let lastTime   = performance.now();
      let frameCount = 0;

      const loop = () => {
        if (loopGenRef.current !== myGen) return;
        if (!videoRef.current || video.paused) return;

        if (!inferringRef.current) {
          inferringRef.current = true;
          processFrame(video, () => { frameCount++; }).finally(() => {
            inferringRef.current = false;
          });
        }

        const now = performance.now();
        if (now - lastTime >= 1000) {
          setFps(frameCount);
          frameCount = 0;
          lastTime   = now;
        }

        animFrameRef.current = requestAnimationFrame(loop);
      };

      animFrameRef.current = requestAnimationFrame(loop);

    } catch (err) {
      console.error("Camera error:", err);
      stream?.getTracks().forEach(t => t.stop());
      streamRef.current    = null;
      isActiveRef.current  = false;
    }
  }, []);

  // ── stopDetection ────────────────────────────────────────────────────────
  const stopDetection = useCallback(() => {
    loopGenRef.current++;
    isActiveRef.current = false;

    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current     = null;
    inferringRef.current  = false;
    cachedPoseRef.current = null;
    canvasSizeRef.current = { w: 0, h: 0 };

    resetTracks();
    resetSmoother();
    resetPoseTimestamp();

    setRunning(false);
    setPpeStatus({ person: null, personCount: 0, violations: [], classStatus: {}, poseActive: false });

    if (videoRef.current) videoRef.current.srcObject = null;
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
  }, []);

  const isSafe = ppeStatus.violations.length === 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <h1 className="text-lg font-bold tracking-tight text-foreground">
            Safe<span className="text-primary">View</span> EPI
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Indicador visual de qual engine está ativa */}
          {running && (
            <Badge
              variant="outline"
              className={`font-mono text-[10px] ${
                ppeStatus.poseActive
                  ? "border-primary/50 text-primary"
                  : "border-muted-foreground/30 text-muted-foreground"
              }`}
            >
              {ppeStatus.poseActive ? "POSE" : "ONNX"}
            </Badge>
          )}
          {running && ppeStatus.personCount > 0 && (
            <Badge className={`font-mono text-xs ${
              isSafe
                ? "bg-safe text-safe-foreground"
                : "bg-destructive text-destructive-foreground animate-pulse-alert"
            }`}>
              {isSafe ? "SEGURO" : "VIOLAÇÃO"}
            </Badge>
          )}
          <Button
            onClick={running ? stopDetection : startDetection}
            disabled={modelLoading || !modelReady}
            variant={running ? "destructive" : "default"}
            size="sm"
          >
            {modelLoading
              ? (<><Loader2 className="h-4 w-4 animate-spin" />Carregando modelo...</>)
              : running
              ? (<><CameraOff className="h-4 w-4" />Parar</>)
              : (<><Camera className="h-4 w-4" />Iniciar</>)}
          </Button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div ref={containerRef} className="flex-1 relative flex items-center justify-center bg-background overflow-hidden">
          {!running && (
            <div className="text-center space-y-4 p-8">
              <div className="w-24 h-24 rounded-full bg-secondary flex items-center justify-center mx-auto">
                <Camera className="h-10 w-10 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground text-sm max-w-md">
                {modelLoading
                  ? "Carregando modelos ONNX + Pose..."
                  : modelReady
                  ? 'Clique em "Iniciar" para ativar a webcam.'
                  : modelError ?? "Erro ao carregar o modelo."}
              </p>
              {modelLoading && <Loader2 className="h-6 w-6 animate-spin text-primary mx-auto" />}
            </div>
          )}
          <video
            ref={videoRef}
            className={`max-w-full max-h-[calc(100vh-120px)] ${running ? "block" : "hidden"}`}
            style={{ transform: "scaleX(-1)" }}
            playsInline
            muted
          />
          <canvas
            ref={canvasRef}
            className={`absolute pointer-events-none ${running ? "block" : "hidden"}`}
            style={{ transform: "scaleX(-1)" }}
          />
        </div>

        <PPESidebar
          ppeStatus={ppeStatus}
          running={running}
          showDebug={showDebug}
          onToggleDebug={() => setShowDebug(s => !s)}
          onOpenSettings={() => setSettingsOpen(true)}
          fps={fps}
          config={config}
        />
      </div>

      <PPESettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};

export default Index;
