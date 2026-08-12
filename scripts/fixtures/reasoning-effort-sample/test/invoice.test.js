import assert from "node:assert/strict";
import test from "node:test";
import { calculateInvoice } from "../src/invoice.js";

test("calculates subtotal, tax, and total", () => {
  assert.deepEqual(
    calculateInvoice(
      [
        { quantity: 2, unitPrice: 12.5 },
        { quantity: 1, unitPrice: 5 },
      ],
      0.1,
    ),
    { subtotal: 30, tax: 3, total: 33 },
  );
});

test("rejects negative values", () => {
  assert.throws(
    () => calculateInvoice([{ quantity: -1, unitPrice: 5 }], 0.1),
    /non-negative/u,
  );
});
