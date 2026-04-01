import { toNumber } from "./data.js";

export function calculateAverageCost(movements) {
  let totalCost = 0;
  let totalQty = 0;

  movements.forEach((movement) => {
    if (movement.type === "entry") {
      totalCost += toNumber(movement.quantity) * toNumber(movement.cost);
      totalQty += toNumber(movement.quantity);
    }
  });

  return totalQty ? totalCost / totalQty : 0;
}

export function calculateCurrentStock(movements) {
  return movements.reduce((sum, movement) => {
    const quantity = toNumber(movement.quantity);
    if (movement.type === "entry" || movement.type === "return") return sum + quantity;
    if (movement.type === "exit") return sum - quantity;
    return sum;
  }, 0);
}

export function enrichProductsWithStock(products, stockMovements) {
  return products.map((entry) => {
    const relatedMovements = stockMovements.filter((movement) => {
      return movement.productId
        ? movement.productId === entry.id
        : movement.productName === entry.name;
    });

    const avgCost = calculateAverageCost(relatedMovements);
    const stockCurrent = calculateCurrentStock(relatedMovements);

    return {
      ...entry,
      avgCost,
      stockCurrent,
    };
  });
}

export function checkLowStock(products) {
  return products.filter((item) => item.stockCurrent <= item.stockMin);
}

export function calculateInventoryValue(products) {
  return products.reduce((sum, item) => {
    const cost = toNumber(item.avgCost || item.costPrice);
    return sum + (toNumber(item.stockCurrent) * cost);
  }, 0);
}

export function calculateStockTurnover(stockMovements, products) {
  const stockOutflow = stockMovements
    .filter((movement) => movement.type === "exit")
    .reduce((sum, movement) => sum + toNumber(movement.quantity), 0);

  const averageInventory = products.reduce((sum, item) => {
    return sum + Math.max(toNumber(item.stockCurrent), 0);
  }, 0);

  return averageInventory ? stockOutflow / averageInventory : 0;
}
