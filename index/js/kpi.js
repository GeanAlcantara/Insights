import { kpis as kpiTemplate, toNumber } from "./data.js";
import { calculateInventoryValue, calculateStockTurnover } from "./stock.js";

export function calculateKPIs(data) {
  const revenue = data.finance
    .filter((item) => item.type === "income")
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const expenses = data.finance
    .filter((item) => item.type === "expense")
    .reduce((sum, item) => sum + toNumber(item.amount), 0);

  const clients = data.clients.length;

  return {
    ...kpiTemplate,
    totalRevenue: revenue,
    totalExpenses: expenses,
    netProfit: revenue - expenses,
    averageTicket: clients ? revenue / clients : 0,
    revenuePerClient: clients ? revenue / clients : 0,
    inventoryValue: calculateInventoryValue(data.products || []),
    stockTurnover: calculateStockTurnover(data.stockRange || data.stock || [], data.products || []),
  };
}
