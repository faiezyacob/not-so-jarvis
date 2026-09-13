$ErrorActionPreference = 'Stop'

function Test-NodeInstalled {
    return [bool](Get-Command node -ErrorAction SilentlyContinue)
}

if (Test-NodeInstalled) { exit 0 }

Write-Host 'Node.js was not found on this system.' -ForegroundColor Yellow

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Write-Host 'Attempting to install Node.js LTS with winget...'
    & winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    $code = $LASTEXITCODE
    if ($code -eq 0 -or $code -eq -1978335189) {
        Write-Host 'Node.js installed via winget.' -ForegroundColor Green
        exit 0
    }
    Write-Host "winget could not install Node.js (exit $code); falling back to a direct download." -ForegroundColor Yellow
}
else {
    Write-Host 'winget is not available; downloading Node.js from nodejs.org...'
}

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }

Write-Host 'Looking up the latest Node.js LTS release...'
try {
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
}
catch {
    Write-Host "Could not reach nodejs.org: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$lts = $releases | Where-Object { $_.lts -ne $false } | Select-Object -First 1
if (-not $lts) {
    Write-Host 'Could not determine the latest Node.js LTS release.' -ForegroundColor Red
    exit 1
}

$version = $lts.version
$fileName = "node-$version-$arch.msi"
$url = "https://nodejs.org/dist/$version/$fileName"
$destination = Join-Path $env:TEMP $fileName

Write-Host "Downloading $url ..."
try {
    Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
}
catch {
    Write-Host "Download failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "Installing Node.js $version (approve the administrator prompt if it appears)..."
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$destination`" /qn /norestart" -Verb RunAs -Wait -PassThru
if ($process.ExitCode -ne 0) {
    Write-Host "Node.js installer exited with code $($process.ExitCode)." -ForegroundColor Red
    exit 1
}

Remove-Item -LiteralPath $destination -ErrorAction SilentlyContinue
Write-Host "Node.js $version installed successfully." -ForegroundColor Green
exit 0
