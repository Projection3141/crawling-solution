const TRADE_PRICE_FIELDS = new Set([
  "onePrice", "boxPrice", "effectivePrice", "hasBoxDiscount", "addPrice", "addPriceObserved",
  "inoPrice", "indcPrice", "indcPrice2", "inoPer", "indcPer", "indcPer2",
  "wholesalePrice", "yenWholesalePrice", "salePrice", "discountRate", "additionalPrice", "additionalPriceObserved",
  "priceMin", "priceMax", "price", "priceText",
]);

// Scrub transient rows too, so checkpoints and CSV files follow the same price policy.
function keepConsumerPrices(value) {
  if (Array.isArray(value)) return value.map(keepConsumerPrices);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !TRADE_PRICE_FIELDS.has(key))
    .map(([key, item]) => [key, keepConsumerPrices(item)]));
}

module.exports = { keepConsumerPrices, TRADE_PRICE_FIELDS };
