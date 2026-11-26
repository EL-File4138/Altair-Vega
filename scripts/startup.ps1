# Preparation runs in a child scope even when dot-sourced. Only PATH is published.
$_AltairVegaLauncherResult = & {
param(
    [string]$Url = $env:ALTAIR_VEGA_BIN_URL,
    [string]$ChecksumUrl = $env:ALTAIR_VEGA_BIN_CHECKSUM_URL,
    [string]$RuntimeParent,
    [switch]$Cleanup,
    [switch]$KeepRuntime,
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CommandArgs
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
@"
Usage: . scripts/startup.ps1 [-Url <binary-url>] [-ChecksumUrl <url>] [-RuntimeParent <dir>]
       scripts/startup.ps1 [-Url <binary-url>] [-ChecksumUrl <url>] [-RuntimeParent <dir>] [-- <args...>]
       scripts/startup.ps1 [-RuntimeParent <dir>] -Cleanup

Downloads and verifies a native Altair Vega executable once per user boot/login
scope, then reuses it from a private cache. Runtime state is retained so failed
or interrupted commands can be retried. Use -Cleanup to remove this scope.

When dot-sourced, the launcher adds its wrapper to PATH for the current shell.
It does not install anything permanently, register exit handlers, or replace
TMPDIR, TMP, TEMP, or ALTAIR_VEGA_* in the parent shell.

Environment:
  ALTAIR_VEGA_BIN_URL          Explicit binary URL when -Url is omitted.
  ALTAIR_VEGA_BIN_CHECKSUM_URL Checksum URL when -ChecksumUrl is omitted.
  ALTAIR_VEGA_BIN_SHA256       Expected SHA-256 instead of downloading a sidecar.
  ALTAIR_VEGA_GITHUB_REPO      GitHub repo for latest release lookup.

The default checksum URL is <binary-url>.sha256. Stale scopes are never removed
automatically; run -Cleanup explicitly.

-KeepRuntime is accepted for compatibility and has no effect: the cache now
persists until -Cleanup.
"@ | Write-Host
}

function Get-DefaultAltairVegaBinaryUrl {
    $repo = if ($env:ALTAIR_VEGA_GITHUB_REPO) { $env:ALTAIR_VEGA_GITHUB_REPO } else { 'EL-File4138/Altair-Vega' }
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        'X64' { $machine = 'x86_64' }
        'Arm64' { $machine = 'aarch64' }
        default { throw "unsupported architecture for default binary URL: $arch; pass -Url or set ALTAIR_VEGA_BIN_URL" }
    }
    "https://github.com/$repo/releases/latest/download/altair-vega-windows-$machine.exe"
}

function Get-AltairVegaScope {
    try { $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    catch { $user = "$env:USERDOMAIN-$env:USERNAME" }
    $user = ($user -replace '[^0-9A-Za-z._-]', '_')
    $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    try {
        $boot = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks
        return "$user-boot-$boot-session-$session"
    }
    catch {
        return "$user-login-$session"
    }
}

function Get-Sha256Text {
    param([Parameter(Mandatory = $true)][string]$Text)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))
    ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Get-NormalizedSha256 {
    param([Parameter(Mandatory = $true)][string]$Value)
    foreach ($line in $Value -split "`r?`n") {
        if ($line -match '^\s*([0-9A-Fa-f]{64})(?:\s+\*?.*)?\s*$') { return $matches[1].ToLowerInvariant() }
    }
    return $null
}

function Download-AltairVegaFile {
    param([Parameter(Mandatory = $true)][string]$SourceUrl, [Parameter(Mandatory = $true)][string]$TargetPath)
    $uri = [Uri]$SourceUrl
    if ($uri.IsFile) { Copy-Item -LiteralPath $uri.LocalPath -Destination $TargetPath -Force }
    else { Invoke-WebRequest -Uri $SourceUrl -OutFile $TargetPath }
}

