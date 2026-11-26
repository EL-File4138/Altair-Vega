# Run with Windows PowerShell, whose compiler can emit the small test executable.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'startup.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('altair-vega-launcher-test-' + [Guid]::NewGuid().ToString('N'))
$beforePath = $env:PATH
$beforePin = $env:ALTAIR_VEGA_BIN_SHA256
$beforeUrl = $env:ALTAIR_VEGA_BIN_URL
$beforeChecksumUrl = $env:ALTAIR_VEGA_BIN_CHECKSUM_URL
$jobs = @()
function Assert-Test($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
    $env:ALTAIR_VEGA_BIN_SHA256 = $null
    $env:ALTAIR_VEGA_BIN_URL = $null
    $env:ALTAIR_VEGA_BIN_CHECKSUM_URL = $null
    New-Item -ItemType Directory -Path $work | Out-Null
    $cache = Join-Path $work 'cache'
    $probe = Join-Path $work 'probe'
    New-Item -ItemType Directory -Path $cache, $probe | Out-Null
    $stub = Join-Path $work 'stub.exe'
    Add-Type -OutputAssembly $stub -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class AltairLauncherTest {
    public static int Main(string[] args) {
        File.AppendAllText(Path.Combine(args[0], "executables"), Assembly.GetExecutingAssembly().Location + Environment.NewLine);
        File.AppendAllText(Path.Combine(args[0], "runtime-roots"), Environment.GetEnvironmentVariable("ALTAIR_VEGA_RUNTIME_ROOT") + Environment.NewLine);
        return 0;
    }
}
'@
    (Get-FileHash -LiteralPath $stub -Algorithm SHA256).Hash | Set-Content -LiteralPath "$stub.sha256" -Encoding ascii
    $binaryUrl = ([Uri]$stub).AbsoluteUri
    & $launcher -Url $binaryUrl -RuntimeParent $cache -- $probe
    Assert-Test ($LASTEXITCODE -eq 0) 'first launch failed'
    # A valid cached executable must not need the original download again.
    Move-Item -LiteralPath $stub -Destination "$stub.original"
    & $launcher -Url $binaryUrl -RuntimeParent $cache -- $probe
    Assert-Test ($LASTEXITCODE -eq 0) 'cached launch failed'
    $executables = @(Get-Content -LiteralPath (Join-Path $probe 'executables'))
    Assert-Test ($executables.Count -eq 2 -and $executables[0] -eq $executables[1]) 'cache was not reused'
    Move-Item -LiteralPath "$stub.original" -Destination $stub
    $cachedBinary = $executables[0]
    Copy-Item -LiteralPath $cachedBinary -Destination "$work\cached.original"
    [IO.File]::WriteAllText($cachedBinary, 'not a verified executable')
    & (Join-Path (Split-Path -Parent $cachedBinary) 'bin\altair-vega.cmd') $probe
    Assert-Test ($LASTEXITCODE -ne 0) 'wrapper ran a modified cached executable'
    Copy-Item -LiteralPath "$work\cached.original" -Destination $cachedBinary -Force

    $pathBeforeHelp = $env:PATH
    . $launcher -Help
    Assert-Test ($env:PATH -eq $pathBeforeHelp) 'help changed PATH'
    $Url = 'caller sentinel'
    $preferenceBeforeSource = $ErrorActionPreference
    . $launcher -Url $binaryUrl -RuntimeParent $cache
    Assert-Test ($Url -eq 'caller sentinel' -and $ErrorActionPreference -eq $preferenceBeforeSource) 'dot sourcing changed caller state'
    & altair-vega $probe
    Assert-Test ($LASTEXITCODE -eq 0) 'sourced wrapper failed'
    $env:ALTAIR_VEGA_BIN_SHA256 = '0' * 64
    $rejected = $false
    try { & $launcher -Url $binaryUrl -RuntimeParent $cache -- $probe } catch { $rejected = $true }
    Assert-Test $rejected 'cached executable bypassed a new checksum pin'
    $env:ALTAIR_VEGA_BIN_SHA256 = $null

    foreach ($index in 1..2) {
        $jobProbe = Join-Path $work "concurrent-$index"
        New-Item -ItemType Directory -Path $jobProbe | Out-Null
        $jobs += Start-Job -ScriptBlock { param($Launcher, $Url, $Cache, $Probe); & $Launcher -Url $Url -RuntimeParent $Cache -- $Probe; if ($LASTEXITCODE) { throw 'concurrent launch failed' } } -ArgumentList $launcher, $binaryUrl, $cache, $jobProbe
    }
    $jobs | Wait-Job | Receive-Job -ErrorAction Stop
    $root = Split-Path -Parent (Get-Content -LiteralPath (Join-Path $probe 'runtime-roots') | Select-Object -First 1)
    $lease = Join-Path (Join-Path $root 'leases') "$PID"
    [IO.File]::WriteAllText($lease, [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())
    $rejected = $false
    try { & $launcher -RuntimeParent $cache -Cleanup } catch { $rejected = $true }
    Assert-Test $rejected 'cleanup removed a live process lease'
    [IO.File]::WriteAllText($lease, '0')
    & $launcher -RuntimeParent $cache -Cleanup
    Assert-Test (-not (Test-Path -LiteralPath $root)) 'cleanup retained a stale process-instance lease'
    Write-Host 'PowerShell startup launcher tests passed'
} finally {
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
    $env:PATH = $beforePath
    $env:ALTAIR_VEGA_BIN_SHA256 = $beforePin
    $env:ALTAIR_VEGA_BIN_URL = $beforeUrl
    $env:ALTAIR_VEGA_BIN_CHECKSUM_URL = $beforeChecksumUrl
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
