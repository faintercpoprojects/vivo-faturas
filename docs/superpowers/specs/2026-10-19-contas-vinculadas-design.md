# Contas vinculadas: todas as operadoras + avisos no dashboard

Data: 19/10/2026 · Projeto: `vivo-faturas` (robô no computador do escritório) + `nuvem/` (dashboard em https://contas-cpo.vercel.app)

## 1. Por que

Algumas contas não aparecem no dashboard e ninguém fica sabendo. Hoje o robô busca só **Vivo, Desktop,
AONet e Vero**; quando uma busca falha (login recusado, site mudou) ou uma conta simplesmente não é
encontrada, o erro fica só no log do computador. Exemplo real (19/10): 5 contas de Vivo Fixo vencidas
foram baixadas mas ficaram escondidas por um rótulo de status não reconhecido — ninguém foi avisado.

O financeiro precisa confiar que **o dashboard mostra todas as contas** das operadoras da empresa e, quando
não mostra, **diz qual falta e por quê**.

## 2. Objetivos

1. Contas das seis operadoras no dashboard: **Desktop, Vero, Claro, Vivo, Embratel ("Claro antiga") e AONet**.
2. **Claro e Embratel** entram como as demais: o robô entra no site com **login e senha** e baixa a conta
   (PDF + valor, vencimento, situação). **Cada empresa (CNPJ) tem o seu login** em cada uma.
3. **Lista de contas esperadas ("contratos")**: cada contrato/linha de cada empresa em cada operadora que
   deveria gerar conta todo mês.
4. A cada coleta, **conciliação**: para cada contrato esperado, a conta do mês foi encontrada? Se não, um
   **aviso no dashboard** com o motivo.
5. **Quadro de situação das operadoras**: por operadora × empresa — última busca, se deu certo, erro em
   linguagem simples, contas esperadas × encontradas no mês.
6. **Conta nova** (encontrada, mas fora da lista) → aviso "conta nova encontrada" para alguém confirmar e
   vincular (vira contrato) ou ignorar.

## 3. Fora do escopo

- Pagamento (o sistema é só controle das notas/contas).
- Avisos por e-mail/WhatsApp — **o aviso é no dashboard** (decisão do usuário).
- OCR de PDFs digitalizados.
- Mudar a forma de coleta das quatro operadoras que já funcionam (só passam a **registrar** sucesso/erro).

## 4. Anti-objetivos (seria fracasso mesmo "funcionando")

- **Falhar em silêncio** de novo: toda falha de busca ou conta faltante tem que virar aviso visível.
- **Alarme falso** que ensina a equipe a ignorar avisos: não acusar "conta não encontrada" antes da época
  em que a operadora normalmente emite a conta.
- **Senha fora deste computador**: logins/senhas da Claro/Embratel (e demais) nunca vão para a nuvem, o git
  ou os logs. Ficam só no computador do escritório, digitados pelo próprio usuário.
- **Burlar proteção de site** (captcha, verificação em duas etapas): o robô para e avisa "requer ação manual".
- Aviso duplicado ou que não some depois de resolvido.

## 5. Restrições (como o sistema já é)

- O robô roda **no computador do escritório** (Node + Playwright), dentro do servidor `dashboard/server.js`
  (tarefa do Windows `DashboardVivo`). Coleta diária às 08:00 (`src/agendaDiaria.js`) e sob demanda pelo
  botão "Baixar contas" (pedidos na tabela `comandos` da nuvem).
- Dados locais em SQLite (`.state/contas.db`, tabela `contas`); o agente (`src/nuvem.js`) envia para o
  Postgres da nuvem (Neon) — a nuvem é a fonte do que o **financeiro** edita; o robô é a fonte dos dados do
  **portal**.
- Coletores das outras operadoras em `src/operadoras.js` (`COLETORES`), chamados por `operadoras.js` com
  a lista de CNPJs de `OPERADORAS_CNPJS`. Vivo em `index.js` (todas as empresas da conta MVE).
- Dashboard: telas em `dashboard/public` copiadas para `nuvem/public`; API única em `nuvem/api/index.js`;
  login por usuário; tema escuro e minimalista atual; tudo em português.
- Planos gratuitos (Vercel Hobby, Neon Free). Publicação com `node nuvem/publicar.js`.

## 6. Decidido pelo usuário

- Avisos **no dashboard**.
- Claro e Embratel por **login e senha no site**, baixando a conta como hoje é feito à mão.
- **Logins diferentes por empresa**.
- A proposta de "contratos esperados + conciliação + quadro das operadoras + conta nova" (aprovada).

## 7. Desenho

### 7.1 Contratos (contas esperadas)
- Uma tabela de **contratos**: operadora, CNPJ/empresa, identificador na operadora (linha, nº do contrato
  ou código do cliente — o que a operadora usa para distinguir a conta), apelido opcional (ex.: "Internet
  Herminio Pinto"), ativo/encerrado.
- **Carga inicial automática** a partir do histórico (contas já existentes agrupadas por operadora + CNPJ +
  identificador), para o financeiro só revisar.
- Mantida **pelo dashboard** (tela "Contratos"): editar apelido, desativar contrato encerrado, vincular conta
  nova e **adicionar contrato à mão** (operadora, empresa, identificador) — *decisão do Claude*: sem isso,
  uma conta que o robô nunca encontra nunca seria "esperada" e o aviso nunca dispararia. A nuvem é a dona
  dessa lista; o agente a lê antes de conciliar.
- **Identificador estável por operadora** (*decisão do Claude*, a corrigir antes da conciliação): no Vivo
  Fixo o campo `linha` hoje guarda o nº do boleto (muda todo mês); o identificador do contrato passa a ser o
  **código do cliente** do card (`src/cardsFixo.js`). Na AONet, o texto do card (endereço) recortado vira um
  identificador normalizado. Vivo Móvel (linha), Desktop (contract_id) e Vero (descrição do contrato) já são
  estáveis.

### 7.2 Credenciais por empresa
- Para cada operadora com login (Vero, Claro, Embratel) e cada CNPJ: usuário + senha **só neste computador**.
- O usuário cadastra por um comando local com a senha digitada sem aparecer (no padrão de
  `scripts/usuarios.js`), e pode listar quais (operadora × empresa) têm login cadastrado — nunca as senhas.
- A Vero passa a usar esse mesmo cadastro (hoje é `VERO_USUARIO/VERO_SENHA` único no `.env`), mantendo
  compatibilidade com o `.env` atual.

### 7.3 Coletores Claro e Embratel
- Novos coletores em `src/operadoras.js`, no mesmo formato dos atuais (devolvem contas com valor,
  vencimento, situação, identificador do contrato, PDF baixado). Um login por empresa.
- Se o portal pedir captcha/verificação em duas etapas: não insistir; registrar erro "requer ação manual".
- **Sessão salva** (*decisão do Claude*, como já é feito com a Vivo em `.auth/`): depois de um login manual
  bem-sucedido, a sessão do navegador fica guardada no computador (mesma proteção das senhas), para o robô
  não cair em captcha/código a cada dia. Quando a sessão expirar, aviso "requer ação manual" + comando para
  o usuário fazer o login acompanhado.
- Endereços dos portais e o caminho até a conta: a levantar com o usuário/no próprio site antes de codar
  (mesmo método usado para Desktop/AONet/Vero: navegar, mapear chamadas, implementar).

### 7.4 Registro de cada busca (por operadora × empresa)
- Toda busca (inclusive Vivo, Desktop, AONet, Vero) grava: operadora, empresa, início/fim, deu certo ou não,
  **tipo de erro** e mensagem simples. Tipos mínimos: `login recusado`, `sem login cadastrado`,
  `requer ação manual` (captcha/2FA), `site mudou` (elemento esperado não encontrado), `fora do ar/tempo
  esgotado`, e o informativo `nenhuma conta emitida`.
- Enviado para a nuvem junto com as contas.

### 7.5 Conciliação e avisos
Depois de cada coleta, para o mês corrente (e o anterior, enquanto houver conta em aberto):
- Contrato ativo **sem conta com vencimento no mês** → se já passou da época normal de emissão daquele
  contrato (estimada pelo histórico de vencimentos; sem histórico, um padrão), aviso **"conta não
  encontrada"**; antes disso, só "aguardando emissão" no quadro (sem aviso).
- Busca da operadora × empresa com erro → aviso **"falha na busca"** com o tipo de erro.
- Conta encontrada que não casa com nenhum contrato → aviso **"conta nova"** (vincular / ignorar).
- Avisos **somem sozinhos** quando resolvidos (conta apareceu, busca voltou a funcionar). O usuário pode
  marcar "ignorar este mês" num aviso de conta não encontrada (ex.: contrato sem cobrança naquele mês).

### 7.6 Dashboard
- **Faixa de avisos** no topo do painel: quantidade e lista curta (operadora · empresa · contrato · motivo),
  clicável para o quadro.
- **Quadro "Operadoras"**: linhas operadora × empresa — última busca (data/hora), situação (ok / erro com
  motivo / sem login), contas do mês encontradas × esperadas.
- **Tela "Contratos"**: lista por operadora/empresa; editar apelido; desativar; confirmar conta nova.
- Manter o visual atual (escuro, minimalista, filtros por coluna). Telas novas também na versão local
  (o local redireciona para a nuvem, mas a fonte das telas é `dashboard/public`).

## 8. Fica a critério de quem construir

- Nomes de tabelas/colunas e como espelhar SQLite ↔ Postgres (seguindo o padrão de `src/nuvem.js`).
- Como guardar as credenciais localmente (formato do arquivo, proteção do Windows disponível), desde que
  respeite o anti-objetivo da seção 4.
- Heurística da "época normal de emissão" e o padrão sem histórico.
- Layout exato das telas novas, dentro do estilo atual.
- Ordem de entrega (sugestão: 1) registro de buscas + quadro + avisos de falha nas 4 operadoras atuais;
  2) contratos + conciliação; 3) Claro; 4) Embratel).
- Testes no padrão do projeto (`nuvem/test/teste-nuvem.js`, `scripts/teste-*.js`).
