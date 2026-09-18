param([ValidateSet('ask','all','claude','codex','none')][string]$Skills = 'ask', [string]$SkillsDir = '')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$base = if ($env:PAIRLOBBY_DOWNLOAD_BASE) { $env:PAIRLOBBY_DOWNLOAD_BASE } else { 'https://pairlobby.com' }
$root = if ($env:PAIRLOBBY_INSTALL_DIR) { $env:PAIRLOBBY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'PairLobby' }
if ($Skills -eq 'ask') {
    $Skills = 'none'
    if ([Console]::IsInputRedirected) {
        Write-Host 'No interactive terminal; skipping agent skills. Use -Skills all, claude or codex to include them.'
    } else {
        do {
            $answer = (Read-Host 'Install agent skills? [y/N]').Trim().ToLowerInvariant()
        } while ($answer -notin @('', 'y', 'yes', 'n', 'no'))
        if ($answer -in @('y', 'yes')) {
            do {
                $choice = (Read-Host 'Which agents? 1) Claude Code  2) Codex  3) Both [3]').Trim().ToLowerInvariant()
            } while ($choice -notin @('', '1', 'claude', 'claude code', '2', 'codex', '3', 'both', 'all'))
            $Skills = if ($choice -in @('1', 'claude', 'claude code')) { 'claude' } elseif ($choice -in @('2', 'codex')) { 'codex' } else { 'all' }
        }
    }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('pairlobby-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { throw 'This installer requires tar.exe (included with Windows 10 and later).' }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($node) { $node.Source } else { $null }
    $supported = $false
    if ($nodePath) {
        & $nodePath -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'
        $supported = $LASTEXITCODE -eq 0
    }
    if (-not $supported) {
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { 'x64' } else { throw 'PairLobby requires 64-bit Windows (x64 or ARM64).' }
        Write-Host 'Installing a private Node.js runtime...'
        $sums = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
        $match = [regex]::Match($sums, "(?m)^([a-f0-9]{64})\s+(node-v[0-9.]+-win-$arch\.zip)\s*$")
        if (-not $match.Success) { throw 'No compatible Node.js runtime found.' }
        $archive = $match.Groups[2].Value
        $zip = Join-Path $work 'node.zip'
        Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v22.x/$archive" -OutFile $zip
        if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Node.js download checksum failed.' }
        Expand-Archive -Path $zip -DestinationPath $work
        $runtime = $archive.Substring(0, $archive.Length - 4)
        $runtimeRoot = Join-Path $root 'runtimes'
        New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
        $destination = Join-Path $runtimeRoot $runtime
        if (-not (Test-Path $destination)) { Move-Item (Join-Path $work $runtime) $destination }
        $nodePath = Join-Path $destination 'node.exe'
    }
    $installer = Join-Path $work 'install.mjs'
    Invoke-WebRequest -UseBasicParsing "$base/install.mjs" -OutFile $installer
    $installerArgs = @($installer, '--skills', $Skills)
    if ($SkillsDir) { $installerArgs += @('--skills-dir', $SkillsDir) }
    & $nodePath @installerArgs
    if ($LASTEXITCODE -ne 0) { throw "PairLobby installation failed (exit $LASTEXITCODE)." }
    if ($env:PAIRLOBBY_SKIP_PATH -ne '1') {
        $bin = if ($env:PAIRLOBBY_BIN_DIR) { $env:PAIRLOBBY_BIN_DIR } else { Join-Path $root 'bin' }
        if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
    }
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
