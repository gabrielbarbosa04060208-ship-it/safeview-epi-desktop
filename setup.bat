@echo off
setlocal enabledelayedexpansion

title SafeView EPI Desktop V33 - Setup

echo.
echo ============================================
echo   SafeView EPI Desktop V33 - Setup
echo ============================================
echo.

REM --- Verificacoes de dependencias ---
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
    pause
    exit /b 1
)

where curl >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] curl nao encontrado. Atualize o Windows 10/11.
    pause
    exit /b 1
)

echo [OK] Node.js e curl encontrados.
echo.

REM ============================================================
REM  [1/6] Instalar dependencias do app React
REM ============================================================
echo [1/6] Instalando dependencias do app (pode demorar alguns minutos)...
pushd apps\safeviewepi
call npm install --legacy-peer-deps
if %ERRORLEVEL% NEQ 0 (
    popd
    echo [ERRO] Falha no npm install.
    pause
    exit /b 1
)
popd
echo [OK] Dependencias instaladas.
echo.

REM ============================================================
REM  [2/6] Copiar WASM do ONNX Runtime para public/
REM ============================================================
echo [2/6] Copiando ONNX Runtime WASM para public/...
if not exist "apps\safeviewepi\public" mkdir "apps\safeviewepi\public"
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm-simd-threaded.wasm"      "apps\safeviewepi\public\" >nul 2>nul
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm-simd-threaded.jsep.wasm" "apps\safeviewepi\public\" >nul 2>nul
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm-simd.wasm"               "apps\safeviewepi\public\" >nul 2>nul
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm.wasm"                    "apps\safeviewepi\public\" >nul 2>nul
REM V21: copiar .mjs do ONNX (importado dinamicamente mesmo com numThreads=1)
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm-simd-threaded.mjs"        "apps\safeviewepi\public\" >nul 2>nul
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm-simd.mjs"                "apps\safeviewepi\public\" >nul 2>nul
copy /Y "apps\safeviewepi\node_modules\onnxruntime-web\dist\ort-wasm.mjs"                     "apps\safeviewepi\public\" >nul 2>nul
echo [OK] ONNX WASM e MJS copiados.
echo.

REM ============================================================
REM  [3/6] Copiar WASM do MediaPipe para public/mediapipe-wasm/
REM ============================================================
echo [3/6] Copiando MediaPipe WASM para public/mediapipe-wasm/...
if not exist "apps\safeviewepi\public\mediapipe-wasm" mkdir "apps\safeviewepi\public\mediapipe-wasm"
xcopy /Y /E /Q "apps\safeviewepi\node_modules\@mediapipe\tasks-vision\wasm" "apps\safeviewepi\public\mediapipe-wasm\" >nul 2>nul
echo [OK] MediaPipe WASM copiado.
echo.

REM ============================================================
REM  [4/6] Baixar modelo Pose Landmarker
REM ============================================================
echo [4/6] Baixando modelo Pose Landmarker (~3MB)...
if not exist "apps\safeviewepi\public\models" mkdir "apps\safeviewepi\public\models"
if not exist "apps\safeviewepi\public\models\pose_landmarker_lite.task" (
    curl -L --retry 3 --retry-delay 2 --max-time 60 "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" -o "apps\safeviewepi\public\models\pose_landmarker_lite.task"
    if %ERRORLEVEL% NEQ 0 (
        echo [AVISO] Falha ao baixar modelo de pose. O app funcionara sem deteccao de pose.
    ) else (
        echo [OK] Modelo baixado.
    )
) else (
    echo [OK] Modelo ja existe.
)
echo.

REM ============================================================
REM  [5/6] Instalar Electron e compilar
REM ============================================================
echo [5/6] Instalando Electron e compilando o app...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Falha no npm install do Electron.
    pause
    exit /b 1
)
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Falha na compilacao. Verifique erros acima.
    pause
    exit /b 1
)
echo [OK] Compilacao concluida.
echo.

REM ============================================================
REM  [6/6] Abrir instalador
REM ============================================================
echo [6/6] Abrindo instalador...
for %%f in ("dist-electron\SafeView EPI Desktop Setup*.exe") do (
    echo Instalador: %%f
    start "" "%%f"
)

echo.
echo ============================================
echo   Setup concluido com sucesso!
echo ============================================
echo.
pause
