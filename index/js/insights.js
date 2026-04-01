import { calculateKPIs } from "./kpi.js";
import { checkLowStock } from "./stock.js";

export function analyzeSoil(data) {
  const alerts = [];

  if (data.ph < 5.5) alerts.push("Solo ácido - aplicar calcário");
  if (data.moisture < 30) alerts.push("Baixa umidade - irrigação recomendada");

  return alerts;
}

export function generateInsights(data) {
  const insights = [];

  const lowStock = checkLowStock(data.products);
  lowStock.forEach((product) => {
    insights.push(`Estoque baixo: ${product.name}`);
  });

  const topClient = [...data.clients].sort((a, b) => b.totalRevenue - a.totalRevenue)[0];
  if (topClient) {
    insights.push(`Cliente destaque: ${topClient.name}`);
  }

  const kpi = calculateKPIs(data);
  if (kpi.totalExpenses > kpi.totalRevenue * 0.8 && kpi.totalRevenue > 0) {
    insights.push("Despesas muito altas");
  }

  if (data.soilSummary) {
    analyzeSoil(data.soilSummary).forEach((alert) => insights.push(alert));
  }

  return insights;
}

export function runAutomation(data) {
  const alerts = [];

  if (checkLowStock(data.products).length) {
    alerts.push("Estoque crítico");
  }

  data.clients.forEach((client) => {
    if (!client.lastContact) {
      alerts.push(`Cliente sem contato: ${client.name}`);
    }
  });

  if (data.soilSummary) {
    analyzeSoil(data.soilSummary).forEach((alert) => alerts.push(alert));
  }

  return alerts;
}
