# ============================================================
# Instala o Dashboard como tarefa do Windows que sobe AO LIGAR O PC,
# mesmo sem ninguem logado, e reinicia sozinho se cair.
#
# Como usar (uma vez so):
#   1. Clique com o botao direito em "instalar-servidor.ps1" >
#      "Executar com o PowerShell" -- ou, num PowerShell ABERTO COMO
#      ADMINISTRADOR:  powershell -ExecutionPolicy Bypass -File instalar-servidor.ps1
#   2. Na janela do Windows, digite a SENHA da sua conta do Windows
#      (a senha mesmo, nao o PIN). Ela fica guardada pelo proprio Windows
#      na tarefa; nao e gravada em nenhum arquivo.
#
# Para remover:  powershell -ExecutionPolicy Bypass -File instalar-servidor.ps1 -Remover
# ============================================================
param([switch]$Remover)

$ErrorActionPreference = 'Stop'
$Nome  = 'DashboardVivo'
$Pasta = Split-Path -Parent $MyInvocation.MyCommand.Path

# Precisa de administrador para tarefa "sem login".
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Abrindo como administrador...' -ForegroundColor Yellow
  $args2 = "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  if ($Remover) { $args2 += ' -Remover' }
  Start-Process powershell -Verb RunAs -ArgumentList $args2
  exit
}

if ($Remover) {
  Stop-ScheduledTask -TaskName $Nome -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Nome -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa '$Nome' removida. O dashboard nao sobe mais sozinho." -ForegroundColor Green
  Read-Host 'Enter para fechar'
  exit
}

$usuario = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "Instalando '$Nome' para o usuario $usuario" -ForegroundColor Cyan
$cred = Get-Credential -UserName $usuario -Message 'Senha da sua conta do Windows (para o dashboard rodar mesmo sem login)'
if (-not $cred) { Write-Host 'Cancelado.'; Read-Host 'Enter para fechar'; exit }

$acao = New-ScheduledTaskAction -Execute "$env:ComSpec" -Argument "/c `"$Pasta\servidor.cmd`"" -WorkingDirectory $Pasta
$gatilho = New-ScheduledTaskTrigger -AtStartup
$gatilho.Delay = 'PT1M'   # espera 1 min apos ligar (rede pronta)
$config = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask -TaskName $Nome -Action $acao -Trigger $gatilho -Settings $config `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited `
    -Description 'Dashboard Contas a Pagar (Vivo, Desktop, AONet, Vero) em http://localhost:4599' -Force | Out-Null
} catch {
  Write-Host "Nao foi possivel criar a tarefa: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Confira se a senha esta correta (senha da conta, nao o PIN).' -ForegroundColor Red
  Read-Host 'Enter para fechar'; exit 1
}

# Fecha um dashboard que esteja aberto manualmente (mesma porta) e sobe pela tarefa.
$pid4599 = (Get-NetTCPConnection -LocalPort 4599 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid4599) { Stop-Process -Id $pid4599 -Force -ErrorAction SilentlyContinue; Start-Sleep 2 }
Start-ScheduledTask -TaskName $Nome
Start-Sleep 6

$ok = $false
try { $ok = (Invoke-WebRequest -UseBasicParsing http://localhost:4599/api/run/status -TimeoutSec 10).StatusCode -eq 200 } catch {}
if ($ok) {
  Write-Host "`nPronto! O dashboard esta no ar e vai subir sozinho sempre que o PC ligar." -ForegroundColor Green
  Write-Host '  local:   http://localhost:4599'
  $ips = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
  foreach ($ip in $ips) { Write-Host "  na rede: http://$($ip.IPAddress):4599" }
} else {
  Write-Host "`nA tarefa foi criada, mas o dashboard ainda nao respondeu. Veja logs\servidor.log." -ForegroundColor Yellow
}
Read-Host "`nEnter para fechar"
