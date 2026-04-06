import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-analytics.js";
import { 
  getFirestore, collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, setDoc, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import {
  kpis as KPI_TEMPLATE,
  generateId,
  validateNumber,
  filterByDate,
  createClient,
  createProduct,
  createTransaction,
  normalizeClient,
  normalizeProduct,
  normalizeTransaction,
  normalizeStockMovement,
  normalizeSoilRecord,
  normalizeTimestamp,
  toNumber,
} from "./js/data.js";
import { calculateKPIs } from "./js/kpi.js";
import {
  pipelineStages,
  getClientValueScore,
  getClientStageLabel,
  attachRevenueToClients,
  summarizePipeline,
  createClientTimeline,
} from "./js/crm.js";
import { checkLowStock, enrichProductsWithStock } from "./js/stock.js";
import { calculateCashFlow, summarizeExpensesByCategory } from "./js/finance.js";
import { analyzeSoil, generateInsights, runAutomation } from "./js/insights.js";

const firebaseConfig = {
  apiKey: "AIzaSyAu1WnQvDTwyadN9CqNrgyGMoRokNE0dzw",
  authDomain: "agroinsig.firebaseapp.com",
  projectId: "agroinsig",
  storageBucket: "agroinsig.firebasestorage.app",
  messagingSenderId: "1057240399782",
  appId: "1:1057240399782:web:5342ae9beb8efba1a75967",
  measurementId: "G-V5TW9VHGTF"
};

const app = initializeApp(firebaseConfig);
var analytics; try { analytics = getAnalytics(app); } catch(e) { console.warn("Analytics não disponível neste ambiente:", e.message); }
const db = getFirestore(app);

// Expose to global scope for the legacy script to use
window.firebaseDB = db;
window.fbCollection = collection;
window.fbAddDoc = addDoc;
window.fbSetDoc = setDoc;
window.fbDoc = doc;
window.fbOnSnapshot = onSnapshot;
window.fbQuery = query;
window.fbOrderBy = orderBy;
window.fbServerTimestamp = serverTimestamp;
window.fbDeleteDoc = deleteDoc;

var firebaseReadyDispatched = false;

function dispatchFirebaseReady() {
  if (firebaseReadyDispatched || !window.firebaseDB) return;
  firebaseReadyDispatched = true;
  window.dispatchEvent(new Event('firebase-ready'));
}



function updateTopbarTime() {
  var textEl = document.getElementById('topbarMetaText');
  var now = new Intl.DateTimeFormat('pt-BR', { hour:'2-digit', minute:'2-digit' }).format(new Date());
  if (textEl) {
    textEl.innerHTML = 'Safra 2025/26 &middot; Sincronizado às ' + now;
    return;
  }
  var el = document.querySelector('.topbar-meta');
  if (!el) return;
  el.innerHTML = '<span class="pulse-dot"></span> Safra 2025/26 &middot; Sincronizado às ' + now;
}

/* ══════════════════════════════════════════════════
   JS §0  TOAST NOTIFICATIONS
   ══════════════════════════════════════════════════ */
function showToast(msg, type) {
  type = type || 'info';
  var colors = { success: 'var(--green-bright)', error: 'var(--danger)', info: 'var(--gold)' };
  var icons  = { success: '✓', error: '✕', info: 'ℹ' };
  var toast = document.createElement('div');
  toast.style.cssText = [
    'position:fixed;bottom:28px;right:28px;z-index:9999',
    'background:var(--tooltip-bg);color:var(--tooltip-text)',
    'padding:14px 20px;border-radius:12px;font-size:0.88rem',
    'border-left:4px solid '+(colors[type]||colors.info),
    'box-shadow:0 14px 36px rgba(10,56,58,0.22)',
    'max-width:380px;display:flex;align-items:center;gap:10px',
    'animation:fadeUp 0.3s ease forwards',
    'font-family:"DM Sans",sans-serif;line-height:1.45',
  ].join(';');
  toast.innerHTML = '<span style="font-size:1rem;flex-shrink:0">'+(icons[type]||'')+'</span><span>'+msg+'</span>';
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'opacity 0.3s,transform 0.3s';
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 320);
  }, 3200);
}

/* ══════════════════════════════════════════════════
   JS §1  EXPORTAÇÃO
   ══════════════════════════════════════════════════ */
function exportToPDF() {
  var pageTitleEl = document.getElementById('pageTitle');
  var pageLabel = pageTitleEl ? pageTitleEl.textContent : 'Relatório';
  var originalTitle = document.title;
  document.title = 'AgroInsight — ' + pageLabel;
  window.print();
  document.title = originalTitle;
}

/* ══════════════════════════════════════════════════
   JS §2  STATE GLOBAL
   ══════════════════════════════════════════════════ */
const AppState = {
  currentPage: 'dashboard',
  currentTheme: 'light',
  registerCtx: 'operacional',
  reports: [],
  stockEntries: [],
  clients: [],
  products: [],
  soilRecords: [],
  financeTransactions: [],
  financeSources: { modern: [], legacy: [] },
  filters: { startDate: '', endDate: '' },
  derived: {
    kpis: Object.assign({}, KPI_TEMPLATE),
    clients: [],
    products: [],
    cashFlow: [],
    expenseSummary: [],
    lowStock: [],
    insights: [],
    alerts: [],
    pipeline: {},
    soilSummary: { ph: 0, moisture: 0, temperature: 0 },
  },
};

const PAGE_TITLES = {
  dashboard: 'Visão Geral — Dashboard',
  cadastro: 'Cadastro & Registros',
  relatorios: 'Relatórios de Campo',
  analises: 'Análises & Insights',
  culturas: 'Controle de Estoque',
  solo: 'Solo & Clima',
  mercado: 'Mercado & Commodities',
  financeiro: 'Financeiro & Fluxo de Caixa',
  alertas: 'Alertas & Notificações',
  config: 'Configurações',
  clientes: 'Clientes & Relacionamento',
};

var clientCache = {};

function syncTopActionButton(pageId) {
  var topBtn = document.getElementById('topActionBtn');
  if (!topBtn) return;
  if (pageId === 'culturas') {
    topBtn.textContent = 'Nova Movimentação';
    topBtn.setAttribute('aria-label', 'Ir ao formulário de movimentação de estoque');
    topBtn.style.display = '';
    return;
  }
  if (pageId === 'financeiro') {
    topBtn.textContent = 'Novo Lançamento';
    topBtn.setAttribute('aria-label', 'Ir ao formulário de lançamento financeiro');
    topBtn.style.display = '';
    return;
  }
  if (pageId === 'dashboard' || pageId === 'cadastro' || pageId === 'relatorios') {
    topBtn.textContent = 'Novo Cadastro';
    topBtn.setAttribute('aria-label', 'Abrir página de cadastro');
    topBtn.style.display = '';
    return;
  }
  topBtn.style.display = 'none';
}

/* ══════════════════════════════════════════════════
   JS §3  TEMA
   ══════════════════════════════════════════════════ */
function getStoredTheme() {
  try { return localStorage.getItem('agroinsight-theme'); } catch(e) { return null; }
}
function storeTheme(t) {
  try { localStorage.setItem('agroinsight-theme', t); } catch(e) {}
}
function getPreferredTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(theme, store) {
  if (store === undefined) store = true;
  AppState.currentTheme = theme;
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : '';
  if (store) storeTheme(theme);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = 'Tema: ' + (theme === 'dark' ? 'Escuro' : 'Claro');
  reinitCharts();
}
function toggleTheme() {
  applyTheme(AppState.currentTheme === 'dark' ? 'light' : 'dark');
}

/* ══════════════════════════════════════════════════
   JS §4  NAVEGAÇÃO
   ══════════════════════════════════════════════════ */
function setPage(pageId, navBtn) {
  // Esconde todos os painéis
  document.querySelectorAll('.section-panel').forEach(function(p) {
    p.classList.remove('active');
    p.setAttribute('aria-hidden', 'true');
  });
  // Ativa o painel correto
  var panel = document.getElementById('panel-' + pageId);
  if (panel) {
    panel.classList.add('active');
    panel.setAttribute('aria-hidden', 'false');
  }

  // Atualiza nav items
  document.querySelectorAll('.nav-item').forEach(function(n) {
    n.classList.remove('active');
    n.removeAttribute('aria-current');
  });
  if (navBtn) {
    navBtn.classList.add('active');
    navBtn.setAttribute('aria-current', 'page');
  }

  // Atualiza título
  var titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = PAGE_TITLES[pageId] || pageId;

  AppState.currentPage = pageId;

  syncTopActionButton(pageId);

  if (pageId === 'dashboard') reinitCharts();
  closeSidebar();
}

function setDashTab(btn) {
  var tabs = btn.closest('.tab-bar').querySelectorAll('.tab');
  tabs.forEach(function(t) {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  var target = btn.dataset.tab || 'geral';
  document.querySelectorAll('#panel-dashboard [data-tab-content]').forEach(function(el) {
    el.style.display = el.dataset.tabContent === target ? '' : 'none';
  });
  if (target === 'geral') reinitCharts();
}

/* ══════════════════════════════════════════════════
   JS §5  SIDEBAR MOBILE
   ══════════════════════════════════════════════════ */
function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  var bd = document.getElementById('sidebarBackdrop');
  if (!sb || !bd) return;
  sb.classList.toggle('open');
  bd.classList.toggle('hidden');
  document.body.classList.toggle('sidebar-open', sb.classList.contains('open'));
}
function closeSidebar() {
  var sb = document.getElementById('sidebar');
  var bd = document.getElementById('sidebarBackdrop');
  if (!sb || !bd) return;
  sb.classList.remove('open');
  bd.classList.add('hidden');
  document.body.classList.remove('sidebar-open');
}

/* ══════════════════════════════════════════════════
   JS §6  GRÁFICOS
   ══════════════════════════════════════════════════ */
var prodChartInst = null;
var donutChartInst = null;
var chartFallbackShown = false;

function getChartPalette() {
  var s = getComputedStyle(document.documentElement);
  return {
    green:    s.getPropertyValue('--chart-green').trim(),
    greenA:   s.getPropertyValue('--chart-green-a').trim(),
    gold:     s.getPropertyValue('--chart-gold').trim(),
    goldA:    s.getPropertyValue('--chart-gold-a').trim(),
    amber:    s.getPropertyValue('--chart-amber').trim(),
    soil:     s.getPropertyValue('--chart-soil').trim(),
    light:    s.getPropertyValue('--chart-light').trim(),
    text:     s.getPropertyValue('--chart-text').trim(),
    grid:     s.getPropertyValue('--chart-grid').trim(),
    tooltipBg:   s.getPropertyValue('--tooltip-bg').trim(),
    tooltipText: s.getPropertyValue('--tooltip-text').trim(),
  };
}

function destroyCharts() {
  if (prodChartInst) { prodChartInst.destroy(); prodChartInst = null; }
  if (donutChartInst) { donutChartInst.destroy(); donutChartInst = null; }
}

function showChartFallback() {
  ['prodChart', 'donutChart'].forEach(function(id) {
    var canvas = document.getElementById(id);
    if (!canvas) return;
    var wrap = canvas.closest('.chart-wrap');
    if (!wrap || wrap.querySelector('.chart-fallback')) return;
    wrap.innerHTML = '<div class="history-empty chart-fallback"><div class="history-empty-icon">📉</div><div>Graficos indisponiveis no momento.</div></div>';
  });
}

function canRenderCharts() {
  if (window.Chart) return true;
  if (!chartFallbackShown) {
    chartFallbackShown = true;
    console.warn('Chart.js nao foi carregado. Os graficos foram desativados para evitar quebra da interface.');
    showChartFallback();
    showToast('Chart.js indisponivel. Os graficos foram desativados.', 'error');
  }
  return false;
}

function initProdChart() {
  var canvas = document.getElementById('prodChart');
  if (!canvas || !canRenderCharts()) return;
  var p = getChartPalette();
  var months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  var safra = [0, 0, 0, 0, 0, 0, 0, 980, 2100, 3450, 4200, 4800];
  var meta  = [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400, 4800];

  prodChartInst = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [
        {
          type: 'bar',
          label: 'Safra 25/26',
          data: safra,
          backgroundColor: p.greenA,
          borderColor: p.green,
          borderWidth: 1.5,
          borderRadius: 6,
          order: 2,
        },
        {
          type: 'line',
          label: 'Meta',
          data: meta,
          borderColor: p.gold,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 4],
          pointRadius: 3,
          pointBackgroundColor: p.gold,
          tension: 0.4,
          order: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, color: p.text, font: { family: 'DM Sans' } } },
        tooltip: {
          backgroundColor: p.tooltipBg,
          titleColor: p.tooltipText,
          bodyColor: p.tooltipText,
          padding: 12,
          cornerRadius: 10,
        }
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: p.text, font: { family: 'DM Sans' } } },
        y: { grid: { color: p.grid }, border: { display: false }, ticks: { color: p.text, font: { family: 'DM Sans' } } }
      }
    }
  });
}