function Test-ExecutableCacheDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        Assert-SafeParent -Path (Split-Path -Parent $Path)
        if (-not (Test-Path -LiteralPath $Path)) {
            $acl = [System.Security.AccessControl.DirectorySecurity]::new()
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
            foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
                $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
                    [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
                $acl.AddAccessRule($rule)
            }
            # Apply the protected ACL at creation, never after an inherited-ACL
            # directory has become visible to another user.
            if ($PSVersionTable.PSEdition -eq 'Core') {
                [System.IO.FileSystemAclExtensions]::CreateDirectory($acl, $Path) | Out-Null
            } else {
                [System.IO.Directory]::CreateDirectory($Path, $acl) | Out-Null
            }
        }
        Assert-PrivateCache -Path $Path
        $probe = Join-Path $Path ('.altair-vega-exec-probe-' + [Guid]::NewGuid().ToString('N') + '.cmd')
        Set-Content -LiteralPath $probe -Value '@exit /b 0' -NoNewline -Encoding ascii
        & $probe
        $result = $LASTEXITCODE -eq 0
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $result
    }
    catch { return $false }
}

function Assert-SafeParent {
    param([string]$Path)
    $current = Get-Item -LiteralPath $Path -Force
    $trusted = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    while ($null -ne $current) {
        if ($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "reparse-point launcher parent: $($current.FullName)" }
        $acl = Get-Acl -LiteralPath $current.FullName
        if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'foreign-owned launcher parent' }
        foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            # Other users must not be able to rename existing directories or alter ACLs.
            $unsafe = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
            if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $unsafe)) { throw 'writable launcher ancestor' }
        }
        $current = $current.Parent
    }
}

function Assert-PrivateCache {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'unsafe launcher cache' }
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = Get-Acl -LiteralPath $Path
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user) { throw 'foreign-owned launcher cache' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and @($user, 'S-1-5-18', 'S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { throw 'non-private launcher cache' }
    }
}

