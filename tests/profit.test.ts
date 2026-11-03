import { describe, expect, it } from 'vitest';
import { estimateSwapProfit, expectedOpportunityLossMinor, type ProfitInputs } from '../src/domain/profit.ts';

// SPEC 9 assumptions in cents.
const spec9: ProfitInputs = {
  bPriceMinor: 6000,
  aCompensationMinor: 1000,
  bServiceCostMinor: 1500,
  paymentFeesMinor: 250,
  opportunityLossMinor: 1200,
  otherIncrementalCostMinor: 0,
};

describe('AC14 profit estimate (SPEC 9)', () => {
  it('reproduces 20.50 from the SPEC 9 table', () => {
    const estimate = estimateSwapProfit(spec9);
    expect(estimate.additionalProfitMinor).toBe(2050);
    expect(estimate.additionalRevenueMinor).toBe(6000);
    expect(estimate.lines).toEqual([
      { key: 'bPriceMinor', sign: 1, amountMinor: 6000 },
      { key: 'aCompensationMinor', sign: -1, amountMinor: 1000 },
      { key: 'bServiceCostMinor', sign: -1, amountMinor: 1500 },
      { key: 'paymentFeesMinor', sign: -1, amountMinor: 250 },
      { key: 'opportunityLossMinor', sign: -1, amountMinor: 1200 },
      { key: 'otherIncrementalCostMinor', sign: -1, amountMinor: 0 },
    ]);
  });

  it.each([
    [0, 3250],
    [1200, 2050],
    [3250, 0],
    [4000, -750],
  ])('opportunity loss %i cents -> profit %i cents', (loss, profit) => {
    expect(estimateSwapProfit({ ...spec9, opportunityLossMinor: loss }).additionalProfitMinor).toBe(profit);
  });

  it('derives the 12.00 opportunity loss from 30% x 40.00', () => {
    expect(expectedOpportunityLossMinor(3000, 4000)).toBe(1200);
    expect(expectedOpportunityLossMinor(0, 4000)).toBe(0);
    expect(expectedOpportunityLossMinor(10_000, 4000)).toBe(4000);
    // Rounded half up to a whole cent: 33.33% x 0.10 = 3.333 -> 3; 0.5% x 1.00 = 0.5 -> 1.
    expect(expectedOpportunityLossMinor(3333, 10)).toBe(3);
    expect(expectedOpportunityLossMinor(50, 100)).toBe(1);
  });

  it('rejects non-integer, negative or out-of-range inputs', () => {
    expect(() => estimateSwapProfit({ ...spec9, bPriceMinor: 60.5 })).toThrow(RangeError);
    expect(() => estimateSwapProfit({ ...spec9, paymentFeesMinor: -1 })).toThrow(RangeError);
    expect(() => estimateSwapProfit({ ...spec9, opportunityLossMinor: Number.NaN })).toThrow(RangeError);
    expect(() => expectedOpportunityLossMinor(10_001, 4000)).toThrow(RangeError);
    expect(() => expectedOpportunityLossMinor(3000, -1)).toThrow(RangeError);
  });
});