function initDonutChart() {
  var canvas = document.getElementById('donutChart');
  if (!canvas || !canRenderCharts()) return;
  var p = getChartPalette();

  donutChartInst = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Soja', 'Milho 2ª', 'Algodão', 'Outros'],
      datasets: [{
        data: [58, 28, 9, 5],
        backgroundColor: [p.green, p.gold, p.amber, p.soil],
        borderColor: 'transparent',
        borderWidth: 0,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true, color: p.text, font: { family: 'DM Sans' } } },
        tooltip: {
          backgroundColor: p.tooltipBg,
          titleColor: p.tooltipText,
          bodyColor: p.tooltipText,
          padding: 12,
          cornerRadius: 10,
          callbacks: {
            label: function(ctx) { return ' ' + ctx.label + ': ' + ctx.parsed + '%'; }
          }
        }
      }
    }
  });
}

function reinitCharts() {
  destroyCharts();
  setTimeout(function() {
    var prodCanvas = document.getElementById('prodChart');
    var donutCanvas = document.getElementById('donutChart');
    if (prodCanvas && prodCanvas.offsetParent !== null) initProdChart();
    if (donutCanvas && donutCanvas.offsetParent !== null) initDonutChart();
  }, 50);
}

/* ══════════════════════════════════════════════════
   JS §7  HELPERS DE FORMULÁRIO
   ══════════════════════════════════════════════════ */
function setCollapsibleState(el, show) {
  if (!el) return;
  if (el.classList.contains('registry-collapsible')) {
    el.classList.toggle('is-collapsed', !show);
  } else {
    el.classList.toggle('registry-hidden', !show);
  }
}

function bindConditional(triggerId, targetId, matchValue) {
  var trigger = document.getElementById(triggerId);
  var target  = document.getElementById(targetId);
  if (!trigger || !target) return;
  var sync = function() { setCollapsibleState(target, trigger.value === matchValue); };
  trigger.addEventListener('change', sync);
  sync();
}

function formatCurrencyBr(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(toNumber(value));
}

function formatCompactCurrency(value) {
  var amount = toNumber(value);
  var absolute = Math.abs(amount);
  if (absolute >= 1000000) return 'R$ ' + (amount / 1000000).toFixed(1).replace('.', ',') + ' mi';
  if (absolute >= 1000) return 'R$ ' + (amount / 1000).toFixed(1).replace('.', ',') + ' mil';
  return formatCurrencyBr(amount);
}

function formatPercent(value, fractionDigits) {
  fractionDigits = fractionDigits === undefined ? 1 : fractionDigits;
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toNumber(value)) + '%';
}

function formatRatio(value) {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toNumber(value)) + 'x';
}

function formatDateTime(dateValue) {
  var normalized = normalizeTimestamp(dateValue);
  if (!normalized) return '--';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(normalized));
}

function toDateInputValue(dateValue) {
  var normalized = normalizeTimestamp(dateValue);
  return normalized ? normalized.slice(0, 10) : '';
}

function parseCurrencyInput(val) {
  return toNumber(val);
}

function formatCurrencyInput(raw) {
  var digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  var num = parseInt(digits, 10) / 100;
  return formatCurrencyBr(num);
}

function initInputHelpers() {
  document.querySelectorAll('[data-numeric-only="true"]').forEach(function(inp) {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', function() {
      inp.value = inp.value.replace(/\D/g, '');
    });
  });
  document.querySelectorAll('[data-currency="true"]').forEach(function(inp) {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', function() {
      inp.value = formatCurrencyInput(inp.value);
    });
  });
}

function initConditionalFields() {
  bindConditional('fClientOrigem',      'fClientOrigemOutroWrap', 'Outros');
  bindConditional('fClientPropriedade', 'fClientPropOutroWrap',   'Outros');
  bindConditional('fClientResponsavel', 'fClientRespOutroWrap',   'Outros');
  bindConditional('fClientPgto',        'fClientBarterWrap',      'Barter');
  bindConditional('fGastoResp',         'fGastoRespOutroWrap',    'Outro');

  // Atividade: Interna/Externa
  var fAtivModo = document.getElementById('fAtivModo');
  var internaWrap = document.getElementById('fAtivInternaWrap');
  var externaWrap = document.getElementById('fAtivExternaWrap');
  if (fAtivModo) {
    var syncAtiv = function() {
      setCollapsibleState(internaWrap, fAtivModo.value === 'Interna');
      setCollapsibleState(externaWrap, fAtivModo.value === 'Externa');
    };
    fAtivModo.addEventListener('change', syncAtiv);
    syncAtiv();
  }
}

/* ══════════════════════════════════════════════════
   JS §8  CONTEXTO DE REGISTRO
   ══════════════════════════════════════════════════ */
function setRegCtx(ctx, btn) {
  AppState.registerCtx = ctx;
  // Atualiza botões da switcher
  document.querySelectorAll('.form-switch-btn').forEach(function(b) {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
  });
  // Mostra/oculta módulos
  document.querySelectorAll('.module-card').forEach(function(card) {
    var cardCtx = card.dataset.modCtx;
    card.classList.toggle('hidden', cardCtx !== ctx);
  });
  // Atualiza mensagem de status
  var msgs = {
    operacional: 'Contexto operacional ativo. Preencha os módulos e salve individualmente.',
    financeiro:  'Contexto financeiro ativo. Preencha a tabela de gastos e salve.',
    veiculo:     'Contexto de veículo ativo. Preencha o uso do veículo e salve.',
  };
  var statusEl = document.getElementById('registerStatus');
  if (statusEl) statusEl.textContent = msgs[ctx] || '';
}

function handleTopAction() {
  if (AppState.currentPage === 'culturas') {
    var stockForm = document.querySelector('.stock-form-card');
    if (stockForm) stockForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var entradaBtn = document.querySelector('.stock-tab-btn');
    if (entradaBtn && !entradaBtn.classList.contains('active')) entradaBtn.click();
    return;
  }
  if (AppState.currentPage === 'financeiro') {
    var txType = document.getElementById('txType');
    if (txType) txType.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (AppState.currentPage !== 'cadastro') {
    var cadastroBtn = document.querySelector('.nav-item[data-page="cadastro"]');
    setPage('cadastro', cadastroBtn);
  }
  var registerPanel = document.getElementById('registerPanel');
  if (registerPanel) registerPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


function resetModuleFields(type) {
  var fieldMap = {
    client:    ['fClientOrigem','fClientNome','fClientPropriedade','fClientCidade','fClientTel','fClientEmail'],
    atividade: ['fAtivModo','fAtivData','fAtivInterna','fAtivExterna','fAtivProdutor','fAtivFazenda','fAtivObs'],
    gasto:     ['fGastoTipo','fGastoResp','fGastoData','fGastoValor','fGastoCentro','fGastoNF','fGastoDesc'],
    veiculo:   ['fVeicVeiculo','fVeicPlaca','fVeicMotorista','fVeicData','fVeicKmI','fVeicKmF','fVeicLitros','fVeicCusto','fVeicDestino','fVeicObs'],
  };
  (fieldMap[type] || []).forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT') el.selectedIndex = 0;
    else el.value = '';
  });
}

/* ══════════════════════════════════════════════════
   JS §9  SALVAR MÓDULO DE REGISTRO
   ══════════════════════════════════════════════════ */
function saveModule(type, btn) {
  var original = btn.textContent;

  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }

  if (type === 'client') {
    var nomeCliente = document.getElementById('fClientNome').value.trim();
    if (!nomeCliente) {
      flashBtn(btn, 'Informe o cliente');
      return;
    }

    var lastContact = document.getElementById('fClientContato').value;
    var property = document.getElementById('fClientPropriedade').value;
    if (property === 'Outros') property = document.getElementById('fClientPropOutro').value.trim();

    var crmClient = createClient({
      name: nomeCliente,
      status: 'lead',
      estimatedValue: 0,
      probability: 0,
      lastContact: lastContact ? new Date(lastContact + 'T12:00:00').toISOString() : null,
      nextAction: 'Novo cadastro via módulo operacional',
      totalRevenue: 0,
      createdAt: new Date().toISOString(),
      property: property,
      city: document.getElementById('fClientCidade').value.trim(),
      phone: document.getElementById('fClientTel').value.trim(),
      email: document.getElementById('fClientEmail').value.trim(),
      crop: Array.prototype.map.call(document.getElementById('fClientCulturas').selectedOptions || [], function(opt) { return opt.value; }).join(', '),
      paymentMethod: document.getElementById('fClientPgto').value,
      notes: [
        document.getElementById('fClientOrigem').value,
        document.getElementById('fClientProduto').value,
        document.getElementById('fClientTipo').value
      ].filter(Boolean).join(' · ')
    });

    btn.textContent = 'Salvando...';
    window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes'), crmClient).then(function(docRef) {
      return window.fbAddDoc(
        window.fbCollection(window.firebaseDB, 'clientes/' + docRef.id + '/timeline'),
        createClientTimeline('Cliente criado pelo módulo operacional.', 'new', { author: 'Usuário' })
      );
    }).then(function() {
      resetModuleFields('client');
      btn.textContent = '✓ Cliente salvo!';
      btn.style.background = 'var(--green-bright)';
      btn.style.color = 'var(--green-deep)';
      setTimeout(function() {
        btn.textContent = original;
        btn.style.background = '';
        btn.style.color = '';
      }, 1800);
    }).catch(function(error) {
      console.error(error);
      flashBtn(btn, 'Erro ao salvar');
    });
    return;
  }

  if (type === 'gasto') {
    var categoria = document.getElementById('fGastoTipo').value;
    var valor = parseCurrencyInput(document.getElementById('fGastoValor').value);
    if (!categoria || !validateNumber(valor)) {
      flashBtn(btn, 'Preencha categoria e valor');
      return;
    }

    var financeRecord = createTransaction({
      type: 'expense',
      category: categoria,
      amount: valor,
      date: document.getElementById('fGastoData').value
        ? new Date(document.getElementById('fGastoData').value + 'T12:00:00').toISOString()
        : new Date().toISOString(),
      description: document.getElementById('fGastoDesc').value.trim() || document.getElementById('fGastoCentro').value.trim(),
      createdAt: new Date().toISOString()
    });

    btn.textContent = 'Salvando...';
    window.fbAddDoc(window.fbCollection(window.firebaseDB, 'finance'), financeRecord).then(function() {
      resetModuleFields('gasto');
      btn.textContent = '✓ Gasto salvo!';
      btn.style.background = 'var(--green-bright)';
      btn.style.color = 'var(--green-deep)';
      setTimeout(function() {
        btn.textContent = original;
        btn.style.background = '';
        btn.style.color = '';
      }, 1800);
    }).catch(function(error) {
      console.error(error);
      flashBtn(btn, 'Erro ao salvar');
    });
    return;
  }

  var data = { type: type, createdAt: window.fbServerTimestamp ? window.fbServerTimestamp() : new Date().toISOString() };
  var missing = [];

  if (type === 'atividade') {
    data.atividade = document.getElementById('fAtivModo').value;
    data.data = document.getElementById('fAtivData').value;
    data.produtor = document.getElementById('fAtivProdutor').value.trim();
    data.fazenda = document.getElementById('fAtivFazenda').value.trim();
    data.obs = document.getElementById('fAtivObs').value.trim();
    if (!data.atividade) missing.push('Atividade');
    if (!data.data) missing.push('Data');
  } else if (type === 'veiculo') {
    data.veiculo = document.getElementById('fVeicVeiculo').value.trim();
    data.data = document.getElementById('fVeicData').value;
    data.placa = (document.getElementById('fVeicPlaca') || {}).value || '';
    data.motorista = (document.getElementById('fVeicMotorista') || {}).value || '';
    data.litros = toNumber((document.getElementById('fVeicLitros') || {}).value || '');
    data.custo = parseCurrencyInput((document.getElementById('fVeicCusto') || {}).value || '');
    data.destino = (document.getElementById('fVeicDestino') || {}).value || '';
    data.obs = (document.getElementById('fVeicObs') || {}).value || '';

    var kmInicial = toNumber((document.getElementById('fVeicKmI') || {}).value || '');
    var kmFinal = toNumber((document.getElementById('fVeicKmF') || {}).value || '');
    if (!data.veiculo) missing.push('Veículo');
    if (!data.data) missing.push('Data');
    if (kmFinal > 0 && kmInicial > 0 && kmFinal < kmInicial) {
      flashBtn(btn, 'KM final menor que inicial');
      return;
    }

    data.kmInicial = kmInicial;
    data.kmFinal = kmFinal;
    data.kmRodados = (kmFinal > 0 && kmInicial > 0) ? (kmFinal - kmInicial) : 0;
  }

  if (missing.length > 0) {
    flashBtn(btn, 'Preencha: ' + missing.join(', '));
    return;
  }

  btn.textContent = 'Salvando...';
  var collectionName = type === 'atividade' ? 'registros_atividades' : 'registros_veiculos';
  window.fbAddDoc(window.fbCollection(window.firebaseDB, collectionName), data).then(function() {
    resetModuleFields(type);
    btn.textContent = '✓ Salvo!';
    btn.style.background = 'var(--green-bright)';
    btn.style.color = 'var(--green-deep)';
    setTimeout(function() {
      btn.textContent = original;
      btn.style.background = '';
      btn.style.color = '';
    }, 1800);
  }).catch(function(error) {
    console.error(error);
    flashBtn(btn, 'Erro ao salvar');
  });
}