function Enter-AltairVegaDownloadLock {
    param([Parameter(Mandatory = $true)][string]$LockPath)
    $mutex = [System.Threading.Mutex]::new($false, ('Local\AltairVegaLauncher-' + (Get-Sha256Text -Text $LockPath.ToLowerInvariant())))
    try {
        try { $acquired = $mutex.WaitOne(300000) }
        catch [System.Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'timed out waiting for another launcher' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

function Exit-AltairVegaDownloadLock {
    param([AllowNull()]$Writer, [Parameter(Mandatory = $true)][string]$LockPath)
    if ($null -ne $Writer) { $Writer.ReleaseMutex(); $Writer.Dispose() }
}

function Write-AltairVegaWrapper {
    param([Parameter(Mandatory = $true)][string]$WrapperPath, [Parameter(Mandatory = $true)][string]$BinaryKey)
    $temporaryWrapper = "$WrapperPath.tmp.$([Guid]::NewGuid().ToString('N'))"
    $helperPath = Join-Path (Split-Path -Parent $WrapperPath) 'altair-vega-wrapper.ps1'
    @'
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$bytes = [System.Text.Encoding]::UTF8.GetBytes((Join-Path $root '.lock').ToLowerInvariant())
$hash = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
$mutex = [System.Threading.Mutex]::new($false, "Local\AltairVegaLauncher-$hash")
$lease = Join-Path (Join-Path $root 'leases') "$PID"
try {
    try { $acquired = $mutex.WaitOne(300000) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'launcher cache is busy' }
    try {
        $binary = Join-Path $PSScriptRoot '..\altair-vega.exe'
        $expected = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\altair-vega.sha256') -Raw).Trim()
        if ($expected -notmatch '^[0-9A-Fa-f]{64}$' -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $expected) { throw 'cached executable checksum verification failed; rerun the launcher' }
        [System.IO.File]::WriteAllText($lease, [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString())
    }
    finally { $mutex.ReleaseMutex() }
    & (Join-Path $PSScriptRoot '..\altair-vega.exe') @args
    $code = $LASTEXITCODE
} finally {
    $mutex.Dispose()
    Remove-Item -LiteralPath $lease -Force -ErrorAction SilentlyContinue
}
exit $code
'@ | Set-Content -LiteralPath "$helperPath.tmp" -Encoding ascii
    Move-Item -LiteralPath "$helperPath.tmp" -Destination $helperPath -Force
@"
@echo off
setlocal
set "ALTAIR_VEGA_RUNTIME_ROOT=%~dp0..\..\..\runtime"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0altair-vega-wrapper.ps1" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -LiteralPath $temporaryWrapper -NoNewline -Encoding ascii
    Move-Item -LiteralPath $temporaryWrapper -Destination $WrapperPath -Force
}

if ($Help) { Show-Usage; return }
if ($KeepRuntime) { Write-Warning '-KeepRuntime has no effect; launcher state persists until -Cleanup' }
if (-not $RuntimeParent) { $RuntimeParent = [System.IO.Path]::GetTempPath() }

$scope = Get-AltairVegaScope
$bootScope = if ($scope -match '^(.*-boot-\d+)-session-\d+$') { $matches[1] } else { $null }
$primaryCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $RuntimeParent "altair-vega-launcher-$scope"))
$fallbackParent = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData) }
$fallbackCacheRoot = [System.IO.Path]::GetFullPath((Join-Path $fallbackParent "altair-vega-launcher-$scope"))
if ($Cleanup) {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($parent in @($RuntimeParent, $fallbackParent) | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $parent)) { continue }
        Assert-SafeParent -Path $parent
        foreach ($entry in Get-ChildItem -LiteralPath $parent -Filter "altair-vega-launcher-$user-*" -Force) {
            # Local mutexes do not synchronize Windows login sessions. Never
            # clean another session's current-boot scope from this session.
            if ($entry.Name -ne "altair-vega-launcher-$scope" -and
                ((-not $bootScope) -or $entry.Name.StartsWith("altair-vega-launcher-$bootScope", [StringComparison]::OrdinalIgnoreCase) -or $entry.Name -like '*-login-*')) {
                Write-Warning "skipping another login session's cache: $($entry.FullName)"
                continue
            }
            $cacheRoot = $entry.FullName
            Assert-PrivateCache -Path $cacheRoot
            $lockPath = Join-Path $cacheRoot '.lock'
            $lockWriter = Enter-AltairVegaDownloadLock -LockPath $lockPath
            try {
                $busy = Get-Process | Where-Object { try { $_.Path -and $_.Path.StartsWith($cacheRoot + '\', [StringComparison]::OrdinalIgnoreCase) } catch { $false } }
                if ($busy) { throw "cache is in use: $cacheRoot" }
                foreach ($lease in Get-ChildItem -LiteralPath (Join-Path $cacheRoot 'leases') -ErrorAction SilentlyContinue) {
                    if ($lease.Name -notmatch '^\d+$') { throw "invalid cache lease: $cacheRoot" }
                    if ($entry.Name -ne "altair-vega-launcher-$scope") { continue }
                    $process = Get-Process -Id ([int]$lease.Name) -ErrorAction SilentlyContinue
                    if ($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq (Get-Content -LiteralPath $lease.FullName -Raw)) { throw "cache is in use: $cacheRoot" }
                }
                Remove-Item -LiteralPath $cacheRoot -Recurse -Force
                Write-Host "removed Altair Vega launcher cache: $cacheRoot"
            } finally { Exit-AltairVegaDownloadLock -Writer $lockWriter -LockPath $lockPath }
        }
    }
    return
}
if (-not $Url) { $Url = Get-DefaultAltairVegaBinaryUrl }
if (-not $ChecksumUrl -and -not $env:ALTAIR_VEGA_BIN_SHA256) { $ChecksumUrl = "$Url.sha256" }

if (Test-ExecutableCacheDirectory -Path $primaryCacheRoot) { $cacheRoot = $primaryCacheRoot }
elseif (Test-ExecutableCacheDirectory -Path $fallbackCacheRoot) { $cacheRoot = $fallbackCacheRoot; Write-Warning "$RuntimeParent is not executable; using $fallbackParent" }
else { throw "neither $RuntimeParent nor $fallbackParent can host executable Altair Vega cache files" }

$runtimeRoot = Join-Path $cacheRoot 'runtime'
$binaryKey = Get-Sha256Text -Text "$Url`n$ChecksumUrl`n$env:ALTAIR_VEGA_BIN_SHA256"
$binaryDir = Join-Path (Join-Path $cacheRoot 'binaries') $binaryKey
$binaryPath = Join-Path $binaryDir 'altair-vega.exe'
$checksumPath = Join-Path $binaryDir 'altair-vega.sha256'
$binRoot = Join-Path $binaryDir 'bin'
$wrapperPath = Join-Path $binRoot 'altair-vega.cmd'
$lockPath = Join-Path $cacheRoot '.lock'

$lockWriter = $null
try {
    $lockWriter = Enter-AltairVegaDownloadLock -LockPath $lockPath
    # Cleanup may have removed the scope while this invocation waited. Do not
    # recreate its parents through inherited-ACL New-Item calls.
    Assert-PrivateCache -Path $cacheRoot
    New-Item -ItemType Directory -Path $runtimeRoot, $binRoot, (Join-Path $cacheRoot 'leases') -Force | Out-Null
    $cacheValid = $false
    if ((Test-Path -LiteralPath $binaryPath) -and (Test-Path -LiteralPath $checksumPath)) {
        $expectedChecksum = Get-NormalizedSha256 -Value (Get-Content -LiteralPath $checksumPath -Raw)
        if ($env:ALTAIR_VEGA_BIN_SHA256) { $expectedChecksum = Get-NormalizedSha256 -Value $env:ALTAIR_VEGA_BIN_SHA256 }
        $actualChecksum = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expectedChecksum -and $expectedChecksum -eq $actualChecksum) { $cacheValid = $true }
        else { Remove-Item -LiteralPath $binaryPath, $checksumPath -Force -ErrorAction SilentlyContinue }
    }
    if (-not $cacheValid) {
        New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
        if ($env:ALTAIR_VEGA_BIN_SHA256) { $expectedChecksum = Get-NormalizedSha256 -Value $env:ALTAIR_VEGA_BIN_SHA256 }
        else {
            $checksumDownload = Join-Path $binaryDir ('.checksum.download-' + $PID)
            try { Download-AltairVegaFile -SourceUrl $ChecksumUrl -TargetPath $checksumDownload; $expectedChecksum = Get-NormalizedSha256 -Value (Get-Content -LiteralPath $checksumDownload -Raw) }
            finally { Remove-Item -LiteralPath $checksumDownload -Force -ErrorAction SilentlyContinue }
        }
        if (-not $expectedChecksum) { throw "no valid SHA-256 checksum was supplied for $Url" }
        $binaryDownload = Join-Path $binaryDir ('.binary.download-' + $PID + '-' + [Guid]::NewGuid().ToString('N'))
        try {
            Download-AltairVegaFile -SourceUrl $Url -TargetPath $binaryDownload
            $actualChecksum = (Get-FileHash -LiteralPath $binaryDownload -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expectedChecksum -ne $actualChecksum) { throw "checksum verification failed for $Url" }
            Move-Item -LiteralPath $binaryDownload -Destination $binaryPath -Force
            Set-Content -LiteralPath "$checksumPath.tmp.$PID" -Value $expectedChecksum -NoNewline -Encoding ascii
            Move-Item -LiteralPath "$checksumPath.tmp.$PID" -Destination $checksumPath -Force
        }
        finally { Remove-Item -LiteralPath $binaryDownload -Force -ErrorAction SilentlyContinue }
    }
    Write-AltairVegaWrapper -WrapperPath $wrapperPath -BinaryKey $binaryKey
}
finally { Exit-AltairVegaDownloadLock -Writer $lockWriter -LockPath $lockPath }

