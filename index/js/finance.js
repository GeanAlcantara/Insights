import { toNumber } from "./data.js";

export function calculateCashFlow(transactions) {
  let balance = 0;

  return [...transactions]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((transaction) => {
      const signedAmount = transaction.type === "income"
        ? toNumber(transaction.amount)
        : -toNumber(transaction.amount);

      balance += signedAmount;

      return {
        ...transaction,
        balance,
      };
    });
}

export function summarizeExpensesByCategory(transactions) {
  const expenses = transactions.filter((transaction) => transaction.type === "expense");
  const totalExpenses = expenses.reduce((sum, transaction) => sum + toNumber(transaction.amount), 0);
  const grouped = new Map();

  expenses.forEach((transaction) => {
    const key = transaction.category || "Sem categoria";
    grouped.set(key, (grouped.get(key) || 0) + toNumber(transaction.amount));
  });

  return [...grouped.entries()]
    .map(([category, amount]) => {
      const share = totalExpenses ? (amount / totalExpenses) * 100 : 0;
      return {
        category,
        amount,
        percent: share,
        variantTxt: share >= 35 ? "Pressão alta" : share >= 20 ? "Relevante" : "Controlado",
        variantClass: share >= 35 ? "loss" : share >= 20 ? "warning" : "neutral",
      };
    })
    .sort((left, right) => right.amount - left.amount);
}
