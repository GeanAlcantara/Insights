import { createTimelineEntry, mapClientStatus, toNumber } from "./data.js";

export const pipelineStages = ["lead", "contact", "proposal", "closed"];

export function getClientValueScore(client) {
  return toNumber(client?.estimatedValue) * (toNumber(client?.probability) / 100);
}

export function getClientStageLabel(status) {
  const labels = {
    lead: "Lead",
    contact: "Contato",
    proposal: "Proposta",
    closed: "Fechado",
  };
  return labels[mapClientStatus(status)] || "Lead";
}

export function attachRevenueToClients(clients, transactions) {
  const revenueByClient = new Map();

  transactions
    .filter((item) => item.type === "income" && item.clientId)
    .forEach((item) => {
      const current = revenueByClient.get(item.clientId) || 0;
      revenueByClient.set(item.clientId, current + toNumber(item.amount));
    });

  return clients.map((entry) => ({
    ...entry,
    totalRevenue: revenueByClient.has(entry.id)
      ? revenueByClient.get(entry.id)
      : toNumber(entry.totalRevenue),
  }));
}

export function summarizePipeline(clients) {
  return pipelineStages.reduce((accumulator, stage) => {
    accumulator[stage] = clients.filter((client) => client.status === stage).length;
    return accumulator;
  }, {});
}

export function createClientTimeline(text, type = "edit", extras = {}) {
  return createTimelineEntry(text, type, extras);
}