if ($CommandArgs.Count -gt 0 -and $CommandArgs[0] -eq '--') { $CommandArgs = if ($CommandArgs.Count -gt 1) { $CommandArgs[1..($CommandArgs.Count - 1)] } else { @() } }
[PSCustomObject]@{ BinRoot = $binRoot; WrapperPath = $wrapperPath; CommandArgs = $CommandArgs }
} @args

if ($null -ne $_AltairVegaLauncherResult) {
    if ($_AltairVegaLauncherResult -isnot [PSCustomObject] -or
        [string]::IsNullOrEmpty($_AltairVegaLauncherResult.BinRoot) -or
        [string]::IsNullOrEmpty($_AltairVegaLauncherResult.WrapperPath)) {
        Remove-Variable _AltairVegaLauncherResult
        throw 'launcher preparation returned an invalid configuration'
    }
    if ($MyInvocation.InvocationName -eq '.') {
        if (($env:PATH -split [Regex]::Escape([System.IO.Path]::PathSeparator)) -notcontains $_AltairVegaLauncherResult.BinRoot) {
            $env:PATH = $_AltairVegaLauncherResult.BinRoot + [System.IO.Path]::PathSeparator + $env:PATH
        }
        Write-Host 'Altair Vega is available as altair-vega for this shell session. Use -Cleanup to remove inactive caches.'
        Remove-Variable _AltairVegaLauncherResult
    } else {
        & $_AltairVegaLauncherResult.WrapperPath @($_AltairVegaLauncherResult.CommandArgs)
        Remove-Variable _AltairVegaLauncherResult
        exit $LASTEXITCODE
    }
} else { Remove-Variable _AltairVegaLauncherResult }
