$ErrorActionPreference = 'Stop'

$script:HadErrors = $false
$cliArgs = @($args | ForEach-Object { [string]$_ })

function Has-Flag {
  param([string]$Flag)
  return $cliArgs -contains $Flag
}

function Resolve-FirstExistingPath {
  param([string[]]$Candidates)
  foreach ($candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Get-ListeningProcessInfo {
  param([int]$Port)

  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
    if ($connection) {
      return [pscustomobject]@{
        Pid = [int]$connection.OwningProcess
      }
    }
  } catch {
  }

  $match = netstat -ano | Select-String -Pattern "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" | Select-Object -First 1
  if ($match -and $match.Matches.Count -gt 0) {
    return [pscustomobject]@{
      Pid = [int]$match.Matches[0].Groups[1].Value
    }
  }

  return $null
}

function Get-ProcessInfoByImageName {
  param([string]$ImageName)

  try {
    return Get-CimInstance Win32_Process -Filter "Name = '$ImageName'" -ErrorAction Stop | Select-Object -First 1
  } catch {
    return $null
  }
}

function Get-CommandPath {
  param([string]$Name)

  try {
    return (Get-Command $Name -ErrorAction Stop).Source
  } catch {
    return $null
  }
}

function Mark-Error {
  param([string]$Message)
  $script:HadErrors = $true
  Write-Host $Message -ForegroundColor Red
}

function Start-ManagedProcess {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [hashtable]$Environment = @{},
    [string]$LogName = $Name,
    [bool]$ShowWindow = $false
  )

  if (-not $FilePath) {
    Mark-Error "[ERR] Executable introuvable pour $Name."
    return $null
  }

  $stdoutPath = Join-Path $launcherLogDir "$LogName.out.log"
  $stderrPath = Join-Path $launcherLogDir "$LogName.err.log"
  $previousEnv = @{}

  foreach ($entry in $Environment.GetEnumerator()) {
    $key = [string]$entry.Key
    $previousEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, [string]$entry.Value, 'Process')
  }

  try {
    $params = @{
      FilePath = $FilePath
      ArgumentList = $ArgumentList
      WorkingDirectory = $WorkingDirectory
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
      PassThru = $true
    }
    if ($ShowWindow) {
      $params.WindowStyle = 'Normal'
    } else {
      $params.WindowStyle = 'Hidden'
    }

    $process = Start-Process @params
    Write-Host "[A11 LOCAL] $Name demarre (PID $($process.Id)). Logs: $stdoutPath"
    return $process
  } catch {
    Mark-Error "[ERR] Echec lancement $Name : $($_.Exception.Message)"
    return $null
  } finally {
    foreach ($entry in $previousEnv.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
    }
  }
}

$rootDir = Split-Path -Parent $PSCommandPath
$backendDir = Join-Path $rootDir 'apps\server'
$ttsDir = Join-Path $rootDir 'apps\tts'
$frontendDir = Join-Path $rootDir '..\a11frontendnetlify\apps\web'
$launcherRuntimeDir = Join-Path $rootDir '.a11-launcher'
$launcherLogDir = Join-Path $launcherRuntimeDir 'logs'
New-Item -ItemType Directory -Force -Path $launcherLogDir | Out-Null

$backendPort = 3000
$frontendPort = 5173
$ttsPort = 5002
$llmPort = 8080

$localFrontendUrl = "http://127.0.0.1:$frontendPort"
$localApiUrl = "http://127.0.0.1:$backendPort"
$localTtsUrl = "http://127.0.0.1:$ttsPort"
$localLlmBase = "http://127.0.0.1:$llmPort"
$localLlmRouterUrl = 'http://127.0.0.1:4545'
$publicFrontendUrl = 'https://a11.funesterie.pro'
$publicApiUrl = 'https://api.funesterie.pro'
$tunnelPublicUrl = 'https://api.funesterie.me'