/* ══════════════════════════════════════════════════
   JS §10  RELATÓRIOS — LAB, HISTÓRICO, PREVIEW
   ══════════════════════════════════════════════════ */
function generateReport() {
  var safra   = document.getElementById('labSafra').value;
  var tipo    = document.getElementById('labTipo').value;
  var cliente = document.getElementById('labCliente').value.trim();
  var periodo = document.getElementById('labPeriodo').value;
  var obs     = document.getElementById('labObs').value.trim();

  if (!cliente) { showToast('Informe o cliente ou produtor.', 'error'); return; }

  var reportData = {
    tipo: tipo,
    safra: safra,
    cliente: cliente,
    periodo: periodo,
    obs: obs,
    createdAt: window.fbServerTimestamp ? window.fbServerTimestamp() : new Date().toISOString()
  };

  if (window.firebaseDB) {
    window.fbAddDoc(window.fbCollection(window.firebaseDB, 'reports'), reportData).then(function(){
      clearLabForm();
      showToast('Relatório gerado com sucesso!', 'success');
    }).catch(function(e){
      showToast('Erro ao gerar relatório: '+e.message, 'error');
    });
  } else {
    // Fallback if not loaded
    reportData.id = Date.now().toString(36);
    AppState.reports.unshift(reportData);
    filterReports();
    clearLabForm();
    showToast('Relatório gerado com sucesso!', 'success');
  }
}

function clearLabForm() {
  ['labCliente','labObs'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var lp = document.getElementById('labPeriodo');
  if (lp) lp.value = '';
}

function renderHistory(listData) {
  var list = document.getElementById('historyList');
  var count = document.getElementById('historyCount');
  if (!list) return;
  var reports = listData !== undefined ? listData : AppState.reports;
  var navBadge = document.getElementById('navBadgeRelatorios');
  if (listData === undefined) {
    if (count) count.textContent = reports.length + (reports.length === 1 ? ' relatório' : ' relatórios');
    if (navBadge) navBadge.textContent = reports.length;
  } else {
    if (count) count.textContent = reports.length + ' resultado' + (reports.length !== 1 ? 's' : '');
  }

  if (reports.length === 0) {
    list.innerHTML = '<div class="history-empty"><div class="history-empty-icon">📋</div>' +
      (listData !== undefined ? 'Nenhum relatório encontrado.' : 'Nenhum relatório gerado ainda.') +
      '</div>';
    return;
  }
  var html = '';
  reports.forEach(function(r) {
    var _rc = r.createdAt;
    var dateStr = _rc ? formatDate(typeof _rc === 'string' ? _rc.slice(0,10) : (_rc.toDate ? _rc.toDate().toISOString().slice(0,10) : null)) : '--';
    html += '<div class="history-item" role="button" tabindex="0" data-report-id="' + escapeHtml(r.id) + '">';
    html += '<div class="history-item-head">';
    html += '<div class="history-item-title">' + escapeHtml(r.tipo) + '</div>';
    html += '<span class="history-item-code">' + escapeHtml(r.id) + '</span>';
    html += '</div>';
    html += '<div class="history-item-meta">';
    html += '<span>👤 ' + escapeHtml(r.cliente) + '</span>';
    html += '<span>🌾 ' + escapeHtml(r.safra) + '</span>';
    html += '<span>📅 ' + dateStr + '</span>';
    html += '</div></div>';
  });
  list.innerHTML = html;
  animateCards('historyList', '.history-item');
}

function filterReports() {
  var buscaEl = document.getElementById('buscaRelatorio');
  var q = buscaEl ? buscaEl.value.toLowerCase().trim() : '';
  if (!q) { renderHistory(); return; }
  var filtered = AppState.reports.filter(function(r) {
    return (r.cliente || '').toLowerCase().includes(q) ||
           (r.tipo    || '').toLowerCase().includes(q) ||
           (r.safra   || '').toLowerCase().includes(q);
  });
  renderHistory(filtered);
}

function updateNavBadge() {
  var el = document.getElementById('navBadgeRelatorios');
  if (el) el.textContent = AppState.reports.length;
}

function openPreview(reportId) {
  var report = AppState.reports.find(function(r) { return r.id === reportId; });
  if (!report) return;

  var previewTitle = document.getElementById('previewTitle');
  var previewDate = document.getElementById('previewDate');
  var previewStamp = document.getElementById('previewStamp');
  var previewBody = document.getElementById('previewBody');
  var previewOverlay = document.getElementById('previewOverlay');
  if (!previewTitle || !previewDate || !previewStamp || !previewBody || !previewOverlay) return;

  previewTitle.textContent = report.tipo;
  var _cat = report.createdAt;
  var _dateStr = _cat ? formatDate(typeof _cat === 'string' ? _cat.slice(0,10) : (_cat.toDate ? _cat.toDate().toISOString().slice(0,10) : null)) : '--';
  previewDate.textContent = 'Gerado em ' + _dateStr;
  previewStamp.textContent = report.safra;

  var body = '';
  body += field('Código', report.id);
  body += field('Cliente / Produtor', report.cliente);
  body += field('Safra', report.safra);
  if (report.periodo) body += field('Período', report.periodo);
  if (report.obs) body += field('Observações', report.obs);

  previewBody.innerHTML = body;
  previewOverlay.classList.remove('hidden');
  previewOverlay.setAttribute('aria-hidden', 'false');
}

function field(label, value) {
  return '<div class="preview-field"><div class="preview-field-label">' + label + '</div><div class="preview-field-value">' + escapeHtml(value) + '</div></div>';
}

function closePreview() {
  var previewOverlay = document.getElementById('previewOverlay');
  if (!previewOverlay) return;
  previewOverlay.classList.add('hidden');
  previewOverlay.setAttribute('aria-hidden', 'true');
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════
   JS §11  ESTOQUE
   ══════════════════════════════════════════════════ */
function setStockTab(type, btn) {
  document.querySelectorAll('.stock-tab-btn').forEach(function(b) {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.stock-section').forEach(function(s) { s.classList.remove('active'); });
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
  var section = document.getElementById('stock' + type.charAt(0).toUpperCase() + type.slice(1));
  if (section) section.classList.add('active');
}

function flashBtn(btn, msg) {
  var orig = btn.textContent;
  btn.textContent = msg;
  btn.style.background = 'var(--danger)';
  btn.style.color = '#fff';
  setTimeout(function() {
    btn.textContent = orig;
    btn.style.background = '';
    btn.style.color = '';
  }, 2500);
}



/* ══════════════════════════════════════════════════
   JS §16  CLIENTES
   ══════════════════════════════════════════════════ */
function toggleClientCard(id) {
  var card = document.getElementById('ccard-' + id);
  if (!card) return;
  card.classList.toggle('expanded');
  var toggle = card.querySelector('[data-client-toggle]');
  if (toggle) toggle.setAttribute('aria-expanded', card.classList.contains('expanded') ? 'true' : 'false');
}

/* ══════════════════════════════════════════════════
   JS §17  PRODUTOS CADASTRO
   ══════════════════════════════════════════════════ */
var _produtos = [];

function deleteProduto(id, btn) {
  if (!confirm('Remover este produto do cadastro?')) return;
  if (!window.firebaseDB) {
    showToast('Firebase não conectado.', 'error');
    return;
  }
  if (btn) {
    btn.textContent = '...';
    btn.disabled = true;
  }
  var doDelete = function() {
    if (window.fbDeleteDoc && window.fbDoc) {
      return window.fbDeleteDoc(window.fbDoc(window.firebaseDB, 'produtos', id));
    } else {
      return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'produtos', id), { _deleted: true }, { merge: true });
    }
  };
  doDelete()
    .then(function() {
      showToast('Produto removido com sucesso.', 'success');
    })
    .catch(function(e) {
      showToast('Erro ao remover produto: ' + (e.message || 'tente novamente.'), 'error');
      if (btn) {
        btn.textContent = '🗑 Remover';
        btn.disabled = false;
      }
    });
}

/* ══════════════════════════════════════════════════
   JS §12  CONFIGURAÇÕES
   ══════════════════════════════════════════════════ */
function applyConfigToDOM(cfg) {
  if (!cfg) return;
  var avatarEl = document.querySelector('.company-avatar');
  var nameEl   = document.querySelector('.company-name');
  if (avatarEl) avatarEl.textContent = (cfg.empresa || 'AG').slice(0,2).toUpperCase();
  if (nameEl)   nameEl.textContent   = cfg.empresa || 'AgroTech Brasil';
  var map = { empresa:'cfgEmpresa', cnpj:'cfgCnpj', resp:'cfgResp', cidade:'cfgCidade', wpp:'cfgWpp' };
  Object.keys(map).forEach(function(k) {
    var el = document.getElementById(map[k]);
    if (el && cfg[k] !== undefined) el.value = cfg[k];
  });
  // Safra select
  var sEl = document.getElementById('cfgSafra');
  if (sEl && cfg.safra) sEl.value = cfg.safra;
}

/* ══════════════════════════════════════════════════
   JS §13  ESTADOS DE LOADING
   ══════════════════════════════════════════════════ */
function setLoadingState(ids) {
  var placeholder = '<div class="loading-placeholder"><div class="loading-spinner"></div><span>Carregando dados...</span></div>';
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = placeholder;
  });
}

/* ══════════════════════════════════════════════════
   JS §14  ANIMAÇÃO ESCALONADA DE CARDS
   ══════════════════════════════════════════════════ */
function animateCards(containerId, cardSelector) {
  cardSelector = cardSelector || '.kpi-card, .alert-item, .commodity-card, .insight-summary-card, .soil-card, .finance-card, .history-item, .client-card, .rank-item';
  var container = document.getElementById(containerId);
  if (!container) return;
  var cards = container.querySelectorAll(cardSelector);
  cards.forEach(function(card, i) {
    card.style.opacity = '0';
    card.style.transform = 'translateY(12px)';
    card.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
    card.style.transitionDelay = (i * 55) + 'ms';
    void card.offsetWidth;
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  });
}

function saveConfig() {
  var cfg = {
    empresa: document.getElementById('cfgEmpresa').value,
    cnpj:    document.getElementById('cfgCnpj').value,
    resp:    document.getElementById('cfgResp').value,
    safra:   document.getElementById('cfgSafra').value,
    cidade:  document.getElementById('cfgCidade').value,
    wpp:     document.getElementById('cfgWpp').value,
  };
  try { localStorage.setItem('agroinsight-config', JSON.stringify(cfg)); } catch(e) {}
  applyConfigToDOM(cfg);
  showToast('Configurações salvas com sucesso!', 'success');
}

