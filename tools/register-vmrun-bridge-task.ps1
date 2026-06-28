param(
    [string]$TaskName = "VMware Workstation MCP vmrun bridge",
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$NodePath = "node",
    [string]$VmrunPath = "C:\Program Files (x86)\VMware\VMware Workstation\vmrun.exe",
    [string]$HostAddress = "127.0.0.1",
    [int]$Port = 57931,
    [string]$Token = ""
)

$bridgePath = Join-Path $RepoPath "src\vmrun-bridge.js"
if (!(Test-Path $bridgePath)) {
    throw "Bridge script not found: $bridgePath"
}

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege

$wrapper = Join-Path $RepoPath "tools\start-vmrun-bridge-task.ps1"
@"
`$env:VMRUN_PATH = "$VmrunPath"
`$env:VMRUN_BRIDGE_HOST = "$HostAddress"
`$env:VMRUN_BRIDGE_PORT = "$Port"
`$env:VMRUN_BRIDGE_TOKEN = "$Token"
& "$NodePath" "$bridgePath"
"@ | Set-Content -Path $wrapper -Encoding UTF8

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`"" `
    -WorkingDirectory $RepoPath

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Output "Registered scheduled task: $TaskName"
Write-Output "Bridge URL: http://$HostAddress`:$Port/"
if ($Token) {
    Write-Output "Set VMRUN_BRIDGE_TOKEN in the MCP server environment to the same token."
}