$checkOnly = Has-Flag '--check-only'
$openBrowser = -not $checkOnly -and -not (Has-Flag '--no-open')
$pauseAtEnd = -not (Has-Flag '--no-pause')
$showWindows = Has-Flag '--show-windows'
$startBackend = -not (Has-Flag '--no-backend')
$startFrontend = -not (Has-Flag '--no-frontend')
$startTts = -not (Has-Flag '--no-tts')
$startLlm = -not (Has-Flag '--no-llm')
$startTunnel = -not (Has-Flag '--no-tunnel')
$startNgrok = -not (Has-Flag '--no-ngrok')

$npmCmd = Resolve-FirstExistingPath @((Get-CommandPath 'npm.cmd'), (Get-CommandPath 'npm'))
$pythonCmd = Resolve-FirstExistingPath @((Get-CommandPath 'python'))
$llmExe = Resolve-FirstExistingPath @(
  (Join-Path $rootDir '..\a11llm\llm\server\llama-server.exe'),
  (Join-Path $rootDir '..\..\a11llm\llm\server\llama-server.exe'),
  'D:\funesterie\a11\a11llm\llm\server\llama-server.exe'
)

$modelPath = Resolve-FirstExistingPath @(
  (Join-Path $rootDir '..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf'),
  (Join-Path $rootDir '..\..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf'),
  'D:\funesterie\a11\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf'
)

$ngrokExe = Resolve-FirstExistingPath @(
  (Join-Path $rootDir 'apps\tts\ngrok.exe'),
  (Join-Path $rootDir '..\a11llm\llm\ngrok.exe'),
  (Join-Path $rootDir '..\..\Tools\ngrok.exe'),
  (Join-Path $rootDir '..\..\ngrok.exe'),
  'D:\Tools\ngrok\ngrok.exe',
  'D:\funesterie\a11\ngrok.exe'
)

$cloudflaredExe = Resolve-FirstExistingPath @(
  'C:\Program Files\cloudflared\cloudflared.exe',
  (Get-CommandPath 'cloudflared')
)
$cloudflaredConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml'

$ttsModelPath = Resolve-FirstExistingPath @(
  (Join-Path $ttsDir 'fr_FR-siwis-medium.onnx'),
  (Join-Path $backendDir 'tts\fr_FR-siwis-medium.onnx')
)
$ttsPiperPath = Resolve-FirstExistingPath @(
  (Join-Path $ttsDir 'piper.exe'),
  (Join-Path $backendDir 'tts\piper.exe')
)
$ttsEspeakPath = Resolve-FirstExistingPath @(
  (Join-Path $ttsDir 'espeak-ng-data'),
  (Join-Path $backendDir 'tts\espeak-ng-data')
)

Write-Host "[A11 LOCAL] Workspace backend  : $rootDir"
Write-Host "[A11 LOCAL] Workspace frontend : $frontendDir"
Write-Host "[A11 LOCAL] Front local        : $localFrontendUrl"
Write-Host "[A11 LOCAL] API locale         : $localApiUrl"
Write-Host "[A11 LOCAL] API publique       : $publicApiUrl"
Write-Host "[A11 LOCAL] Tunnel backend     : $tunnelPublicUrl"
Write-Host "[A11 LOCAL] Front public       : $publicFrontendUrl"
Write-Host "[A11 LOCAL] Logs               : $launcherLogDir"
Write-Host ""

if ($startBackend) {
  $portInfo = Get-ListeningProcessInfo -Port $backendPort
  if ($portInfo) {
    Write-Host "[WARN] Backend deja actif sur $backendPort (PID $($portInfo.Pid)). Lancement saute."
  } elseif (-not (Test-Path (Join-Path $backendDir 'package.json'))) {
    Mark-Error "[ERR] Backend introuvable : $backendDir"
  } elseif (-not $npmCmd) {
    Mark-Error '[ERR] npm introuvable dans le PATH. Backend non lance.'
  } elseif ($checkOnly) {
    Write-Host "[CHECK] Backend pret : $backendDir"
  } else {
    Start-ManagedProcess `
      -Name 'A11 Backend' `
      -WorkingDirectory $backendDir `
      -FilePath $npmCmd `
      -ArgumentList @('run', 'dev') `
      -Environment @{
        PORT = $backendPort
        NODE_ENV = 'development'
        BACKEND = 'local'
        LLAMA_BASE = $localLlmBase
        LOCAL_LLM_URL = $localLlmBase
        LOCAL_LLM_PORT = $llmPort
        LOCAL_DEFAULT_MODEL = 'llama3.2:latest'
        LLM_ROUTER_URL = $localLlmRouterUrl
        TTS_PORT = $ttsPort
        TTS_URL = $localTtsUrl
        TTS_BASE_URL = $localTtsUrl
        TTS_PUBLIC_BASE_URL = $localTtsUrl
        APP_URL = $localFrontendUrl
        FRONT_URL = $publicFrontendUrl
        PUBLIC_API_URL = $tunnelPublicUrl
      } `
      -LogName 'backend' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] Backend desactive.'
}

