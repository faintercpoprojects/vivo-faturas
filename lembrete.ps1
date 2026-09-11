# ============================================================
# Lembrete visual (a cada 15 dias) para rodar a Automacao Vivo Empresas.
# NAO executa a automacao — apenas avisa. Rode manualmente com agendado.cmd
# ou "npm start" na pasta do projeto.
# ============================================================
$titulo   = 'Vivo Faturas - hora de rodar'
$mensagem = "Passaram-se ~15 dias.`n`nRode a automacao de faturas:`n  - abra a pasta do projeto e execute agendado.cmd`n    (ou 'npm start')`n`nEla baixa as faturas PENDENTES (Movel e Fixo) e envia ao Google Drive."

# 1) Notificacao toast nativa (melhor esforco — pode nao aparecer sem AppID)
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($xml.CreateTextNode($titulo)) > $null
    $texts.Item(1).AppendChild($xml.CreateTextNode('Rode agendado.cmd (ou npm start) para baixar as faturas pendentes.')) > $null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.Explorer').Show($toast)
} catch { }

# 2) Alerta GARANTIDO: caixa de mensagem sempre-no-topo (aparece na tela).
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }
    [void]$owner.Show()
    [System.Windows.Forms.MessageBox]::Show($owner, $mensagem, $titulo,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    $owner.Close()
} catch {
    # 3) Ultimo recurso: msg.exe (Windows Pro)
    try { & msg.exe * $mensagem } catch { }
}
