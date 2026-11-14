// Inventory-only exports contain identifiers and stock observations, not catalog data.
const INVENTORY_FIELDS = new Set([
  "id", "productId", "optionId", "sourceMall", "page", "index", "type", "options",
  "inventoryObserved", "inventoryUnavailable", "hasOption", "hasOptions",
  "requestedQty", "maxStock", "minStock", "totalStock", "stockQuantity", "stockStatus",
  "stockLimited", "status", "saleStatus", "isSoldOut", "listMaxStock", "listPorderMinus",
  "rowCount", "optionCount", "limitedRowCount", "lowStockRowCount", "outOfStockRowCount",
]);

function keepInventoryData(value) {
  if (Array.isArray(value)) return value.map(keepInventoryData);
  if (!value || typeof value !== "object") return value;
  const isRow = ["productId", "id", "optionId"].some(key => Object.hasOwn(value, key));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "debugFiles" && key !== "detailItems" && (!isRow || INVENTORY_FIELDS.has(key)))
    .map(([key, item]) => [key, keepInventoryData(item)]));
}

module.exports = { INVENTORY_FIELDS, keepInventoryData };