function resetSeedProtection() {
  try { localStorage.removeItem('agroinsight-seeded'); } catch(e) {}
  showToast('Protecao de seed removida.', 'info');
}

function initSemanticUI() {
  var dashboardTabBar = document.querySelector('.tab-bar');
  if (dashboardTabBar) dashboardTabBar.setAttribute('role', 'tablist');

  var stockTabs = document.querySelector('.stock-tabs');
  if (stockTabs) stockTabs.setAttribute('role', 'tablist');

  document.querySelectorAll('.form-switcher').forEach(function(formSwitcher) {
    formSwitcher.setAttribute('role', 'tablist');
  });

  document.querySelectorAll('.tab-bar .tab').forEach(function(tab) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
  });

  document.querySelectorAll('.stock-tab-btn').forEach(function(tab) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
  });

  document.querySelectorAll('.form-switch-btn').forEach(function(tab) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
  });

  document.querySelectorAll('.section-panel').forEach(function(panel) {
    var pageId = (panel.id || '').replace('panel-', '');
    panel.setAttribute('role', 'region');
    panel.setAttribute('tabindex', '-1');
    panel.setAttribute('aria-label', PAGE_TITLES[pageId] || 'Painel');
    panel.setAttribute('aria-hidden', panel.classList.contains('active') ? 'false' : 'true');
  });

  document.querySelectorAll('.nav-item[data-page]').forEach(function(btn) {
    if (btn.classList.contains('active')) btn.setAttribute('aria-current', 'page');
  });

  var previewOverlay = document.getElementById('previewOverlay');
  if (previewOverlay) previewOverlay.setAttribute('aria-hidden', previewOverlay.classList.contains('hidden') ? 'true' : 'false');
}

function bindDependencyFallbacks() {
  var chartScript = document.getElementById('chartJsCdn');
  if (!chartScript || chartScript.dataset.bound === '1') return;
  chartScript.dataset.bound = '1';
  chartScript.addEventListener('error', function() {
    canRenderCharts();
  });
}

function formatDate(dateValue) {
  var normalized = normalizeTimestamp(dateValue);
  if (!normalized) return '--';
  return new Intl.DateTimeFormat('pt-BR').format(new Date(normalized));
}

function toInputDate(dateValue) {
  return toDateInputValue(dateValue);
}

function getClientById(clientId) {
  return AppState.clients.find(function(client) { return client.id === clientId; }) || null;
}

function getClientByName(name) {
  var normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return AppState.clients.find(function(client) {
    return String(client.name || '').trim().toLowerCase() === normalized;
  }) || null;
}

function updateGlobalFilterSummary() {
  var summary = document.getElementById('globalFilterSummary');
  if (!summary) return;
  if (!AppState.filters.startDate && !AppState.filters.endDate) {
    summary.textContent = 'Sem filtro de período.';
    return;
  }
  var parts = [];
  if (AppState.filters.startDate) parts.push('de ' + formatDate(AppState.filters.startDate));
  if (AppState.filters.endDate) parts.push('até ' + formatDate(AppState.filters.endDate));
  summary.textContent = 'Filtro aplicado: ' + parts.join(' ');
}

function setGlobalFilter(startDate, endDate) {
  AppState.filters.startDate = startDate || '';
  AppState.filters.endDate = endDate || '';
  updateGlobalFilterSummary();
  renderDerivedViews();
}

function clearGlobalFilter() {
  var start = document.getElementById('globalStartDate');
  var end = document.getElementById('globalEndDate');
  if (start) start.value = '';
  if (end) end.value = '';
  setGlobalFilter('', '');
}

function buildSoilSummary(records) {
  var summary = { ph: 0, moisture: 0, temperature: 0 };
  records.forEach(function(record) {
    var label = String(record.param || '').toLowerCase();
    if (!summary.ph && (label.indexOf('ph') >= 0 || toNumber(record.ph) > 0)) {
      summary.ph = toNumber(record.ph || record.value);
    }
    if (!summary.moisture && (label.indexOf('umidade') >= 0 || label.indexOf('moisture') >= 0 || toNumber(record.moisture) > 0)) {
      summary.moisture = toNumber(record.moisture || record.value);
    }
    if (!summary.temperature && (label.indexOf('temper') >= 0 || toNumber(record.temperature) > 0)) {
      summary.temperature = toNumber(record.temperature || record.value);
    }
  });
  return summary;
}

function deriveDomainData() {
  var products = enrichProductsWithStock(AppState.products, AppState.stockEntries);
  var finance = (AppState.filters.startDate || AppState.filters.endDate)
    ? filterByDate(AppState.financeTransactions, AppState.filters.startDate, AppState.filters.endDate)
    : AppState.financeTransactions.slice();
  var stockRange = (AppState.filters.startDate || AppState.filters.endDate)
    ? filterByDate(AppState.stockEntries, AppState.filters.startDate, AppState.filters.endDate)
    : AppState.stockEntries.slice();
  var clients = attachRevenueToClients(AppState.clients, finance);
  var soilSummary = buildSoilSummary(AppState.soilRecords);
  var data = {
    clients: clients,
    products: products,
    finance: finance,
    stock: AppState.stockEntries,
    stockRange: stockRange,
    soil: AppState.soilRecords,
    soilSummary: soilSummary
  };

  AppState.derived = {
    kpis: calculateKPIs(data),
    clients: clients,
    products: products,
    cashFlow: calculateCashFlow(finance),
    expenseSummary: summarizeExpensesByCategory(finance),
    lowStock: checkLowStock(products),
    insights: generateInsights(data),
    alerts: runAutomation(data),
    pipeline: summarizePipeline(clients),
    soilSummary: soilSummary
  };
}

function renderKpiCards(containerId, cards) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = cards.map(function(card) {
    return '<div class="kpi-card ' + card.color + '">' +
      '<div class="kpi-icon">' + card.icon + '</div>' +
      '<div class="kpi-label">' + escapeHtml(card.label) + '</div>' +
      '<div class="kpi-value">' + escapeHtml(card.value) + '</div>' +
      '<div class="kpi-change">' + escapeHtml(card.change) + '</div>' +
      '</div>';
  }).join('');
  animateCards(containerId, '.kpi-card');
}

function renderDashboardDerived() {
  var kpi = AppState.derived.kpis;
  renderKpiCards('dashKpiList', [
    { label: 'Receita Total', value: formatCompactCurrency(kpi.totalRevenue), change: kpi.totalRevenue ? 'Baseado nos lançamentos filtrados' : 'Sem receitas lançadas', color: 'green', icon: '💰' },
    { label: 'Despesas Totais', value: formatCompactCurrency(kpi.totalExpenses), change: kpi.totalExpenses ? 'Controle operacional atualizado' : 'Sem despesas lançadas', color: 'amber', icon: '💸' },
    { label: 'Lucro Líquido', value: formatCompactCurrency(kpi.netProfit), change: kpi.netProfit >= 0 ? 'Receitas acima das despesas' : 'Operação no vermelho', color: kpi.netProfit >= 0 ? 'gold' : 'soil', icon: '📈' },
    { label: 'Ticket Médio', value: formatCompactCurrency(kpi.averageTicket), change: 'Receita dividida pelos clientes', color: 'soil', icon: '🎯' }
  ]);

  renderKpiCards('bridgeKpiList', [
    { label: 'Receita por Cliente', value: formatCompactCurrency(kpi.revenuePerClient), change: 'Eficiência comercial da carteira', color: 'green', icon: '👥' },
    { label: 'Valor em Estoque', value: formatCompactCurrency(kpi.inventoryValue), change: 'Capital parado em produtos', color: 'gold', icon: '📦' },
    { label: 'Giro de Estoque', value: formatRatio(kpi.stockTurnover), change: 'Saídas sobre o estoque atual', color: 'amber', icon: '🔄' }
  ]);

  var pipeline = AppState.derived.pipeline;
  var pipelineValue = AppState.derived.clients.reduce(function(sum, client) {
    return sum + getClientValueScore(client);
  }, 0);
  renderKpiCards('dashOpKpiList', [
    { label: 'Leads Ativos', value: String(pipeline.lead || 0), change: 'Topo do funil comercial', color: 'gold', icon: '🧲' },
    { label: 'Propostas', value: String(pipeline.proposal || 0), change: 'Clientes em negociação', color: 'green', icon: '📝' },
    { label: 'Fechamentos', value: String(pipeline.closed || 0), change: 'Clientes convertidos', color: 'soil', icon: '🤝' },
    { label: 'Pipeline Ponderado', value: formatCompactCurrency(pipelineValue), change: 'Estimado por probabilidade', color: 'amber', icon: '📊' }
  ]);

  var feed = [];
  AppState.derived.cashFlow.slice(-3).reverse().forEach(function(item) {
    feed.push({
      date: item.date,
      text: (item.type === 'income' ? 'Receita' : 'Despesa') + ' · ' + item.category + ' · ' + formatCurrencyBr(item.amount)
    });
  });
  AppState.stockEntries.slice(0, 3).forEach(function(item) {
    feed.push({
      date: item.date || item.createdAt,
      text: 'Estoque · ' + item.productName + ' · ' + item.quantity + ' ' + item.unit
    });
  });
  feed.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var opList = document.getElementById('dashOpRegistros');
  if (opList) {
    if (!feed.length) {
      opList.textContent = 'Nenhum registro operacional recente.';
    } else {
      opList.innerHTML = feed.slice(0, 6).map(function(entry) {
        return '<div class="history-item" style="margin-bottom:10px;cursor:default;">' +
          '<div class="history-item-title" style="margin-bottom:6px;">' + escapeHtml(entry.text) + '</div>' +
          '<div class="history-item-meta"><span>📅 ' + escapeHtml(formatDateTime(entry.date)) + '</span></div>' +
          '</div>';
      }).join('');
    }
  }
}

