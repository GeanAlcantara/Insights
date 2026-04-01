export const kpis = {
  totalRevenue: 0,
  totalExpenses: 0,
  netProfit: 0,
  averageTicket: 0,
  revenuePerClient: 0,
  inventoryValue: 0,
  stockTurnover: 0,
};

export const client = {
  id: "",
  name: "",
  status: "lead",
  estimatedValue: 0,
  probability: 0,
  lastContact: null,
  nextAction: "",
  totalRevenue: 0,
  createdAt: "",
};

export const product = {
  id: "",
  name: "",
  sku: "",
  unit: "",
  costPrice: 0,
  avgCost: 0,
  stockCurrent: 0,
  stockMin: 0,
};

export const transaction = {
  id: "",
  type: "income",
  category: "",
  amount: 0,
  date: "",
  clientId: null,
};

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function validateNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  const normalized = typeof value === "string"
    ? value.replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "")
    : value;
  return !Number.isNaN(Number(normalized));
}

export function toNumber(value) {
  if (!validateNumber(value)) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return Number(String(value).replace(/\s/g, "").replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "")) || 0;
}

export function clampPercentage(value) {
  const numeric = toNumber(value);
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return numeric;
}

export function normalizeTimestamp(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return null;
}

function getDateValue(item) {
  return item?.date || item?.createdAt || item?.lastContact || null;
}

export function filterByDate(data, start, end) {
  if (!Array.isArray(data)) return [];
  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;

  if (endDate) {
    endDate.setHours(23, 59, 59, 999);
  }

  return data.filter((entry) => {
    const rawDate = getDateValue(entry);
    if (!rawDate) return false;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return false;
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  });
}

export function mapClientStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  const map = {
    lead: "lead",
    prospecto: "lead",
    contato: "contact",
    contact: "contact",
    ativo: "contact",
    proposta: "proposal",
    proposal: "proposal",
    fechado: "closed",
    closed: "closed",
  };
  return map[normalized] || "lead";
}

export function mapStockType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  const map = {
    entrada: "entry",
    entry: "entry",
    saida: "exit",
    saída: "exit",
    exit: "exit",
    devolucao: "return",
    devolução: "return",
    return: "return",
  };
  return map[normalized] || "entry";
}

export function mapFinanceType(type) {
  return String(type || "").trim().toLowerCase() === "income" ? "income" : "expense";
}

export function createClient(overrides = {}) {
  return {
    ...client,
    id: overrides.id || generateId(),
    name: overrides.name || "",
    status: mapClientStatus(overrides.status || client.status),
    estimatedValue: toNumber(overrides.estimatedValue),
    probability: clampPercentage(overrides.probability),
    lastContact: normalizeTimestamp(overrides.lastContact) || null,
    nextAction: overrides.nextAction || "",
    totalRevenue: toNumber(overrides.totalRevenue),
    createdAt: normalizeTimestamp(overrides.createdAt) || new Date().toISOString(),
    property: overrides.property || "",
    city: overrides.city || "",
    phone: overrides.phone || "",
    email: overrides.email || "",
    crop: overrides.crop || "",
    area: toNumber(overrides.area),
    paymentMethod: overrides.paymentMethod || "",
    notes: overrides.notes || "",
    timeline: Array.isArray(overrides.timeline) ? overrides.timeline : [],
  };
}

export function normalizeClient(raw = {}) {
  return createClient({
    id: raw.id,
    name: raw.name || raw.nome,
    status: raw.status,
    estimatedValue: raw.estimatedValue ?? raw.valorEstimado ?? raw.pipelineValue,
    probability: raw.probability ?? raw.probabilidade,
    lastContact: raw.lastContact ?? raw.ultimoContato ?? raw.dataContato,
    nextAction: raw.nextAction ?? raw.proximaAcao,
    totalRevenue: raw.totalRevenue ?? raw.receitaTotal,
    createdAt: raw.createdAt,
    property: raw.property || raw.propriedade,
    city: raw.city || raw.cidade,
    phone: raw.phone || raw.telefone || raw.tel,
    email: raw.email,
    crop: raw.crop || raw.cultura,
    area: raw.area,
    paymentMethod: raw.paymentMethod || raw.pgto,
    notes: raw.notes || raw.obs,
    timeline: raw.timeline,
  });
}

