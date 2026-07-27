# Automação Vivo Empresas (MVE) — Faturas e Boletos

Automação em **Node.js + Playwright** que acessa o portal **Vivo Empresas / Meu Vivo Empresas**
(`https://mve.vivo.com.br`), percorre todos os CNPJs da conta, baixa **fatura** (Conta detalhada e
nota fiscal) e **boleto** de cada conta em **Vivo Móvel** e **Vivo Fixo**, extrai o conteúdo do PDF,
opcionalmente envia para uma **IA** que devolve um JSON estruturado, sobe tudo para o **Google Drive**
e mantém uma cópia local organizada.

> Projeto construído por engenharia reversa do portal real (SPA em Web Components / Shadow DOM).
> Validado de ponta a ponta: login, troca de empresa, download de fatura+boleto, organização em
> pastas, análise e upload ao Drive.

---

## Índice

- [Como o portal funciona](#como-o-portal-funciona)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Configuração (.env)](#configuração-env)
- [Google Drive](#google-drive)
- [Execução](#execução)
- [Estrutura de saída](#estrutura-de-saída)
- [Arquitetura](#arquitetura)
- [Diagnóstico e ajuste de seletores](#diagnóstico-e-ajuste-de-seletores)
- [Logs e relatórios](#logs-e-relatórios)
- [Solução de problemas](#solução-de-problemas)
- [Segurança](#segurança)
- [Limitações conhecidas](#limitações-conhecidas)

---

## Como o portal funciona

O MVE é uma SPA construída **inteiramente com Web Components e Shadow DOM aberto**. O texto dos
botões fica em shadow aninhado (sem `aria-label` na maioria dos casos), então os locators padrão do
Playwright não os encontram de forma confiável — a automação interage percorrendo os shadow roots
via `page.evaluate` (ver [`src/shadow.js`](src/shadow.js)).

Fluxo real mapeado e implementado:

1. **Login** em duas etapas: CPF → **Continuar** → senha → **Entrar**. O envio de cada etapa é feito
   com **Enter** (mais confiável que clicar o botão em Web Component). A etapa da senha ocorre em
   `auth.vivo.com.br`. Após o login, o modal de e-mail de recuperação é dispensado com **"Agora não"**.
2. **Seleção de empresa**: clicar no nome da empresa no cabeçalho (`.customer-name`) abre um painel
   (`#customer-select-slider`) com a lista de CNPJs (`li.list-item-wrapper`). "Ver mais"
   (`#see-more-button`) carrega todos. Clicar no CNPJ troca a empresa ativa.
3. **Faturas**: a página `/sec/invoices` é escopada pela empresa ativa. Cada **conta** (linha) com
   fatura emitida exibe um botão **"Baixar fatura"** que abre um menu com:
   - **Conta detalhada e nota fiscal (.pdf)** → a fatura
   - **Boleto (.pdf)** → o boleto (quando existir)
   - Conta eletrônica (.zip) → ignorado
4. **Sem botão "Baixar fatura" = fatura ainda não emitida** → a empresa é pulada (sem erro).
5. O **nome sugerido** do arquivo baixado (ex.: `072026-0443307515-vivomovel-fatura.pdf`) já traz
   **competência** (`07/2026`), **linha** (`0443307515`) e **produto** (`vivomovel`/`vivofixo`),
   usados para organizar as pastas e classificar o documento — sem depender de heurística de posição.

---

## Requisitos

- **Node.js 18.17+** (testado em Node 24)
- Acesso ao portal com **CPF e senha**
- (Opcional) Chave de API da **Anthropic** ou **OpenAI** para o JSON enriquecido
- Credenciais **OAuth2** do Google (a API do Drive **não** aceita e-mail/senha)

## Instalação

```bash
npm install
```

O `postinstall` baixa o Chromium do Playwright. Depois:

```bash
cp .env.example .env
```

---

## Configuração (.env)

| Variável | Descrição |
|---|---|
| `VIVO_URL` | URL de login (pode conter `?logout=true` para forçar sessão nova) |
| `VIVO_USER` / `VIVO_PASS` | **CPF** e senha do portal |
| `CNPJ_IGNORAR` | CNPJs a pular (ex.: `40.810.757/0001-65`) |
| `CNPJ_SOMENTE` | Se preenchido, processa **apenas** estes CNPJs |
| `HEADLESS` | `false` recomendado na 1ª vez (MFA/captcha exigem você presente) |
| `REUSE_SESSION` | Reaproveita a sessão salva em `.auth/state.json` |
| `IA_ENABLED` | `false` = extração local grátis (regex); `true` = usa a IA |
| `IA_PROVIDER` | `anthropic` ou `openai` (+ a respectiva `*_API_KEY`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | OAuth2 do Drive |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | ID da pasta raiz no Drive |
| `LIMPAR_APOS_UPLOAD` | `false` mantém os arquivos locais em `downloads/` além do Drive |

Com `IA_ENABLED=false` os campos `cnpj/empresa/tipo/competência/vencimento/valor/linha` saem
corretos por regex; apenas `resumo` e `observações` ficam vazios (esses exigem a IA).

---

## Google Drive

A API do Drive exige **OAuth2** (não aceita e-mail/senha). Passo a passo:

1. No [Google Cloud Console](https://console.cloud.google.com/): ative a **Google Drive API** e crie
   uma credencial **OAuth (App para computador)**.
2. Se o app estiver em modo de teste, adicione seu e-mail em **Usuários de teste**.
3. Preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env` e rode:

   ```bash
   npm run google:token
   ```

   Isso abre a tela de consentimento, captura o código automaticamente e grava o
   `GOOGLE_REFRESH_TOKEN` no `.env`.
4. Copie o ID da pasta raiz da URL do Drive para `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

Verificar a árvore criada no Drive: `node scripts/verificar-drive.js`.

---

## Execução

```bash
npm start                          # todos os CNPJs de CNPJ_SOMENTE (ou todos, se vazio)
node index.js --cnpj 40524182000114   # apenas um CNPJ
node index.js --no-upload --no-ia     # só baixa localmente (teste)
node index.js --inspecionar           # dump do painel autenticado (diagnóstico)
npm run login                         # apenas autentica e salva a sessão (headed)
```

**Primeira execução:** rode `npm run login` (headed) para concluir qualquer desafio (MFA/captcha)
e gravar a sessão. As execuções seguintes a reutilizam e podem rodar headless/agendadas.

Códigos de saída: `0` sucesso · `1` concluiu com erros registrados · `2` falha fatal.

---

## Estrutura de saída

**Local** (`downloads/`) e **Google Drive** seguem a mesma ordem — **Ano / Mês**:

```
downloads/
  40.524.182-0001-14/
    2026/
      06/  Fatura-Movel-0440767611.pdf  +  .json
      07/  Fatura-Movel-0443307515.pdf  +  .json
           Boleto-Movel-0443307515.pdf  +  .json

Google Drive: <pasta raiz>/
  UNICPO LTDA/
    40.524.182-0001-14/
      2026/
        06 - Junho/   Fatura-Movel-0440767611.pdf ...
        07 - Julho/   Fatura + Boleto ...
```

**JSON gerado** (ao lado de cada PDF):

```json
{
  "cnpj": "40.524.182/0001-14",
  "empresa": "UNICPO LTDA",
  "tipo": "Movel",
  "competencia": "07/2026",
  "vencimento": "25/07/2026",
  "valor": "159.96",
  "linha": "0443307515",
  "observacoes": "...",
  "resumo": "...",
  "_meta": { "documento": "Fatura", "fonte": "ia|regex", "provider": "...", "analisadoEm": "..." }
}
```

O bloco `_meta` é rastreabilidade; os nove campos do esquema estão sempre presentes. O CNPJ e a
razão social vêm do **contexto** (empresa que estamos processando), não do texto do PDF — assim
códigos de barras e o CNPJ da Telefônica não confundem a extração.

---

## Arquitetura

```
src/
  config.js          .env + flags de CLI, validação que falha cedo
  logger.js          Winston (rotação diária, mascaramento de segredos)
  utils.js           retry c/ backoff, esperas inteligentes, CNPJ, manifest, progress bar
  shadow.js          interação com Web Components / Shadow DOM (clicar, contar, listar)
  login.js           navegador, sessão persistente, login 2 etapas, "Agora não", MFA
  selecionarCNPJ.js  enumerar/filtrar/trocar empresa (slider #customer-select-slider)
  baixarFaturas.js   /sec/invoices: contas, download fatura+boleto, captura, metadados do nome
  analisarPDF.js     pdf-parse + IA (Anthropic/OpenAI) + fallback regex; desliga IA se sem saldo
  uploadDrive.js     OAuth2, árvore Empresa/CNPJ/Ano/Mês, dedup por MD5
  diagnostico.js     dump do DOM (shadow-piercing) para --inspecionar
scripts/
  gerar-token-google.js   obtém o GOOGLE_REFRESH_TOKEN (OAuth2 loopback)
  verificar-drive.js      imprime a árvore de pastas do Drive
index.js               orquestração, estatísticas, tratamento de erros
```

**Não repetir trabalho:** `.state/manifest.json` registra cada documento concluído. **Deduplicação
no Drive** é garantida por comparação de **MD5** (arquivo idêntico não é reenviado).

---

## Diagnóstico e ajuste de seletores

O portal muda com frequência. Todos os pontos frágeis estão centralizados em
[`src/shadow.js`](src/shadow.js) (padrões de texto/classe) e [`src/selectors.js`](src/selectors.js)
(login). Se algo quebrar, rode o modo de diagnóstico:

```bash
node index.js --inspecionar
```

Ele faz login e salva `logs/inspecao-dashboard.json` com todos os elementos interativos (atravessando
shadow DOM), facilitando localizar o novo seletor.

---

## Logs e relatórios

```
logs/
  vivo-AAAA-MM-DD.log        # tudo (JSON estruturado, rotação 30 dias)
  vivo-erros-AAAA-MM-DD.log  # apenas erros (90 dias)
  relatorio-<timestamp>.json # resumo consolidado por execução
  screenshots/               # captura de tela por falha
```

O console mostra uma barra de progresso e, ao final, o resumo (contratos, faturas, boletos, uploads,
erros e tempo total).

---

## Solução de problemas

| Sintoma | Causa provável | Ação |
|---|---|---|
| `campo de senha` não encontrado | etapa 2 do login não carregou | rode headed; a automação já reenvia |
| desafio de segurança (MFA) em headless | portal pediu verificação | `npm run login` uma vez |
| `Nenhum CNPJ encontrado no slider` | seletor do slider mudou | ajuste `src/shadow.js` via `--inspecionar` |
| empresa X "nenhuma fatura emitida" | fatura ainda não emitida | comportamento esperado (pula) |
| `Your credit balance is too low` | conta de IA sem saldo | a automação desliga a IA e segue por regex |
| `Drive API has not been used` | API não ativada no projeto | ative a Google Drive API no Cloud Console |

---

## Segurança

- `.env`, `.auth/`, `credentials/`, `downloads/`, `logs/` e `.state/` estão no `.gitignore` — **não**
  são versionados. Nunca commite o `.env`.
- Segredos (senha, chaves, refresh token) são **mascarados** nos logs automaticamente.
- Use repositório **privado**.

---

## Limitações conhecidas

- Baixa a **fatura mais recente** de cada conta (a que o portal exibe). Histórico completo
  ("Outras faturas") não é percorrido ainda.
- **Boletos** costumam ser PDFs digitalizados (sem camada de texto) — o JSON sai com os metadados,
  mas sem extração textual (seria necessário OCR).
- MFA a cada novo login exige um `npm run login` periódico quando a sessão salva expirar.
- Execução sequencial (1 empresa por vez) — o MVE limita sessões simultâneas por usuário.
