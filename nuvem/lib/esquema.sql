-- Banco do dashboard na nuvem (Postgres). Criado/atualizado pelo computador
-- do escritório (node scripts/nuvem.js esquema) — pode rodar de novo à vontade.

CREATE TABLE IF NOT EXISTS contas (
  id               SERIAL PRIMARY KEY,
  hash_dedup       TEXT UNIQUE NOT NULL,
  cnpj             TEXT,
  empresa          TEXT,
  produto          TEXT,
  linha            TEXT,
  competencia      TEXT,
  ano              INTEGER,
  mes              INTEGER,
  numero_documento TEXT,
  data_emissao     TEXT,
  data_vencimento  TEXT,
  valor_original   DOUBLE PRECISION,
  status_portal    TEXT,
  linha_digitavel  TEXT,
  pix_code         TEXT,
  origem           TEXT,
  -- campos do FINANCEIRO (a sincronização nunca sobrescreve)
  status_interno   TEXT DEFAULT 'Em aberto',
  valor_pago       DOUBLE PRECISION,
  data_pagamento   TEXT,
  data_baixa       TEXT,
  forma_pagamento  TEXT,
  banco_conta      TEXT,
  comprovante      TEXT,
  observacoes      TEXT,
  alterado_por     TEXT,
  created_at       TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS contas_venc ON contas (data_vencimento);

-- PDFs (fatura/boleto) guardados no próprio banco, servidos só com login.
CREATE TABLE IF NOT EXISTS arquivos (
  conta_hash    TEXT NOT NULL,
  tipo          TEXT NOT NULL,          -- 'fatura' | 'boleto'
  nome          TEXT,
  md5           TEXT NOT NULL,
  conteudo_b64  TEXT NOT NULL,
  atualizado_em TEXT,
  PRIMARY KEY (conta_hash, tipo)
);

-- Contas excluídas no dashboard: a sincronização não as recria.
CREATE TABLE IF NOT EXISTS excluidas (
  hash_dedup TEXT PRIMARY KEY,
  em         TEXT
);

CREATE TABLE IF NOT EXISTS usuarios (
  id                SERIAL PRIMARY KEY,
  usuario           TEXT UNIQUE NOT NULL,
  nome              TEXT NOT NULL,
  senha_hash        TEXT NOT NULL,
  admin             INTEGER NOT NULL DEFAULT 0,
  ativo             INTEGER NOT NULL DEFAULT 1,
  deve_trocar_senha INTEGER NOT NULL DEFAULT 0,
  sessao_versao     INTEGER NOT NULL DEFAULT 1,
  ultimo_login      TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historico (
  id       SERIAL PRIMARY KEY,
  conta_id INTEGER,
  usuario  TEXT,
  acao     TEXT NOT NULL,
  detalhes TEXT,
  em       TEXT NOT NULL
);

-- Tentativas de login erradas (bloqueio por IP; a nuvem não guarda memória entre chamadas).
CREATE TABLE IF NOT EXISTS tentativas (
  ip  TEXT PRIMARY KEY,
  n   INTEGER NOT NULL,
  ate BIGINT NOT NULL
);

-- Pedidos do botão "Baixar contas"/"Atualizar status": o computador executa.
CREATE TABLE IF NOT EXISTS comandos (
  id          SERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL,            -- 'completo' | 'status'
  pedido_por  TEXT,
  criado_em   TEXT NOT NULL,
  iniciado_em TEXT,
  fim_em      TEXT,
  codigo      INTEGER
);

-- Sinal de vida do computador do escritório.
CREATE TABLE IF NOT EXISTS agente (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  ultimo_ping        TEXT,
  ultima_sincronia   TEXT,
  ultima_coleta_fim  TEXT,
  ultima_coleta_ok   INTEGER
);

-- "Esqueci minha senha": e-mail do usuário e links de redefinição.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email TEXT;

-- Guarda só o HASH do link (quem lê o banco não consegue usar o link).
CREATE TABLE IF NOT EXISTS redefinicoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  expira     BIGINT NOT NULL,
  usado      INTEGER NOT NULL DEFAULT 0,
  criado_em  TEXT NOT NULL,
  ip         TEXT
);