export function createProduct(overrides = {}) {
  return {
    ...product,
    id: overrides.id || generateId(),
    name: overrides.name || "",
    sku: overrides.sku || "",
    unit: overrides.unit || "",
    costPrice: toNumber(overrides.costPrice),
    avgCost: toNumber(overrides.avgCost),
    stockCurrent: toNumber(overrides.stockCurrent),
    stockMin: toNumber(overrides.stockMin),
    createdAt: normalizeTimestamp(overrides.createdAt) || new Date().toISOString(),
    category: overrides.category || "",
    emoji: overrides.emoji || "📦",
  };
}

export function normalizeProduct(raw = {}) {
  return createProduct({
    id: raw.id,
    name: raw.name || raw.nome,
    sku: raw.sku,
    unit: raw.unit || raw.unidade,
    costPrice: raw.costPrice ?? raw.custo ?? raw.valorUnitario,
    avgCost: raw.avgCost,
    stockCurrent: raw.stockCurrent ?? raw.estoqueAtual,
    stockMin: raw.stockMin ?? raw.stockMinimum ?? raw.minimo,
    createdAt: raw.createdAt,
    category: raw.category || raw.categoria,
    emoji: raw.emoji,
  });
}

export function createTransaction(overrides = {}) {
  return {
    ...transaction,
    id: overrides.id || generateId(),
    type: mapFinanceType(overrides.type || transaction.type),
    category: overrides.category || "",
    amount: toNumber(overrides.amount),
    date: normalizeTimestamp(overrides.date) || new Date().toISOString(),
    clientId: overrides.clientId || null,
    description: overrides.description || "",
    source: overrides.source || "finance",
    createdAt: normalizeTimestamp(overrides.createdAt) || new Date().toISOString(),
  };
}

export function normalizeTransaction(raw = {}, fallbackType = "expense") {
  return createTransaction({
    id: raw.id,
    type: raw.type || raw.transactionType || fallbackType,
    category: raw.category || raw.categoria || raw.tipoGasto,
    amount: raw.amount ?? raw.valor,
    date: raw.date || raw.data || raw.createdAt,
    clientId: raw.clientId || raw.clienteId || null,
    description: raw.description || raw.descricao || raw.desc || raw.obs,
    source: raw.source || fallbackType,
    createdAt: raw.createdAt,
  });
}

export function normalizeStockMovement(raw = {}) {
  return {
    id: raw.id || generateId(),
    type: mapStockType(raw.type),
    productId: raw.productId || raw.produtoId || null,
    productName: raw.productName || raw.produto || raw.name || "",
    quantity: toNumber(raw.quantity ?? raw.qtd),
    unit: raw.unit || raw.unidade || "",
    date: normalizeTimestamp(raw.date || raw.data || raw.createdAt) || new Date().toISOString(),
    cost: toNumber(raw.cost ?? raw.unitCost ?? raw.valor ?? raw.amount),
    clientId: raw.clientId || raw.clienteId || null,
    destination: raw.destination || raw.destino || "",
    reason: raw.reason || raw.motivo || "",
    lot: raw.lot || raw.lote || "",
    observation: raw.observation || raw.obs || "",
    createdAt: normalizeTimestamp(raw.createdAt) || new Date().toISOString(),
  };
}

export function normalizeSoilRecord(raw = {}) {
  return {
    id: raw.id || generateId(),
    param: raw.param || raw.metric || raw.nome || "Indicador",
    value: raw.value ?? raw.valor ?? raw.measure ?? "",
    unit: raw.unit || raw.unidade || "",
    barColor: raw.barColor || "",
    barWidth: toNumber(raw.barWidth || raw.percentual || raw.percentage),
    statusClass: raw.statusClass || "",
    statusText: raw.statusText || "",
    ph: toNumber(raw.ph),
    moisture: toNumber(raw.moisture || raw.umidade),
    temperature: toNumber(raw.temperature || raw.temperatura),
    date: normalizeTimestamp(raw.date || raw.createdAt) || new Date().toISOString(),
  };
}

export function createTimelineEntry(text, type = "edit", extras = {}) {
  return {
    type,
    text,
    date: new Date().toISOString(),
    author: extras.author || "Sistema",
  };
}
