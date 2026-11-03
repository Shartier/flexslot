// Owner-side estimate of the extra profit from one swap (SPEC 9). Integer minor units only (USD: cents).
//
//   additional profit = B price - A compensation - B's extra service cost - extra payment/refund fees
//                       - opportunity loss at the destination - other incremental costs
//
// A's original payment is already booked revenue and is deliberately not an input: it must not be counted again.

export interface ProfitInputs {
  /** B's new price: the additional revenue. */
  bPriceMinor: number;
  /** Fixed compensation refunded to A. */
  aCompensationMinor: number;
  /** Extra cost of serving B (A's own service cost is in the baseline). */
  bServiceCostMinor: number;
  /** Extra payment and refund fees. An assumption, not a PayPal rate. */
  paymentFeesMinor: number;
  /** Expected profit lost because A's destination can no longer be sold. */
  opportunityLossMinor: number;
  otherIncrementalCostMinor: number;
}

export type ProfitLineKey = keyof ProfitInputs;

export interface ProfitLine {
  key: ProfitLineKey;
  /** +1 adds to profit, -1 subtracts. */
  sign: 1 | -1;
  amountMinor: number;
}

export interface ProfitEstimate {
  additionalRevenueMinor: number;
  additionalProfitMinor: number;
  /** Inputs in display order, so the screen can show the formula with its values. */
  lines: ProfitLine[];
}

const LINE_ORDER: ReadonlyArray<readonly [ProfitLineKey, 1 | -1]> = [
  ['bPriceMinor', 1],
  ['aCompensationMinor', -1],
  ['bServiceCostMinor', -1],
  ['paymentFeesMinor', -1],
  ['opportunityLossMinor', -1],
  ['otherIncrementalCostMinor', -1],
];

export function estimateSwapProfit(inputs: ProfitInputs): ProfitEstimate {
  const lines = LINE_ORDER.map(([key, sign]) => ({ key, sign, amountMinor: nonNegativeMinor(key, inputs[key]) }));
  const additionalProfitMinor = lines.reduce((sum, line) => sum + line.sign * line.amountMinor, 0);
  if (!Number.isSafeInteger(additionalProfitMinor)) throw new RangeError('profit is outside the safe integer range');
  return { additionalRevenueMinor: inputs.bPriceMinor, additionalProfitMinor, lines };
}

/**
 * Opportunity loss = probability the destination would have been sold x marginal profit of that sale.
 * Probability is in basis points (3000 = 30%) to stay in integers; the product is rounded half up to a minor unit.
 */
export function expectedOpportunityLossMinor(fillProbabilityBasisPoints: number, marginalProfitMinor: number): number {
  if (!Number.isInteger(fillProbabilityBasisPoints) || fillProbabilityBasisPoints < 0 || fillProbabilityBasisPoints > 10_000) {
    throw new RangeError(`probability must be 0..10000 basis points, got ${fillProbabilityBasisPoints}`);
  }
  const product = fillProbabilityBasisPoints * nonNegativeMinor('marginalProfitMinor', marginalProfitMinor);
  if (!Number.isSafeInteger(product)) throw new RangeError('opportunity loss is outside the safe integer range');
  return Math.floor((product + 5_000) / 10_000);
}

function nonNegativeMinor(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer in minor units, got ${value}`);
  }
  return value;
}
