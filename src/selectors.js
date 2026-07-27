'use strict';

/**
 * ---------------------------------------------------------------------------
 * SELETORES DO PORTAL VIVO EMPRESAS (MVE)
 * ---------------------------------------------------------------------------
 * O MVE e uma SPA cujo markup muda com frequencia e nao expoe data-testid
 * publicamente. Por isso cada alvo aqui e uma LISTA DE CANDIDATOS, tentada em
 * ordem por `primeiroVisivel()` / `exigirVisivel()`:
 *
 *   1. atributos estaveis (id, name, data-*, aria-*)
 *   2. roles + texto acessivel (resistentes a mudanca de CSS)
 *   3. heuristicas por texto visivel
 *
 * Nenhum seletor depende de coordenadas, indices de DOM ou classes geradas.
 *
 * >>> AJUSTE AQUI depois do primeiro run: rode `npm run login` (headed),
 *     inspecione o elemento e adicione o seletor real no INICIO da lista.
 *     Nenhum outro arquivo precisa ser tocado.
 */

const LOGIN = {
  // Frame de login (algumas rotas do MVE embutem o IdP em iframe)
  frames: ['iframe[src*="login"]', 'iframe[src*="auth"]', 'iframe[id*="login"]'],

  usuario: [
    // MVE atual: login por CPF em web component (shadow DOM aberto, atravessado
    // automaticamente pelo Playwright). Estes sao os seletores reais da etapa 1.
    'input#text-field',
    'input[name="text-field"]',
    '#login-input input',
    'input-field-with-custom-formatter-wc input',
    // Fallbacks para outros layouts/versoes do portal
    'input#username',
    'input[name="username"]',
    'input[name="user"]',
    'input[name="login"]',
    'input[name="email"]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[placeholder*="usu" i]',
    'input[placeholder*="CPF" i]',
  ],

  senha: [
    // Etapa 2 (auth.vivo.com.br): campo real
    'input#password',
    'input[type="password"]',
    'input[name="password"]',
    'input[placeholder*="Senha" i]',
    'input[name="senha"]',
    'input[autocomplete="current-password"]',
  ],

  // Fluxo em duas etapas: CPF -> "Continuar" -> senha.
  // O texto visivel fica em shadow aninhado; o aria-label e o alvo confiavel.
  continuar: [
    'button[aria-label*="Continuar" i]',
    'button-primary-wc button',
    'button:has-text("Continuar")',
    'button:has-text("Avançar")',
    'button:has-text("Próximo")',
  ],

  entrar: [
    'button[aria-label*="Entrar" i]',
    'button[type="submit"]',
    'button:has-text("Entrar")',
    'button:has-text("Acessar")',
    'button-primary-wc button',
    'input[type="submit"]',
    '[role="button"]:has-text("Entrar")',
  ],

  // Modal pos-login pedindo e-mail de recuperacao: dispensar com "Agora nao".
  // Botoes sao web components -> mirar aria-label (texto fica em shadow aninhado).
  pularRecuperacao: [
    'button[aria-label*="Agora não" i]',
    'button[aria-label*="Agora nao" i]',
    'button-secondary-wc[aria-label*="Agora" i] button',
    '[aria-label*="Agora não" i]',
    'button[aria-label*="Pular" i]',
    'button[aria-label*="Mais tarde" i]',
    'button[aria-label*="Cadastrar depois" i]',
    'button[aria-label*="Não, obrigado" i]',
    'button[aria-label*="Nao, obrigado" i]',
    // Fallbacks por texto (layouts sem web component)
    'button:has-text("Agora não")',
    'button:has-text("Agora nao")',
    'a:has-text("Agora não")',
    'button:has-text("Pular")',
  ],

  // Presenca de qualquer um destes = sessao autenticada
  autenticado: [
    'a[href*="logout" i]',
    'button:has-text("Sair")',
    '[data-testid*="header-user"]',
    '[class*="avatar" i]',
    'nav:has-text("Faturas")',
    ':text("Minha Vivo Empresas")',
    ':text("Meus contratos")',
  ],

  erro: [
    '[role="alert"]',
    '.error-message',
    '[class*="error" i]:visible',
    ':text("Usuário ou senha")',
    ':text("credenciais inválidas")',
  ],

  // MFA / captcha: se aparecer, a automacao pausa e pede intervencao humana
  desafio: [
    ':text("código de verificação")',
    ':text("token")',
    'iframe[src*="recaptcha"]',
    'iframe[title*="captcha" i]',
    '[data-testid="mfa"]',
  ],
};

const CONTRATOS = {
  // Botao que abre o seletor de contrato/CNPJ (normalmente no header)
  abrirSeletor: [
    '[data-testid*="contract-selector"]',
    '[data-testid*="seletor"]',
    'button[aria-label*="contrato" i]',
    'button:has-text("Trocar contrato")',
    'button:has-text("Selecionar contrato")',
    'button:has-text("Alterar contrato")',
    'button:has-text("Meus contratos")',
    'button:has-text("CNPJ")',
    'header button:has-text("/")',
    '[class*="contract" i] button',
  ],

  // Container da lista aberta
  lista: [
    '[role="listbox"]',
    '[role="dialog"] ul',
    '[data-testid*="contract-list"]',
    '[class*="contract-list" i]',
    '[class*="dropdown" i][class*="open" i]',
    '[role="dialog"]',
  ],

  // Cada item da lista (deve conter o CNPJ em algum lugar do texto)
  item: [
    '[role="option"]',
    '[data-testid*="contract-item"]',
    'li[class*="contract" i]',
    '[role="dialog"] li',
    '[role="listbox"] li',
    '[class*="contract" i] [role="button"]',
  ],

  // Campo de busca dentro do seletor (quando ha muitos CNPJs)
  busca: [
    'input[placeholder*="Buscar" i]',
    'input[placeholder*="Pesquis" i]',
    'input[placeholder*="CNPJ" i]',
    '[role="dialog"] input[type="search"]',
    '[role="dialog"] input[type="text"]',
  ],

  // Botao de confirmacao apos escolher o item
  confirmar: [
    'button:has-text("Confirmar")',
    'button:has-text("Selecionar")',
    'button:has-text("Acessar")',
    'button:has-text("Continuar")',
  ],

  // Onde o CNPJ ativo aparece depois de selecionado
  cnpjAtivo: [
    '[data-testid*="current-contract"]',
    'header [class*="cnpj" i]',
    'header [class*="contract" i]',
    'header',
  ],

  // Paginacao interna do seletor
  carregarMais: [
    'button:has-text("Carregar mais")',
    'button:has-text("Ver mais")',
    'button:has-text("Mostrar mais")',
  ],
};