function renderFinanceDerived() {
  var kpi = AppState.derived.kpis;
  var cards = [
    { label: 'Receita', value: formatCompactCurrency(kpi.totalRevenue), className: 'income' },
    { label: 'Despesas', value: formatCompactCurrency(kpi.totalExpenses), className: 'expense' },
    { label: 'Lucro', value: formatCompactCurrency(kpi.netProfit), className: kpi.netProfit >= 0 ? 'income' : 'expense' },
    { label: 'Estoque', value: formatCompactCurrency(kpi.inventoryValue), className: '' }
  ];
  var html = cards.map(function(card) {
    return '<div class="finance-card"><div class="finance-label">' + escapeHtml(card.label) + '</div><div class="finance-value ' + (card.className || '') + '">' + escapeHtml(card.value) + '</div></div>';
  }).join('');
  var financeEl = document.getElementById('financeSummaryList');
  var dashEl = document.getElementById('dashFinanceSummary');
  if (financeEl) { financeEl.innerHTML = html; animateCards('financeSummaryList', '.finance-card'); }
  if (dashEl) dashEl.innerHTML = html;

  var rows = AppState.derived.expenseSummary.length
    ? AppState.derived.expenseSummary.map(function(item) {
        return '<tr><td>' + escapeHtml(item.category) + '</td><td>' + escapeHtml(formatCurrencyBr(item.amount)) + '</td><td>' + escapeHtml(formatPercent(item.percent)) + '</td><td class="' + escapeHtml(item.variantClass) + '">' + escapeHtml(item.variantTxt) + '</td></tr>';
      }).join('')
    : '<tr><td colspan="4" class="table-empty">Nenhuma despesa encontrada para o período.</td></tr>';
  var expenseBody = document.getElementById('expenseTableBody');
  var dashExpenseBody = document.getElementById('dashExpenseBody');
  if (expenseBody) expenseBody.innerHTML = rows;
  if (dashExpenseBody) dashExpenseBody.innerHTML = rows;

  var cashFlowBody = document.getElementById('cashFlowTableBody');
  if (cashFlowBody) {
    cashFlowBody.innerHTML = AppState.derived.cashFlow.length
      ? AppState.derived.cashFlow.map(function(item) {
          return '<tr><td>' + escapeHtml(formatDate(item.date)) + '</td><td>' + escapeHtml(item.type === 'income' ? 'Receita' : 'Despesa') + '</td><td>' + escapeHtml(item.category) + '</td><td>' + escapeHtml(formatCurrencyBr(item.amount)) + '</td><td>' + escapeHtml(formatCurrencyBr(item.balance)) + '</td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="table-empty">Nenhum lançamento financeiro encontrado.</td></tr>';
  }
}

function renderInsightsDerived() {
  var container = document.getElementById('insightSummaryList');
  if (!container) return;
  var insights = AppState.derived.insights;
  if (!insights.length) {
    container.innerHTML = '<div class="insight-summary-card"><div class="insight-summary-icon">🧠</div><div class="insight-summary-info"><div class="insight-summary-title">Sem insights automáticos</div><div class="insight-summary-desc">Adicione dados de clientes, estoque e financeiro para gerar recomendações.</div></div></div>';
    return;
  }
  container.innerHTML = insights.map(function(text) {
    var icon = '📊';
    if (String(text).toLowerCase().indexOf('estoque') >= 0) icon = '📦';
    if (String(text).toLowerCase().indexOf('cliente') >= 0) icon = '👤';
    if (String(text).toLowerCase().indexOf('despesa') >= 0) icon = '💸';
    if (String(text).toLowerCase().indexOf('solo') >= 0 || String(text).toLowerCase().indexOf('umidade') >= 0) icon = '🌱';
    return '<div class="insight-summary-card"><div class="insight-summary-icon">' + icon + '</div><div class="insight-summary-info"><div class="insight-summary-title">' + escapeHtml(text) + '</div><div class="insight-summary-desc">Gerado automaticamente a partir dos módulos conectados.</div></div></div>';
  }).join('');
  animateCards('insightSummaryList', '.insight-summary-card');
}

function renderAlertsDerived() {
  var container = document.getElementById('alertList');
  var badge = document.getElementById('navBadgeAlertas');
  if (!container) return;

  var alerts = [];
  AppState.derived.lowStock.forEach(function(product) {
    alerts.push({
      severity: 'critical',
      icon: '📦',
      title: 'Estoque crítico: ' + product.name,
      desc: 'Atual: ' + product.stockCurrent + ' ' + product.unit + ' · mínimo: ' + product.stockMin + ' ' + product.unit,
      meta: 'Automação de estoque'
    });
  });
  AppState.derived.clients.filter(function(client) { return !client.lastContact; }).slice(0, 4).forEach(function(client) {
    alerts.push({
      severity: 'warning',
      icon: '👤',
      title: 'Cliente sem contato: ' + client.name,
      desc: 'Registre a última interação e defina a próxima ação do CRM.',
      meta: getClientStageLabel(client.status)
    });
  });
  if (AppState.derived.kpis.totalRevenue > 0 && AppState.derived.kpis.totalExpenses > AppState.derived.kpis.totalRevenue * 0.8) {
    alerts.push({
      severity: 'warning',
      icon: '💸',
      title: 'Despesas muito altas',
      desc: 'O total de despesas ultrapassou 80% da receita lançada.',
      meta: 'Financeiro'
    });
  }
  analyzeSoil(AppState.derived.soilSummary).forEach(function(message) {
    alerts.push({
      severity: 'info',
      icon: '🌱',
      title: 'Solo & Clima',
      desc: message,
      meta: 'Diagnóstico automático'
    });
  });

  if (!alerts.length) {
    container.innerHTML = '<div class="alert-item info"><div class="alert-icon">✅</div><div class="alert-content"><div class="alert-title">Nenhum alerta ativo</div><div class="alert-desc">Tudo dentro do esperado para os dados disponíveis.</div><div class="alert-meta">Automação</div></div></div>';
    if (badge) {
      badge.textContent = '0';
      badge.style.display = 'none';
    }
    return;
  }

  container.innerHTML = alerts.map(function(item) {
    return '<div class="alert-item ' + item.severity + '"><div class="alert-icon">' + item.icon + '</div><div class="alert-content"><div class="alert-title">' + escapeHtml(item.title) + '</div><div class="alert-desc">' + escapeHtml(item.desc) + '</div><div class="alert-meta">' + escapeHtml(item.meta) + '</div></div></div>';
  }).join('');
  animateCards('alertList', '.alert-item');
  if (badge) {
    badge.textContent = String(alerts.length);
    badge.style.display = '';
  }
}

function renderSoilDerived() {
  var soilCards = AppState.soilRecords.map(function(record) {
    var numericValue = toNumber(record.value);
    var barWidth = record.barWidth || Math.max(0, Math.min(100, numericValue));
    return {
      param: record.param,
      value: record.value,
      unit: record.unit,
      barWidth: barWidth,
      barColor: record.barColor || (barWidth < 30 ? 'danger' : barWidth < 55 ? 'warning' : ''),
      statusClass: record.statusClass || (barWidth < 30 ? 'danger' : barWidth < 55 ? 'warning' : 'ok'),
      statusText: record.statusText || (barWidth < 30 ? 'Crítico' : barWidth < 55 ? 'Atenção' : 'Estável')
    };
  });
  var soilHtml = soilCards.length
    ? soilCards.map(function(card) {
        return '<div class="soil-card"><div class="soil-param">' + escapeHtml(card.param) + '</div><div class="soil-value">' + escapeHtml(card.value) + ' <span class="soil-unit">' + escapeHtml(card.unit || '') + '</span></div><div class="soil-bar-wrap"><div class="soil-bar ' + escapeHtml(card.barColor) + '" style="width:' + card.barWidth + '%"></div></div><div class="soil-status ' + escapeHtml(card.statusClass) + '">' + escapeHtml(card.statusText) + '</div></div>';
      }).join('')
    : '<div class="history-empty"><div class="history-empty-icon">🌱</div>Sem dados de solo cadastrados.</div>';
  var soilGrid = document.getElementById('soilGridList');
  var dashSoilGrid = document.getElementById('dashSoilGrid');
  if (soilGrid) soilGrid.innerHTML = soilHtml;
  if (dashSoilGrid) dashSoilGrid.innerHTML = soilHtml;

  var soilAlerts = analyzeSoil(AppState.derived.soilSummary);
  renderKpiCards('soilKpiList', [
    { label: 'pH', value: AppState.derived.soilSummary.ph ? String(AppState.derived.soilSummary.ph).replace('.', ',') : '--', change: 'Monitoramento químico', color: 'green', icon: '🧪' },
    { label: 'Umidade', value: AppState.derived.soilSummary.moisture ? formatPercent(AppState.derived.soilSummary.moisture, 0) : '--', change: 'Leitura atual do solo', color: 'gold', icon: '💧' },
    { label: 'Alertas', value: String(soilAlerts.length), change: soilAlerts.length ? 'Ação recomendada' : 'Dentro do esperado', color: soilAlerts.length ? 'amber' : 'soil', icon: '🌤️' }
  ]);
  renderKpiCards('dashSoilKpis', [
    { label: 'pH', value: AppState.derived.soilSummary.ph ? String(AppState.derived.soilSummary.ph).replace('.', ',') : '--', change: 'Monitoramento químico', color: 'green', icon: '🧪' },
    { label: 'Umidade', value: AppState.derived.soilSummary.moisture ? formatPercent(AppState.derived.soilSummary.moisture, 0) : '--', change: 'Leitura atual do solo', color: 'gold', icon: '💧' },
    { label: 'Alertas', value: String(soilAlerts.length), change: soilAlerts.length ? 'Ação recomendada' : 'Dentro do esperado', color: soilAlerts.length ? 'amber' : 'soil', icon: '🌤️' }
  ]);

  var analysis = document.getElementById('soilAnalysisList');
  if (analysis) {
    analysis.innerHTML = soilAlerts.length
      ? soilAlerts.map(function(message) {
          return '<div class="alert-item warning"><div class="alert-icon">🌱</div><div class="alert-content"><div class="alert-title">Recomendação</div><div class="alert-desc">' + escapeHtml(message) + '</div><div class="alert-meta">Análise automática</div></div></div>';
        }).join('')
      : '<div class="alert-item info"><div class="alert-icon">✅</div><div class="alert-content"><div class="alert-title">Solo em faixa estável</div><div class="alert-desc">Nenhum alerta relevante nos parâmetros monitorados.</div><div class="alert-meta">Análise automática</div></div></div>';
  }
}

function updateProdutoSelects(list) {
  var selects = ['sEntProduto', 'sSaiProduto', 'sDevProduto'];
  selects.forEach(function(id) {
    var select = document.getElementById(id);
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">Selecione</option>';
    list.forEach(function(product) {
      var option = document.createElement('option');
      option.value = product.id;
      option.textContent = (product.emoji || '📦') + ' ' + product.name;
      select.appendChild(option);
    });
    if (current) select.value = current;
  });
}

function updateClientSelects(list) {
  var select = document.getElementById('txClientId');
  if (!select) return;
  var current = select.value;
  select.innerHTML = '<option value="">Sem cliente</option>';
  list.forEach(function(client) {
    var option = document.createElement('option');
    option.value = client.id;
    option.textContent = client.name;
    select.appendChild(option);
  });
  if (current) select.value = current;
}

function renderStockHistory() {
  var list = document.getElementById('stockHistoryList');
  var count = document.getElementById('stockCount');
  if (!list) return;
  var entries = (AppState.filters.startDate || AppState.filters.endDate)
    ? filterByDate(AppState.stockEntries, AppState.filters.startDate, AppState.filters.endDate)
    : AppState.stockEntries;
  if (count) count.textContent = entries.length + ' registros';
  if (!entries.length) {
    list.innerHTML = '<div class="history-empty"><div class="history-empty-icon">📦</div>Sem movimentações.</div>';
    return;
  }
  list.innerHTML = entries.map(function(entry) {
    var labels = { entry: 'Entrada', exit: 'Saída', return: 'Devolução' };
    return '<div class="stock-history-item"><span class="stock-type-badge ' + entry.type + '">' + labels[entry.type] + '</span><div class="stock-item-info"><div class="stock-item-name">' + escapeHtml(entry.productName) + '</div><div class="stock-item-meta">' + escapeHtml(formatDate(entry.date)) + '</div></div><div class="stock-item-qty">' + escapeHtml(String(entry.quantity)) + ' ' + escapeHtml(entry.unit) + '</div></div>';
  }).join('');
}

function renderProdutos(list) {
  _produtos = list;
  var container = document.getElementById('produtosList');
  var countEl = document.getElementById('produtosCount');
  if (!container) return;
  if (countEl) countEl.textContent = list.length + ' produto' + (list.length !== 1 ? 's' : '') + ' cadastrado' + (list.length !== 1 ? 's' : '');
  if (!list.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.82rem;padding:16px 0;">Nenhum produto cadastrado. Use o formulário acima.</div>';
    return;
  }
  container.innerHTML = list.map(function(product) {
    var lowStockText = product.stockCurrent <= product.stockMin ? 'Abaixo do mínimo' : 'Estoque estável';
    return '<div class="product-card"><div class="product-emoji">' + escapeHtml(product.emoji || '📦') + '</div><div class="product-name">' + escapeHtml(product.name) + '</div>' +
      (product.sku ? '<div class="product-sku">' + escapeHtml(product.sku) + '</div>' : '') +
      '<div class="product-unit">' + escapeHtml(product.unit || '') + ' · ' + escapeHtml(product.category || 'Sem categoria') + '</div>' +
      '<div class="product-metrics"><span>Atual: ' + escapeHtml(String(product.stockCurrent)) + ' ' + escapeHtml(product.unit || '') + '</span><span>Mínimo: ' + escapeHtml(String(product.stockMin)) + ' ' + escapeHtml(product.unit || '') + '</span><span>Custo médio: ' + escapeHtml(formatCurrencyBr(product.avgCost || product.costPrice)) + '</span><span>' + escapeHtml(lowStockText) + '</span></div>' +
      '<div class="product-actions"><button class="product-del-btn" type="button" data-product-id="' + escapeHtml(product.id) + '">🗑 Remover</button></div></div>';
  }).join('');
}

function clearClienteForm() {
  ['cNome', 'cPropriedade', 'cCidade', 'cTelefone', 'cNextAction', 'cProbability', 'cEstimatedValue', 'cTotalRevenue', 'cObs', 'cLastContact'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var crop = document.getElementById('cCultura');
  if (crop) crop.value = '';
  var status = document.getElementById('cStatus');
  if (status) status.value = 'lead';
  var payment = document.getElementById('cPgto');
  if (payment) payment.value = '';
}

function renderClientes(list, isFiltered) {
  var container = document.getElementById('clientesList');
  var countEl = document.getElementById('clienteTotalCount');
  var badge = document.getElementById('navBadgeClientes');
  if (!container) return;
  var total = AppState.derived.clients.length;
  if (countEl) {
    countEl.textContent = isFiltered && list.length !== total
      ? list.length + ' de ' + total + ' clientes'
      : total + ' cliente' + (total !== 1 ? 's' : '');
  }
  if (badge) badge.textContent = String(total);

  if (!list.length) {
    container.innerHTML = '<div class="clients-empty"><div class="clients-empty-icon">👥</div><div>Nenhum cliente encontrado.</div></div>';
    return;
  }

  container.innerHTML = list.map(function(client) {
    var initials = (client.name || 'CL').split(' ').slice(0, 2).map(function(word) { return word.charAt(0); }).join('').toUpperCase();
    var score = getClientValueScore(client);
    var timeline = Array.isArray(client.timeline) ? client.timeline.slice().reverse() : [];
    var timelineHtml = timeline.length
      ? timeline.map(function(item) {
          var dotClass = item.type === 'edit' ? 'edit' : item.type === 'close' ? 'close' : 'new';
          return '<div class="tl-item"><div class="tl-dot ' + dotClass + '"></div><div class="tl-time">' + escapeHtml(formatDateTime(item.date)) + '</div><div class="tl-text">' + escapeHtml(item.text) + '</div></div>';
        }).join('')
      : '<div style="color:var(--text-muted);font-size:0.82rem;">Nenhuma interação registrada ainda.</div>';
    return '<div class="client-card" id="ccard-' + client.id + '">' +
      '<div class="client-card-head" role="button" tabindex="0" aria-expanded="false" data-client-toggle="' + escapeHtml(client.id) + '">' +
      '<div class="client-name-row"><div class="client-avatar">' + escapeHtml(initials) + '</div><div><div class="client-name">' + escapeHtml(client.name) + '</div><div class="client-meta-row">' +
      (client.property ? '<span>🏡 ' + escapeHtml(client.property) + '</span>' : '') +
      (client.city ? '<span>📍 ' + escapeHtml(client.city) + '</span>' : '') +
      (client.lastContact ? '<span>📅 Último contato: ' + escapeHtml(formatDate(client.lastContact)) + '</span>' : '<span>📅 Sem contato</span>') +
      '<span>💰 ' + escapeHtml(formatCurrencyBr(client.totalRevenue)) + '</span>' +
      '</div><div class="client-pipeline-strip"><span class="client-pipeline-chip">Prob.: ' + escapeHtml(formatPercent(client.probability, 0)) + '</span><span class="client-pipeline-chip">Próxima ação: ' + escapeHtml(client.nextAction || 'Não definida') + '</span></div></div></div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;"><span class="client-score-badge">Score ' + escapeHtml(formatCompactCurrency(score)) + '</span><span class="client-status-badge ' + escapeHtml(client.status) + '">' + escapeHtml(getClientStageLabel(client.status)) + '</span><button class="client-expand-btn" type="button">▶</button></div>' +
      '</div><div class="client-timeline-wrap"><div class="client-timeline"><div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;"><button class="btn btn-gold btn-sm" type="button" data-client-edit="' + escapeHtml(client.id) + '">✏️ Editar</button></div>' +
      '<div class="client-timeline-form"><input class="option-input" id="editNote-' + client.id + '" placeholder="Registrar interação ou observação..."><select class="option-select" id="editStatus-' + client.id + '">' +
      pipelineStages.map(function(stage) { return '<option value="' + stage + '"' + (client.status === stage ? ' selected' : '') + '>' + getClientStageLabel(stage) + '</option>'; }).join('') +
      '</select><input class="option-input" id="editNextAction-' + client.id + '" placeholder="Próxima ação" value="' + escapeHtml(client.nextAction || '') + '"><button class="btn btn-primary btn-sm" type="button" data-client-note="' + escapeHtml(client.id) + '">Salvar</button></div>' +
      '<div class="timeline">' + timelineHtml + '</div></div></div></div>';
  }).join('');
  animateCards('clientesList', '.client-card');
}

function filterClients() {
  var statusFilter = document.getElementById('filtroStatusCliente').value;
  var textFilter = (document.getElementById('buscaCliente').value || '').toLowerCase().trim();
  var filtered = AppState.derived.clients.filter(function(client) {
    var matchesStatus = !statusFilter || client.status === statusFilter;
    var haystack = [client.name, client.property, client.city, client.crop, client.nextAction].join(' ').toLowerCase();
    return matchesStatus && (!textFilter || haystack.indexOf(textFilter) >= 0);
  });
  renderClientes(filtered, true);
}

function saveCliente(btn) {
  var name = document.getElementById('cNome').value.trim();
  if (!name) {
    flashBtn(btn, 'Informe o nome');
    return;
  }
  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }

  var editId = document.getElementById('clienteEditId').value;
  var existing = editId ? getClientById(editId) : null;
  var clientPayload = createClient({
    id: editId || undefined,
    name: name,
    status: document.getElementById('cStatus').value,
    estimatedValue: parseCurrencyInput(document.getElementById('cEstimatedValue').value),
    probability: document.getElementById('cProbability').value,
    lastContact: document.getElementById('cLastContact').value ? new Date(document.getElementById('cLastContact').value + 'T12:00:00').toISOString() : null,
    nextAction: document.getElementById('cNextAction').value.trim(),
    totalRevenue: parseCurrencyInput(document.getElementById('cTotalRevenue').value),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    property: document.getElementById('cPropriedade').value.trim(),
    city: document.getElementById('cCidade').value.trim(),
    phone: document.getElementById('cTelefone').value.trim(),
    crop: document.getElementById('cCultura').value,
    paymentMethod: document.getElementById('cPgto').value,
    notes: document.getElementById('cObs').value.trim()
  });

  btn.textContent = 'Salvando...';
  if (editId) {
    window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/' + editId + '/timeline'), createClientTimeline(
      'Cadastro atualizado. Estágio ' + getClientStageLabel(clientPayload.status) + (clientPayload.nextAction ? ' · Próxima ação: ' + clientPayload.nextAction : ''),
      'edit',
      { author: 'Usuário' }
    )).then(function() {
      return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'clientes', editId), clientPayload, { merge: true });
    }).then(function() {
      cancelClienteEdit();
      btn.textContent = '✓ Atualizado!';
      btn.style.background = 'var(--green-bright)';
      btn.style.color = 'var(--green-deep)';
      setTimeout(function() {
        btn.textContent = 'Cadastrar Cliente';
        btn.style.background = '';
        btn.style.color = '';
      }, 1800);
    }).catch(function(error) {
      console.error(error);
      flashBtn(btn, 'Erro ao salvar');
    });
    return;
  }

  window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes'), clientPayload).then(function(docRef) {
    return window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/' + docRef.id + '/timeline'), createClientTimeline(
      'Cliente cadastrado. Estágio ' + getClientStageLabel(clientPayload.status) + (clientPayload.nextAction ? ' · Próxima ação: ' + clientPayload.nextAction : ''),
      'new',
      { author: 'Usuário' }
    ));
  }).then(function() {
    clearClienteForm();
    btn.textContent = '✓ Cadastrado!';
    btn.style.background = 'var(--green-bright)';
    btn.style.color = 'var(--green-deep)';
    setTimeout(function() {
      btn.textContent = 'Cadastrar Cliente';
      btn.style.background = '';
      btn.style.color = '';
    }, 1800);
  }).catch(function(error) {
    console.error(error);
    flashBtn(btn, 'Erro ao salvar');
  });
}

