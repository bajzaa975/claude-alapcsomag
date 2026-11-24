# night-hold.ps1 - started hidden and detached by wsl-bridge.sh launch. Keeps the PC awake, starts the
# night run's launch.sh inside WSL (its output and a final LAUNCH-EXIT=<rc> line go to logs/hold.log),
# then holds ONE wsl.exe client open for the whole run (it blocks on run.flock until the runner is gone,
# which keeps the distro alive) or until UntilEpoch passes. Lid close and update reboots are not prevented.
param(
  [Parameter(Mandatory = $true)][string]$Distro,
  [Parameter(Mandatory = $true)][string]$NightDir,
  [Parameter(Mandatory = $true)][long]$UntilEpoch
)
Add-Type -Namespace Bajzi -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
# Decimal literals: in Windows PowerShell 5.1 a bare 0x8xxxxxxx hex literal is a NEGATIVE Int32 and does not convert to uint.
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 2147483649
[void][Bajzi.Power]::SetThreadExecutionState(2147483649)
try {
  # --exec: no outer shell; the script has no inner double quotes (PowerShell 5.1 would strip them).
  wsl.exe -d $Distro --exec bash -lc 'mkdir -p $1/logs; bash $1/launch.sh >> $1/logs/hold.log 2>&1; echo LAUNCH-EXIT=$? >> $1/logs/hold.log' _ $NightDir | Out-Null
  $left = $UntilEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  # One long-lived client: flock -w returns when the runner released run.flock (exit 0) or after $left seconds.
  if ($left -gt 0) { wsl.exe -d $Distro --exec flock -w $left "$NightDir/run.flock" true | Out-Null }
} finally {
  # ES_CONTINUOUS only: release the keep-awake request
  [void][Bajzi.Power]::SetThreadExecutionState(2147483648)
}