if ($startFrontend) {
  $portInfo = Get-ListeningProcessInfo -Port $frontendPort
  if ($portInfo) {
    Write-Host "[WARN] Frontend deja actif sur $frontendPort (PID $($portInfo.Pid)). Lancement saute."
  } elseif (-not (Test-Path (Join-Path $frontendDir 'package.json'))) {
    Mark-Error "[ERR] Frontend introuvable : $frontendDir"
  } elseif (-not $npmCmd) {
    Mark-Error '[ERR] npm introuvable dans le PATH. Frontend non lance.'
  } elseif ($checkOnly) {
    Write-Host "[CHECK] Frontend pret : $frontendDir"
  } else {
    Start-ManagedProcess `
      -Name 'A11 Frontend' `
      -WorkingDirectory $frontendDir `
      -FilePath $npmCmd `
      -ArgumentList @('run', 'dev') `
      -Environment @{
        VITE_API_BASE = $localApiUrl
        VITE_API_BASE_URL = $localApiUrl
        VITE_API_URL = $localApiUrl
        VITE_A11_API_BASE_URL = $localApiUrl
        VITE_A11_LOCAL_API_BASE_URL = $localApiUrl
        VITE_A11_ONLINE_API_BASE_URL = $publicApiUrl
        VITE_LLM_ROUTER_URL = $localLlmRouterUrl
      } `
      -LogName 'frontend' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] Frontend desactive.'
}

if ($startTts) {
  $portInfo = Get-ListeningProcessInfo -Port $ttsPort
  if ($portInfo) {
    Write-Host "[WARN] TTS deja actif sur $ttsPort (PID $($portInfo.Pid)). Lancement saute."
  } elseif (-not $ttsModelPath) {
    Mark-Error "[ERR] Modele TTS introuvable : $ttsDir"
  } elseif (-not $ttsPiperPath) {
    Mark-Error "[ERR] Executable Piper introuvable : $ttsDir"
  } elseif (-not $pythonCmd) {
    Mark-Error '[ERR] Python introuvable dans le PATH. TTS non lance.'
  } elseif ($checkOnly) {
    Write-Host "[CHECK] TTS pret : $ttsDir"
  } else {
    Start-ManagedProcess `
      -Name 'A11 TTS' `
      -WorkingDirectory $ttsDir `
      -FilePath $pythonCmd `
      -ArgumentList @('siwis.py') `
      -Environment @{
        PORT = $ttsPort
        BASE_URL = $localTtsUrl
        MODEL_PATH = $ttsModelPath
        PIPER_PATH = $ttsPiperPath
        ESPEAK_DATA_PATH = $ttsEspeakPath
        A11_AVATAR_UPDATE_URL = "$localApiUrl/api/avatar/update"
      } `
      -LogName 'tts' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] TTS desactive.'
}

