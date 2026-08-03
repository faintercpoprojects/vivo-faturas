# ============================================================
# Lembrete visual (a cada 15 dias) para rodar a Automacao Vivo Empresas.
# NAO executa a automacao — apenas avisa. Rode manualmente com agendado.cmd
# ou "npm start" na pasta do projeto.
# ============================================================
$titulo   = 'Vivo Faturas — hora de rodar'
$mensagem = "Passaram-se ~15 dias.`n`nRode a automacao de faturas:`n  - abra a pasta do projeto e execute agendado.cmd`n    (ou 'npm start')`n`nEla baixa as faturas pendentes (Movel e Fixo) e envia ao Google Drive."

# 1) Tenta uma notificacao toast nativa do Windows
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $xml.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($xml.CreateTextNode($titulo)) > $null
    $texts.Item(1).AppendChild($xml.CreateTextNode('Rode agendado.cmd (ou npm start) para baixar as faturas pendentes.')) > $null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Vivo Faturas').Show($toast)
} catch {
    # 2) Fallback garantido: caixa de mensagem
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($mensagem, $titulo, 'OK', 'Information') > $null
}
