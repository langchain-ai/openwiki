/**
 * Calculate a two-decimal invoice total from line items and a decimal tax rate.
 *
 * @param {readonly {quantity: number, unitPrice: number}[]} items
 * @param {number} taxRate
 * @returns {{subtotal: number, tax: number, total: number}}
 */
export function calculateInvoice(items, taxRate) {
  if (taxRate < 0) {
    throw new RangeError("taxRate must be non-negative");
  }

  const subtotal = roundCurrency(
    items.reduce((sum, item) => {
      if (item.quantity < 0 || item.unitPrice < 0) {
        throw new RangeError("line item values must be non-negative");
      }
      return sum + item.quantity * item.unitPrice;
    }, 0),
  );
  const tax = roundCurrency(subtotal * taxRate);

  return { subtotal, tax, total: roundCurrency(subtotal + tax) };
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