if ($startLlm) {
  $portInfo = Get-ListeningProcessInfo -Port $llmPort
  if ($portInfo) {
    Write-Host "[WARN] LLM deja actif sur $llmPort (PID $($portInfo.Pid)). Lancement saute."
  } elseif (-not $llmExe) {
    Mark-Error '[ERR] LLM non trouve.'
  } elseif (-not $modelPath) {
    Mark-Error '[ERR] Modele LLM introuvable.'
  } elseif ($checkOnly) {
    Write-Host "[CHECK] LLM pret : $llmExe"
  } else {
    Start-ManagedProcess `
      -Name 'A11 LLM' `
      -WorkingDirectory (Split-Path -Parent $llmExe) `
      -FilePath $llmExe `
      -ArgumentList @('-m', $modelPath, '--port', "$llmPort", '--host', '127.0.0.1') `
      -Environment @{} `
      -LogName 'llama-server' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] LLM desactive.'
}

if ($startTunnel) {
  $processInfo = Get-ProcessInfoByImageName -ImageName 'cloudflared.exe'
  if ($processInfo) {
    Write-Host "[WARN] Cloudflared deja actif (PID $($processInfo.ProcessId)). Lancement saute."
  } elseif (-not $cloudflaredExe) {
    Mark-Error '[ERR] cloudflared introuvable. Tunnel backend non lance.'
  } elseif (-not (Test-Path $cloudflaredConfig)) {
    Mark-Error "[ERR] Config cloudflared introuvable : $cloudflaredConfig"
  } elseif ($checkOnly) {
    Write-Host "[CHECK] Tunnel backend pret : $cloudflaredExe"
  } else {
    Start-ManagedProcess `
      -Name 'A11 Tunnel API' `
      -WorkingDirectory (Split-Path -Parent $cloudflaredExe) `
      -FilePath $cloudflaredExe `
      -ArgumentList @('tunnel', '--config', $cloudflaredConfig, 'run') `
      -Environment @{} `
      -LogName 'cloudflared' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] Tunnel backend desactive.'
}

if ($startNgrok) {
  $processInfo = Get-ProcessInfoByImageName -ImageName 'ngrok.exe'
  if ($processInfo) {
    Write-Host "[WARN] ngrok deja actif (PID $($processInfo.ProcessId)). Lancement saute."
  } elseif (-not $ngrokExe) {
    Mark-Error '[ERR] ngrok introuvable.'
  } elseif ($checkOnly) {
    Write-Host "[CHECK] ngrok pret : $ngrokExe"
  } else {
    Start-ManagedProcess `
      -Name 'A11 NGROK' `
      -WorkingDirectory (Split-Path -Parent $ngrokExe) `
      -FilePath $ngrokExe `
      -ArgumentList @('http', "$llmPort") `
      -Environment @{} `
      -LogName 'ngrok' `
      -ShowWindow $showWindows | Out-Null
  }
} else {
  Write-Host '[A11 LOCAL] ngrok desactive.'
}

if ($openBrowser) {
  Write-Host "[A11 LOCAL] Ouverture du frontend local..."
  Start-Process $localFrontendUrl | Out-Null
}

Write-Host ""
Write-Host "[A11 LOCAL] Resume"
Write-Host "  - frontend local : $localFrontendUrl"
Write-Host "  - backend local  : $localApiUrl"
Write-Host "  - TTS local      : $localTtsUrl"
Write-Host "  - LLM local      : $localLlmBase"
Write-Host "  - router local   : $localLlmRouterUrl"
Write-Host "  - front public   : $publicFrontendUrl"
Write-Host "  - tunnel backend : $tunnelPublicUrl"
Write-Host "  - logs           : $launcherLogDir"
Write-Host ""
Write-Host "[A11 LOCAL] Utilisation :"
Write-Host "  - normal         : double-clic sur ce fichier"
Write-Host "  - check only     : start-all-a11.bat --check-only"
Write-Host "  - sans frontend  : start-all-a11.bat --no-frontend"
Write-Host "  - sans tunnel    : start-all-a11.bat --no-tunnel"
Write-Host "  - sans ngrok     : start-all-a11.bat --no-ngrok"
Write-Host "  - voir consoles  : start-all-a11.bat --show-windows"
Write-Host "  - sans pause     : start-all-a11.bat --no-pause"

if ($pauseAtEnd) {
  [void](Read-Host 'Appuie sur Entree pour fermer ce lanceur')
}

if ($script:HadErrors) { exit 1 }
exit 0
