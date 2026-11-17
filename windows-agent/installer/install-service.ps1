<#
.SYNOPSIS
    Installs the AI Bridge two-process Windows architecture:
    - Process A: ai_bridge_service.exe (Session 0 Windows Service)
    - Process B: ai_bridge_desktop.exe (interactive session via HKLM Run + scheduled task)

.PARAMETER ControlUrl
    Control plane base URL (https://...).

.PARAMETER DeviceToken
    Device enrollment token from the dashboard.

.PARAMETER BuildDir
    Directory containing Release binaries (default: ..\build\Release).

.PARAMETER ServiceName
    Windows service name (default: AIBridgeAgent).

.PARAMETER SkipBuild
    Do not invoke CMake when binaries are missing.
#>
param(
    [string]$ControlUrl = "http://127.0.0.1:8000",
    [string]$DeviceToken = "",
    [string]$BuildDir = "$PSScriptRoot\..\build\Release",
    [string]$ServiceName = "AIBridgeAgent",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ServiceExe = Join-Path $BuildDir "ai_bridge_service.exe"
$DesktopExe = Join-Path $BuildDir "ai_bridge_desktop.exe"
$InstallRoot = Join-Path $env:ProgramFiles "AI Bridge\WindowsAgent"
$PipeSecretPath = Join-Path $env:ProgramData "ai-bridge\native-pipe.secret"
$ConfigPath = Join-Path $env:ProgramData "ai-bridge\native-agent.json"

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "install-service.ps1 must run elevated (Run as administrator)."
    }
}

function Ensure-Binaries {
    if ((Test-Path $ServiceExe) -and (Test-Path $DesktopExe)) { return }
    if ($SkipBuild) {
        throw "Native binaries missing under $BuildDir and -SkipBuild was set."
    }
    Write-Host "[AI Bridge] Building native C++ Windows Agent via CMake..."
    cmake -S "$PSScriptRoot\.." -B "$PSScriptRoot\..\build"
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }
    cmake --build "$PSScriptRoot\..\build" --config Release
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }
    if (-not (Test-Path $ServiceExe) -or -not (Test-Path $DesktopExe)) {
        throw "Build finished but binaries were not found in $BuildDir"
    }
}

$DpapiMagic = "aib-dpapi-v1:"

function Protect-SecretDPAPI {
    <#
    .SYNOPSIS
        DPAPI-seals a secret with .NET ProtectedData (LocalMachine scope) and
        returns it in the same "aib-dpapi-v1:<base64>" wire format used by
        agents/windows/app_runtime.py seal_token() / the C++ DpapiSecretStore.
        LocalMachine scope is required (not CurrentUser): the sealed value
        must be readable by BOTH the service (SYSTEM) and the desktop agent
        (interactive user), which are different accounts. That scope protects
        the secret if the file is copied off this machine, NOT against other
        local users — the SYSTEM+Admins-only file ACL is the local boundary.
        FAILS LOUDLY on any DPAPI error: never falls back to plaintext.
        NOTE (F08-08 follow-up, out of scope for this installer-only change):
        the C++ service/desktop readers currently read device_token /
        pipe_secret as plaintext JSON and never call
        DpapiSecretStore::UnprotectSecret — they must strip the prefix,
        base64-decode, and UnprotectSecret() before use, or the sealed
        values will be treated as the secret. The Python agent
        (agent_main.py) already unseals this prefix via unseal_token().
    #>
    param([Parameter(Mandatory = $true)][string]$Plaintext)
    try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Plaintext)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
    } catch {
        throw "DPAPI sealing failed; refusing to write a plaintext secret: $_"
    }
    if (-not $protected -or $protected.Length -eq 0) {
        throw "DPAPI Protect returned no data; refusing to write a plaintext secret."
    }
    $sealed = "$DpapiMagic$([Convert]::ToBase64String($protected))"
    # Round-trip check before anything is written to disk.
    $roundTrip = [Text.Encoding]::UTF8.GetString(
        [Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($sealed.Substring($DpapiMagic.Length)),
            $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))
    if ($roundTrip -cne $Plaintext) { throw "DPAPI round-trip verification failed; refusing to write the sealed secret." }
    return $sealed
}

