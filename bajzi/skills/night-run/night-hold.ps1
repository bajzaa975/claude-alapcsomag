# night-hold.ps1 - started hidden and detached by wsl-bridge.sh launch. Keeps the PC awake, starts the
# night run's launch.sh inside WSL, then holds a wsl.exe client open (keeps the distro alive) until the
# runner is gone (run.flock free) or UntilEpoch passes. Lid close and update reboots are not prevented.
param(
  [Parameter(Mandatory = $true)][string]$Distro,
  [Parameter(Mandatory = $true)][string]$NightDir,
  [Parameter(Mandatory = $true)][long]$UntilEpoch
)
Add-Type -Namespace Bajzi -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[void][Bajzi.Power]::SetThreadExecutionState(0x80000001)
try {
  # --exec: no outer shell; the script has no inner double quotes (PowerShell 5.1 would strip them).
  wsl.exe -d $Distro --exec bash -c 'mkdir -p $1/logs; bash $1/launch.sh >> $1/logs/hold.log 2>&1' _ $NightDir | Out-Null
  while ($true) {
    Start-Sleep -Seconds 60
    wsl.exe -d $Distro --exec flock -n "$NightDir/run.flock" true | Out-Null
    if ($LASTEXITCODE -eq 0) { break }   # lock free = the runner is gone
    if ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() -ge $UntilEpoch) { break }
  }
} finally {
  # ES_CONTINUOUS only: release the keep-awake request
  [void][Bajzi.Power]::SetThreadExecutionState(0x80000000)
}