function saveClienteNote(clienteId, btn) {
  var note = document.getElementById('editNote-' + clienteId).value.trim();
  var status = document.getElementById('editStatus-' + clienteId).value;
  var nextAction = document.getElementById('editNextAction-' + clienteId).value.trim();
  if (!note && !status && !nextAction) {
    flashBtn(btn, 'Atualize algo');
    return;
  }
  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }

  btn.textContent = '...';
  var messageParts = [];
  if (note) messageParts.push(note);
  if (status) messageParts.push('Estágio: ' + getClientStageLabel(status));
  if (nextAction) messageParts.push('Próxima ação: ' + nextAction);
  window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/' + clienteId + '/timeline'), createClientTimeline(messageParts.join(' · '), 'edit', { author: 'Usuário' })).then(function() {
    return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'clientes', clienteId), {
      status: status,
      nextAction: nextAction,
      lastContact: new Date().toISOString()
    }, { merge: true });
  }).then(function() {
    document.getElementById('editNote-' + clienteId).value = '';
    btn.textContent = '✓';
    setTimeout(function() { btn.textContent = 'Salvar'; }, 1200);
  }).catch(function(error) {
    console.error(error);
    btn.textContent = 'Salvar';
  });
}

function startEditCliente(id) {
  var client = getClientById(id);
  if (!client) return;
  document.getElementById('clienteEditId').value = id;
  document.getElementById('cNome').value = client.name || '';
  document.getElementById('cPropriedade').value = client.property || '';
  document.getElementById('cCultura').value = client.crop || '';
  document.getElementById('cCidade').value = client.city || '';
  document.getElementById('cTelefone').value = client.phone || '';
  document.getElementById('cStatus').value = client.status || 'lead';
  document.getElementById('cPgto').value = client.paymentMethod || '';
  document.getElementById('cObs').value = client.notes || '';
  document.getElementById('cNextAction').value = client.nextAction || '';
  document.getElementById('cProbability').value = client.probability || '';
  document.getElementById('cEstimatedValue').value = client.estimatedValue ? formatCurrencyBr(client.estimatedValue) : '';
  document.getElementById('cTotalRevenue').value = client.totalRevenue ? formatCurrencyBr(client.totalRevenue) : '';
  document.getElementById('cLastContact').value = toInputDate(client.lastContact);
  document.getElementById('clienteFormTitle').textContent = '✏️ Editando: ' + (client.name || '');
  document.getElementById('clienteSaveBtn').textContent = 'Salvar Alterações';
  document.getElementById('clienteCancelBtn').style.display = '';
  document.querySelectorAll('.client-card').forEach(function(cardEl) { cardEl.classList.remove('editing'); });
  var card = document.getElementById('ccard-' + id);
  if (card) {
    card.classList.add('editing');
    card.classList.add('expanded');
    var toggle = card.querySelector('[data-client-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
  }
  document.getElementById('clienteFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelClienteEdit() {
  document.getElementById('clienteEditId').value = '';
  document.getElementById('clienteFormTitle').textContent = '➕ Novo Cliente';
  document.getElementById('clienteSaveBtn').textContent = 'Cadastrar Cliente';
  document.getElementById('clienteCancelBtn').style.display = 'none';
  document.querySelectorAll('.client-card').forEach(function(cardEl) {
    cardEl.classList.remove('editing');
    var toggle = cardEl.querySelector('[data-client-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', cardEl.classList.contains('expanded') ? 'true' : 'false');
  });
  clearClienteForm();
}

function saveProduto(btn) {
  var name = document.getElementById('pNome').value.trim();
  if (!name) {
    flashBtn(btn, 'Informe o nome');
    return;
  }
  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }
  var payload = createProduct({
    name: name,
    sku: document.getElementById('pSku').value.trim(),
    unit: document.getElementById('pUnidade').value,
    costPrice: parseCurrencyInput(document.getElementById('pCostPrice').value),
    avgCost: 0,
    stockCurrent: 0,
    stockMin: document.getElementById('pStockMin').value,
    category: document.getElementById('pCategoria').value,
    emoji: document.getElementById('pEmoji').value.trim() || '📦',
    createdAt: new Date().toISOString()
  });
  btn.textContent = 'Salvando...';
  window.fbAddDoc(window.fbCollection(window.firebaseDB, 'produtos'), payload).then(function() {
    ['pNome', 'pSku', 'pCostPrice', 'pStockMin', 'pEmoji'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    btn.textContent = '✓ Cadastrado!';
    btn.style.background = 'var(--green-bright)';
    btn.style.color = 'var(--green-deep)';
    setTimeout(function() {
      btn.textContent = 'Cadastrar Produto';
      btn.style.background = '';
      btn.style.color = '';
    }, 1800);
  }).catch(function(error) {
    console.error(error);
    flashBtn(btn, 'Erro ao salvar');
  });
}

function saveStock(type, btn) {
  var prefixes = { entrada: 'sEnt', saida: 'sSai', devolucao: 'sDev' };
  var prefix = prefixes[type];
  var productSelect = document.getElementById(prefix + 'Produto');
  var quantityInput = document.getElementById(prefix + 'Qtd');
  if (!productSelect || !productSelect.value) {
    flashBtn(btn, 'Selecione o produto');
    return;
  }
  if (!quantityInput || !validateNumber(quantityInput.value)) {
    flashBtn(btn, 'Informe a quantidade');
    return;
  }
  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }

  var product = AppState.products.find(function(item) { return item.id === productSelect.value; });
  if (!product) {
    flashBtn(btn, 'Produto inválido');
    return;
  }

  var movement = normalizeStockMovement({
    type: type,
    productId: product.id,
    productName: product.name,
    quantity: quantityInput.value,
    unit: (document.getElementById(prefix + 'Unidade') || {}).value || product.unit,
    date: document.getElementById(prefix + 'Data') && document.getElementById(prefix + 'Data').value
      ? new Date(document.getElementById(prefix + 'Data').value + 'T12:00:00').toISOString()
      : new Date().toISOString(),
    cost: prefix === 'sEnt' ? (parseCurrencyInput((document.getElementById('sEntValor') || {}).value || '') || product.costPrice) : 0,
    clientId: type === 'saida'
      ? ((getClientByName((document.getElementById('sSaiDestino') || {}).value || '') || {}).id || null)
      : type === 'devolucao'
        ? ((getClientByName((document.getElementById('sDevCliente') || {}).value || '') || {}).id || null)
        : null,
    destination: (document.getElementById('sSaiDestino') || {}).value || '',
    reason: (document.getElementById('sDevMotivo') || {}).value || '',
    lot: (document.getElementById('sEntLote') || {}).value || '',
    observation: (document.getElementById(prefix + 'Obs') || {}).value || '',
    createdAt: new Date().toISOString()
  });

  btn.textContent = 'Salvando...';
  window.fbAddDoc(window.fbCollection(window.firebaseDB, 'stock'), movement).then(function() {
    [prefix + 'Produto', prefix + 'Qtd', prefix + 'Data', prefix + 'Obs', prefix + 'Lote', prefix + 'Valor', prefix + 'Destino', prefix + 'Cliente', prefix + 'Motivo'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.tagName === 'SELECT') el.selectedIndex = 0;
      else el.value = '';
    });
    btn.textContent = '✓ Registrado!';
    btn.style.background = 'var(--green-bright)';
    btn.style.color = 'var(--green-deep)';
    setTimeout(function() {
      btn.textContent = btn.dataset.originalText || 'Registrar';
      btn.style.background = '';
      btn.style.color = '';
    }, 1800);
  }).catch(function(error) {
    console.error(error);
    flashBtn(btn, 'Erro ao salvar');
  });
}