const NAVEGACAO = {
  faturas: [
    'a[href*="fatura" i]',
    'nav a:has-text("Faturas")',
    'a:has-text("Faturas")',
    'button:has-text("Faturas")',
    ':text("Minhas faturas")',
    'a[href*="billing" i]',
  ],

  // Abas / cards de produto
  movel: [
    '[data-testid*="movel" i]',
    'button:has-text("Vivo Móvel")',
    'a:has-text("Vivo Móvel")',
    '[role="tab"]:has-text("Móvel")',
    'button:has-text("Móvel")',
    'a:has-text("Móvel")',
    ':text("Vivo Movel")',
  ],

  fixo: [
    '[data-testid*="fixo" i]',
    'button:has-text("Vivo Fixo")',
    'a:has-text("Vivo Fixo")',
    '[role="tab"]:has-text("Fixo")',
    'button:has-text("Fixo")',
    'a:has-text("Fixo")',
    ':text("Vivo Fixo")',
  ],

  // Estado "produto nao contratado" -> pular sem erro
  semProduto: [
    ':text("não possui")',
    ':text("Nenhum produto")',
    ':text("Nenhuma fatura")',
    ':text("nada por aqui")',
    ':text("Não encontramos")',
  ],
};

const FATURAS = {
  // Container onde as faturas sao listadas (usado para scroll de lazy loading)
  container: [
    '[data-testid*="invoice-list"]',
    '[class*="invoice" i][class*="list" i]',
    'table tbody',
    '[role="table"]',
    'main',
  ],

  // Uma linha/card por fatura
  linha: [
    '[data-testid*="invoice-item"]',
    '[data-testid*="fatura"]',
    'table tbody tr',
    '[role="row"]:not(:has(th))',
    'li[class*="invoice" i]',
    'div[class*="invoice-card" i]',
    'div[class*="fatura" i][class*="card" i]',
  ],

  // Dentro da linha
  competencia: ['[data-testid*="competencia"]', '[class*="competencia" i]', 'td:nth-child(1)'],
  vencimento: ['[data-testid*="vencimento"]', '[class*="vencimento" i]', '[class*="due" i]', 'td:nth-child(2)'],
  valor: ['[data-testid*="valor"]', '[class*="valor" i]', '[class*="amount" i]', 'td:has-text("R$")'],
  situacao: ['[data-testid*="status"]', '[class*="status" i]', '[class*="situacao" i]'],

  // Acao que revela os botoes de download (accordion / "detalhes")
  expandir: [
    'button:has-text("Detalhes")',
    'button:has-text("Ver detalhes")',
    'button[aria-expanded="false"]',
    '[data-testid*="expand"]',
    '[aria-label*="expandir" i]',
  ],

  baixarPDF: [
    '[data-testid*="download-pdf"]',
    'a[href$=".pdf"]',
    'a[href*="pdf" i]',
    'button:has-text("Baixar fatura")',
    'button:has-text("Fatura em PDF")',
    'button:has-text("Baixar PDF")',
    'a:has-text("Baixar fatura")',
    'a:has-text("PDF")',
    'button:has-text("Download")',
    '[aria-label*="baixar fatura" i]',
    '[title*="fatura" i][title*="pdf" i]',
  ],

  baixarBoleto: [
    '[data-testid*="download-boleto"]',
    'button:has-text("Boleto")',
    'a:has-text("Boleto")',
    'button:has-text("2ª via")',
    'button:has-text("Segunda via")',
    'a:has-text("2ª via")',
    '[aria-label*="boleto" i]',
    '[title*="boleto" i]',
  ],

  // Paginacao clássica
  proximaPagina: [
    'button[aria-label*="próxima" i]:not([disabled])',
    'button[aria-label*="next" i]:not([disabled])',
    '[data-testid*="pagination-next"]:not([disabled])',
    'a[rel="next"]',
    'button:has-text("Próxima"):not([disabled])',
    'li.next:not(.disabled) a',
  ],

  // Botao de "carregar mais" (lazy loading por clique)
  carregarMais: [
    'button:has-text("Carregar mais")',
    'button:has-text("Ver mais faturas")',
    'button:has-text("Ver mais")',
    'button:has-text("Mostrar mais")',
    '[data-testid*="load-more"]',
  ],

  // Filtro de periodo, quando existir
  filtroPeriodo: [
    'select[name*="periodo" i]',
    'select[name*="ano" i]',
    '[data-testid*="period-filter"]',
  ],
};

module.exports = { LOGIN, CONTRATOS, NAVEGACAO, FATURAS };