function New-PipeSecret {
    $dir = Split-Path $PipeSecretPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # F08-08: the pipe secret file holds the DPAPI-SEALED value only — no
    # plaintext secret on disk. Readers must UnprotectSecret() it first.
    $sealed = Protect-SecretDPAPI ([Convert]::ToBase64String($bytes))
    Set-Content -Path $PipeSecretPath -Value $sealed -Encoding ASCII
    $acl = Get-Acl -LiteralPath $PipeSecretPath
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
    $system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
    $admins = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, "FullControl", $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, "FullControl", $allow)))
    Set-Acl -LiteralPath $PipeSecretPath -AclObject $acl
    return $sealed
}

Assert-Admin
if (-not $DeviceToken) {
    throw "DeviceToken is required. Enroll a device in the dashboard first."
}

Ensure-Binaries
Write-Host "[AI Bridge] Native binaries verified:"
Write-Host "  - Service (Session 0): $ServiceExe"
Write-Host "  - Desktop Agent (Interactive Session): $DesktopExe"

if (-not (Test-Path $InstallRoot)) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
}
Copy-Item -Force $ServiceExe (Join-Path $InstallRoot "ai_bridge_service.exe")
Copy-Item -Force $DesktopExe (Join-Path $InstallRoot "ai_bridge_desktop.exe")
$InstalledService = Join-Path $InstallRoot "ai_bridge_service.exe"
$InstalledDesktop = Join-Path $InstallRoot "ai_bridge_desktop.exe"

$pipeSecret = New-PipeSecret
# F08-08: the config holds DPAPI-SEALED secrets only (aib-dpapi-v1: prefix).
# No plaintext device token or pipe secret is written anywhere by this
# installer. Readers must unseal before use (see Protect-SecretDPAPI note).
$sealedDeviceToken = Protect-SecretDPAPI $DeviceToken
$config = @{
    control_url   = $ControlUrl.TrimEnd("/")
    device_token  = $sealedDeviceToken
    pipe_name     = "\\.\pipe\AIBridgeDesktopPipe"
    pipe_secret   = $pipeSecret
    desktop_exe   = $InstalledDesktop
    installed_at  = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4
$configDir = Split-Path $ConfigPath -Parent
if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
Set-Content -Path $ConfigPath -Value $config -Encoding UTF8
# 0600-equivalent ACL: SYSTEM + installing Administrators only. The previous
# Read grant to the installing user is removed. KNOWN CAVEAT: the desktop
# agent scheduled task runs as a standard user (Users / Limited) and reads
# this config via --config, so it can no longer read it unless it runs
# elevated or the service hands it the secrets (e.g. over the authenticated
# pipe, F08-02). Reconcile before deploying to non-admin desktops; do NOT
# silently re-add a broad Read grant as the fix.
$cfgAcl = Get-Acl -LiteralPath $ConfigPath
$cfgAcl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($cfgAcl.Access)) { [void]$cfgAcl.RemoveAccessRule($rule) }
$allowRule = [System.Security.AccessControl.AccessControlType]::Allow
$sysSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$admSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
$cfgAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sysSid, "FullControl", $allowRule)))
$cfgAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admSid, "FullControl", $allowRule)))
Set-Acl -LiteralPath $ConfigPath -AclObject $cfgAcl

# Stop / remove existing service if present
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

$binPath = "`"$InstalledService`" --config `"$ConfigPath`""
sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= "AI Bridge Windows Agent" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc create failed ($LASTEXITCODE)" }
sc.exe description $ServiceName "AI Bridge Session-0 control plane agent (heartbeat + desktop supervision)." | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

# Interactive desktop agent: start at user logon (cannot run desktop capture as SYSTEM).
$runKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
$desktopArgs = "--config `"$ConfigPath`""
Set-ItemProperty -Path $runKey -Name "AIBridgeDesktopAgent" -Value "`"$InstalledDesktop`" $desktopArgs" -Type String

$taskName = "AI Bridge Desktop Agent"
$action = New-ScheduledTaskAction -Execute $InstalledDesktop -Argument $desktopArgs
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -GroupId "Users" -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Start-Service -Name $ServiceName
Write-Host "[OK] Service '$ServiceName' installed and started." -ForegroundColor Green
Write-Host "[OK] Desktop agent registered at logon (HKLM Run + scheduled task '$taskName')." -ForegroundColor Green
Write-Host "[OK] Config: $ConfigPath" -ForegroundColor Green
Write-Host "Desktop capture still requires an interactive logged-in session." -ForegroundColor DarkGray