function saveTransaction(btn) {
  var type = document.getElementById('txType').value;
  var category = document.getElementById('txCategory').value.trim();
  var amount = parseCurrencyInput(document.getElementById('txAmount').value);
  if (!category || !validateNumber(amount)) {
    flashBtn(btn, 'Preencha categoria e valor');
    return;
  }
  if (!window.firebaseDB) {
    flashBtn(btn, 'Firebase não conectado');
    return;
  }

  var payload = createTransaction({
    type: type,
    category: category,
    amount: amount,
    date: document.getElementById('txDate').value ? new Date(document.getElementById('txDate').value + 'T12:00:00').toISOString() : new Date().toISOString(),
    clientId: document.getElementById('txClientId').value || null,
    description: document.getElementById('txDescription').value.trim(),
    createdAt: new Date().toISOString()
  });

  btn.textContent = 'Salvando...';
  window.fbAddDoc(window.fbCollection(window.firebaseDB, 'finance'), payload).then(function() {
    ['txCategory', 'txAmount', 'txDate', 'txDescription'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('txType').value = 'income';
    document.getElementById('txClientId').value = '';
    btn.textContent = '✓ Lançado!';
    btn.style.background = 'var(--green-bright)';
    btn.style.color = 'var(--green-deep)';
    setTimeout(function() {
      btn.textContent = 'Salvar Lançamento';
      btn.style.background = '';
      btn.style.color = '';
    }, 1800);
  }).catch(function(error) {
    console.error(error);
    flashBtn(btn, 'Erro ao salvar');
  });
}

function renderDerivedViews() {
  deriveDomainData();
  renderDashboardDerived();
  renderFinanceDerived();
  renderInsightsDerived();
  renderAlertsDerived();
  renderSoilDerived();
  renderStockHistory();
  renderProdutos(AppState.derived.products);
  updateProdutoSelects(AppState.products);
  updateClientSelects(AppState.clients);
  filterClients();
}

function syncFinanceTransactions() {
  AppState.financeTransactions = AppState.financeSources.modern.concat(AppState.financeSources.legacy).sort(function(a, b) {
    return new Date(b.date) - new Date(a.date);
  });
  renderDerivedViews();
}

function initRealtimeData(fbConnectTimeout) {
  clearTimeout(fbConnectTimeout);
  var dot = document.getElementById('fbStatusDot');
  if (dot) {
    dot.classList.remove('error');
    dot.classList.add('connected');
    dot.title = 'Firebase conectado e sincronizando';
  }

  window.seedFirebase = function() {
    try {
      if (localStorage.getItem('agroinsight-seeded') && !confirm('Os dados de demonstração já foram carregados. Deseja sobrescrever?')) return;
    } catch (e) {}

    var seedClients = [
      createClient({ id: 'seed-client-1', name: 'Fazenda Horizonte', status: 'proposal', estimatedValue: 120000, probability: 70, lastContact: new Date().toISOString(), nextAction: 'Enviar proposta comercial', totalRevenue: 32000, createdAt: new Date().toISOString(), property: 'Horizonte', city: 'Rio Verde / GO', phone: '64999990001', crop: 'Soja', paymentMethod: 'Safra' }),
      createClient({ id: 'seed-client-2', name: 'Grupo Santa Luz', status: 'closed', estimatedValue: 240000, probability: 100, lastContact: new Date().toISOString(), nextAction: 'Planejar recompra', totalRevenue: 185000, createdAt: new Date().toISOString(), property: 'Santa Luz', city: 'Jataí / GO', phone: '64999990002', crop: 'Milho', paymentMethod: 'Barter' }),
      createClient({ id: 'seed-client-3', name: 'Sítio Boa Safra', status: 'lead', estimatedValue: 45000, probability: 35, lastContact: null, nextAction: 'Agendar visita técnica', totalRevenue: 0, createdAt: new Date().toISOString(), property: 'Boa Safra', city: 'Mineiros / GO', phone: '64999990003', crop: 'Misto', paymentMethod: 'À Vista' })
    ];
    var seedProducts = [
      createProduct({ id: 'seed-product-1', name: 'Biopirol 400 SC', sku: 'BIO-400', unit: 'L', costPrice: 82, stockMin: 60, category: 'Biológico', emoji: '🧪', createdAt: new Date().toISOString() }),
      createProduct({ id: 'seed-product-2', name: 'Bio+Complex', sku: 'BIO-CX', unit: 'kg', costPrice: 56, stockMin: 40, category: 'Fertilizante', emoji: '🌿', createdAt: new Date().toISOString() })
    ];
    var seedFinance = [
      createTransaction({ id: 'seed-fin-1', type: 'income', category: 'Venda', amount: 92000, date: new Date().toISOString(), clientId: 'seed-client-2', description: 'Venda fechada' }),
      createTransaction({ id: 'seed-fin-2', type: 'income', category: 'Venda', amount: 48000, date: new Date().toISOString(), clientId: 'seed-client-1', description: 'Pedido em andamento' }),
      createTransaction({ id: 'seed-fin-3', type: 'expense', category: 'Combustível', amount: 22000, date: new Date().toISOString(), description: 'Abastecimento frota' }),
      createTransaction({ id: 'seed-fin-4', type: 'expense', category: 'Insumos', amount: 41000, date: new Date().toISOString(), description: 'Compra de biológicos' })
    ];
    var seedStock = [
      normalizeStockMovement({ id: 'seed-stock-1', type: 'entry', productId: 'seed-product-1', productName: 'Biopirol 400 SC', quantity: 120, unit: 'L', cost: 82, date: new Date().toISOString() }),
      normalizeStockMovement({ id: 'seed-stock-2', type: 'exit', productId: 'seed-product-1', productName: 'Biopirol 400 SC', quantity: 75, unit: 'L', date: new Date().toISOString() }),
      normalizeStockMovement({ id: 'seed-stock-3', type: 'entry', productId: 'seed-product-2', productName: 'Bio+Complex', quantity: 90, unit: 'kg', cost: 56, date: new Date().toISOString() })
    ];
    var soil = [
      normalizeSoilRecord({ id: 'seed-soil-1', param: 'pH em CaCl2', value: '5,2', unit: '', barWidth: 38, statusClass: 'warning', statusText: 'Atenção', ph: 5.2 }),
      normalizeSoilRecord({ id: 'seed-soil-2', param: 'Umidade do Solo', value: '28', unit: '%', barWidth: 28, statusClass: 'danger', statusText: 'Baixa', moisture: 28 }),
      normalizeSoilRecord({ id: 'seed-soil-3', param: 'Temperatura', value: '24', unit: '°C', barWidth: 62, statusClass: 'ok', statusText: 'Estável', temperature: 24 })
    ];
    var mercado = [
      { id: 'seed-market-1', name: '🌱 Soja — SC 60kg', price: 'R$ 142,80', unit: 'por saca · B3', change: '▲ +2,4% no mês', changeClass: 'up' },
      { id: 'seed-market-2', name: '🌽 Milho — SC 60kg', price: 'R$ 58,40', unit: 'por saca · B3', change: '▼ -1,1% no mês', changeClass: 'down' }
    ];
    var swot = [
      { id: 'seed-swot-1', type: 'strength', title: '💪 Forças', items: ['Equipe enxuta com boa execução', 'Base comercial em expansão', 'Mix de produtos consolidado'] },
      { id: 'seed-swot-2', type: 'weakness', title: '⚠️ Fraquezas', items: ['Dependência de poucos leads quentes', 'Estoque desbalanceado em alguns itens'] },
      { id: 'seed-swot-3', type: 'opportunity', title: '🌟 Oportunidades', items: ['Alta sazonal de vendas na próxima janela', 'Espaço para upsell por cliente'] },
      { id: 'seed-swot-4', type: 'threat', title: '🌩️ Ameaças', items: ['Pressão de margem com insumos', 'Clientes sem follow-up recente'] }
    ];
    var actionPlan = [
      { id: 'seed-action-1', status: 'pending', statusTitle: 'Pendente', title: 'Repor Biopirol', meta: 'Cotação e compra ainda nesta semana.' },
      { id: 'seed-action-2', status: 'done', statusTitle: 'Concluído', title: 'Atualizar carteira de clientes fechados', meta: 'Base sincronizada hoje.' }
    ];

    Promise.all(
      seedClients.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'clientes', item.id), item, { merge: true }); })
        .concat(seedProducts.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'produtos', item.id), item, { merge: true }); }))
        .concat(seedFinance.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'finance', item.id), item, { merge: true }); }))
        .concat(seedStock.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'stock', item.id), item, { merge: true }); }))
        .concat(soil.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'soil', item.id), item, { merge: true }); }))
        .concat(mercado.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'mercado', item.id), item, { merge: true }); }))
        .concat(swot.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'swot', item.id), item, { merge: true }); }))
        .concat(actionPlan.map(function(item) { return window.fbSetDoc(window.fbDoc(window.firebaseDB, 'actionplan', item.id), item, { merge: true }); }))
        .concat([
          window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/seed-client-1/timeline'), createClientTimeline('Proposta em preparação.', 'edit', { author: 'Sistema' })),
          window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/seed-client-2/timeline'), createClientTimeline('Cliente convertido.', 'close', { author: 'Sistema' })),
          window.fbAddDoc(window.fbCollection(window.firebaseDB, 'clientes/seed-client-3/timeline'), createClientTimeline('Lead aguardando primeiro contato.', 'new', { author: 'Sistema' }))
        ])
    ).then(function() {
      try { localStorage.setItem('agroinsight-seeded', '1'); } catch (e) {}
      showToast('Dados de demonstração carregados com sucesso!', 'success');
    }).catch(function(error) {
      console.error(error);
      showToast('Erro ao popular o Firebase: ' + error.message, 'error');
    });
  };

  window.fbOnSnapshot(window.fbQuery(window.fbCollection(window.firebaseDB, 'clientes'), window.fbOrderBy('createdAt', 'desc')), function(snapshot) {
    AppState.clients = snapshot.docs.map(function(docSnap) { return normalizeClient(Object.assign({ id: docSnap.id }, docSnap.data())); });
    AppState.clients.forEach(function(client) {
      var previous = clientCache[client.id] || {};
      if (previous.timeline) client.timeline = previous.timeline;
      clientCache[client.id] = Object.assign({}, previous, client);
      if (!clientCache[client.id]._bound) {
        clientCache[client.id]._bound = true;
        window.fbOnSnapshot(window.fbQuery(window.fbCollection(window.firebaseDB, 'clientes/' + client.id + '/timeline'), window.fbOrderBy('date', 'asc')), function(tlSnap) {
          clientCache[client.id].timeline = tlSnap.docs.map(function(tlDoc) { return tlDoc.data(); });
          AppState.clients = AppState.clients.map(function(item) {
            return item.id === client.id ? Object.assign({}, item, { timeline: clientCache[client.id].timeline }) : item;
          });
          renderDerivedViews();
        });
      }
    });
    renderDerivedViews();
  });

  window.fbOnSnapshot(window.fbQuery(window.fbCollection(window.firebaseDB, 'produtos'), window.fbOrderBy('createdAt', 'desc')), function(snapshot) {
    AppState.products = snapshot.docs.map(function(docSnap) { return normalizeProduct(Object.assign({ id: docSnap.id }, docSnap.data())); });
    renderDerivedViews();
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'stock'), function(snapshot) {
    AppState.stockEntries = snapshot.docs.map(function(docSnap) { return normalizeStockMovement(Object.assign({ id: docSnap.id }, docSnap.data())); }).sort(function(a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    renderDerivedViews();
  });

  window.fbOnSnapshot(window.fbQuery(window.fbCollection(window.firebaseDB, 'finance'), window.fbOrderBy('date', 'desc')), function(snapshot) {
    AppState.financeSources.modern = snapshot.docs.map(function(docSnap) {
      return normalizeTransaction(Object.assign({ id: docSnap.id }, docSnap.data()), docSnap.data().type || 'expense');
    });
    syncFinanceTransactions();
  });

  window.fbOnSnapshot(window.fbQuery(window.fbCollection(window.firebaseDB, 'registros_gastos'), window.fbOrderBy('createdAt', 'desc')), function(snapshot) {
    AppState.financeSources.legacy = snapshot.docs.map(function(docSnap) {
      return normalizeTransaction(Object.assign({ id: 'legacy-' + docSnap.id }, docSnap.data()), 'expense');
    });
    syncFinanceTransactions();
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'soil'), function(snapshot) {
    AppState.soilRecords = snapshot.docs.map(function(docSnap) { return normalizeSoilRecord(Object.assign({ id: docSnap.id }, docSnap.data())); });
    renderDerivedViews();
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'mercado'), function(snapshot) {
    var html = '';
    snapshot.docs.forEach(function(docSnap) {
      var item = docSnap.data();
      html += '<div class="commodity-card"><div class="commodity-name">' + item.name + '</div><div class="commodity-price">' + item.price + '</div><div class="commodity-unit">' + item.unit + '</div><div class="commodity-change ' + (item.changeClass || '') + '">' + item.change + '</div></div>';
    });
    var marketGrid = document.getElementById('marketGridList');
    if (marketGrid) { marketGrid.innerHTML = html; animateCards('marketGridList', '.commodity-card'); }
    var rankingList = document.getElementById('marketRankingList');
    if (rankingList) {
      var rankHtml = '';
      snapshot.docs.forEach(function(docSnap, index) {
        var item = docSnap.data();
        var width = Math.max(30, 100 - index * 20);
        rankHtml += '<div class="rank-item"><span class="rank-num ' + (index === 0 ? 'top' : '') + '">' + (index + 1) + '</span><div class="rank-info"><div class="rank-name">' + item.name + '</div><div class="rank-bar-wrap"><div class="rank-bar ' + (index === 0 ? 'green' : index === 1 ? 'gold' : 'amber') + '" style="width:' + width + '%"></div></div></div><div class="rank-value">' + item.price + '</div></div>';
      });
      rankingList.innerHTML = rankHtml;
    }
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'swot'), function(snapshot) {
    var html = '';
    snapshot.docs.forEach(function(docSnap) {
      var item = docSnap.data();
      html += '<div class="swot-block ' + item.type + '"><div class="swot-title">' + item.title + '</div><ul class="swot-list">' + (item.items || []).map(function(entry) { return '<li>' + entry + '</li>'; }).join('') + '</ul></div>';
    });
    var swotList = document.getElementById('swotList');
    if (swotList) swotList.innerHTML = html;
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'actionplan'), function(snapshot) {
    var html = '';
    snapshot.docs.forEach(function(docSnap) {
      var item = docSnap.data();
      html += '<div class="action-item"><span class="action-status ' + item.status + '" title="' + item.statusTitle + '"></span><div class="action-info"><div class="action-title">' + item.title + '</div><div class="action-meta">' + item.meta + '</div></div></div>';
    });
    var actionPlanList = document.getElementById('actionPlanList');
    if (actionPlanList) actionPlanList.innerHTML = html;
  });

  window.fbOnSnapshot(window.fbCollection(window.firebaseDB, 'reports'), function(snapshot) {
    AppState.reports = snapshot.docs.map(function(docSnap) {
      var data = docSnap.data();
      return Object.assign({ id: docSnap.id }, data, {
        createdAt: normalizeTimestamp(data.createdAt) || new Date().toISOString()
      });
    }).sort(function(a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    filterReports();
    updateNavBadge();
    updateTopbarTime();
  });
}

function bindUIEvents() {
  if (document.body.dataset.uiBound === '1') return;
  document.body.dataset.uiBound = '1';

  document.addEventListener('click', function(e) {
    var actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      var action = actionEl.dataset.action;
      if (action === 'close-sidebar') closeSidebar();
      else if (action === 'toggle-sidebar') toggleSidebar();
      else if (action === 'toggle-theme') toggleTheme();
      else if (action === 'export-pdf') exportToPDF();
      else if (action === 'top-action') handleTopAction();
      else if (action === 'clear-lab-form') clearLabForm();
      else if (action === 'generate-report') generateReport();
      else if (action === 'cancel-cliente-edit') cancelClienteEdit();
      else if (action === 'save-cliente') saveCliente(actionEl);
      else if (action === 'save-produto') saveProduto(actionEl);
      else if (action === 'save-config') saveConfig();
      else if (action === 'seed-firebase' && window.seedFirebase) window.seedFirebase();
      else if (action === 'reset-seed') resetSeedProtection();
      else if (action === 'close-preview') closePreview();
      else if (action === 'save-transaction') saveTransaction(actionEl);
      else if (action === 'clear-global-filter') clearGlobalFilter();
      return;
    }

    var pageBtn = e.target.closest('.nav-item[data-page]');
    if (pageBtn) { setPage(pageBtn.dataset.page, pageBtn); return; }
    var tabBtn = e.target.closest('.tab-bar .tab[data-tab]');
    if (tabBtn) { setDashTab(tabBtn); return; }
    var regCtxBtn = e.target.closest('.form-switch-btn[data-ctx]');
    if (regCtxBtn) { setRegCtx(regCtxBtn.dataset.ctx, regCtxBtn); return; }
    var stockTabBtn = e.target.closest('.stock-tab-btn[data-stock-target]');
    if (stockTabBtn) { setStockTab(stockTabBtn.dataset.stockTarget, stockTabBtn); return; }
    var moduleBtn = e.target.closest('[data-save-module]');
    if (moduleBtn) { saveModule(moduleBtn.dataset.saveModule, moduleBtn); return; }
    var stockBtn = e.target.closest('[data-save-stock]');
    if (stockBtn) { saveStock(stockBtn.dataset.saveStock, stockBtn); return; }
    var themeChoiceBtn = e.target.closest('[data-theme-choice]');
    if (themeChoiceBtn) { applyTheme(themeChoiceBtn.dataset.themeChoice); return; }
    var reportItem = e.target.closest('[data-report-id]');
    if (reportItem) { openPreview(reportItem.dataset.reportId); return; }
    var clientToggle = e.target.closest('[data-client-toggle]');
    if (clientToggle) { toggleClientCard(clientToggle.dataset.clientToggle); return; }
    var clientEdit = e.target.closest('[data-client-edit]');
    if (clientEdit) { startEditCliente(clientEdit.dataset.clientEdit); return; }
    var clientNote = e.target.closest('[data-client-note]');
    if (clientNote) { saveClienteNote(clientNote.dataset.clientNote, clientNote); return; }
    var productDelete = e.target.closest('.product-del-btn[data-product-id]');
    if (productDelete) deleteProduto(productDelete.dataset.productId, productDelete);
  });

  document.addEventListener('input', function(e) {
    if (e.target.id === 'buscaCliente') filterClients();
    if (e.target.id === 'buscaRelatorio') filterReports();
  });

  document.addEventListener('change', function(e) {
    if (e.target.id === 'filtroStatusCliente') filterClients();
    if (e.target.id === 'globalStartDate' || e.target.id === 'globalEndDate') {
      setGlobalFilter(
        document.getElementById('globalStartDate').value,
        document.getElementById('globalEndDate').value
      );
    }
  });

  document.addEventListener('keydown', function(e) {
    var keyboardTarget = e.target.closest('[data-report-id], [data-client-toggle]');
    if (keyboardTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (keyboardTarget.dataset.reportId) openPreview(keyboardTarget.dataset.reportId);
      if (keyboardTarget.dataset.clientToggle) toggleClientCard(keyboardTarget.dataset.clientToggle);
      return;
    }
    if (e.key !== 'Escape') return;
    closeSidebar();
    closePreview();
  });
}

/* ══════════════════════════════════════════════════
   JS §15  INICIALIZAÇÃO
   ══════════════════════════════════════════════════ */
(function init() {
  bindDependencyFallbacks();
  bindUIEvents();
  initSemanticUI();

  // Após 8 segundos sem evento firebase-ready, marca como erro de conexão
  var fbConnectTimeout = setTimeout(function() {
    var dot = document.getElementById('fbStatusDot');
    if (dot && !dot.classList.contains('connected')) {
      dot.classList.add('error');
      dot.title = 'Não foi possível conectar ao Firebase';
      showToast('Falha ao conectar com o servidor. Verifique sua conexão.', 'error');
    }
  }, 8000);

  setLoadingState([
    'dashKpiList',
    'bridgeKpiList',
    'dashOpKpiList',
    'alertList',
    'marketGridList',
    'marketRankingList',
    'insightSummaryList',
    'swotList',
    'actionPlanList',
    'soilGridList',
    'soilKpiList',
    'soilAnalysisList',
    'financeSummaryList',
    'clientesList',
    'historyList',
    'stockHistoryList',
    'produtosList'
  ]);

  // Inicia listeners do Firebase
  window.addEventListener('firebase-ready', function() {
    initRealtimeData(fbConnectTimeout);
  });

  // Tema
  applyTheme(getPreferredTheme(), false);
  updateTopbarTime();
  updateGlobalFilterSummary();
  setInterval(updateTopbarTime, 60000);
  // Carregar configurações salvas
  try {
    var savedCfg = JSON.parse(localStorage.getItem('agroinsight-config') || 'null');
    if (savedCfg) applyConfigToDOM(savedCfg);
  } catch(e) {}

  syncTopActionButton(AppState.currentPage);

  // Gráficos
  initProdChart();
  initDonutChart();

  // Campos condicionais e helpers
  initConditionalFields();
  initInputHelpers();

  // Inicializa tabs do dashboard
  var defaultTab = document.querySelector('.tab-bar .tab.active');
  if (defaultTab) setDashTab(defaultTab);

  // Fechar overlay ao clicar fora do papel
  var overlay = document.getElementById('previewOverlay');
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePreview();
    });
  }

  // Sincronizar tema do sistema
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var syncSystem = function(evt) {
      if (!getStoredTheme()) applyTheme(evt.matches ? 'dark' : 'light', false);
    };
    if (mq.addEventListener) { mq.addEventListener('change', syncSystem); }
    else if (mq.addListener)  { mq.addListener(syncSystem); }
  }
})();

dispatchFirebaseReady();
