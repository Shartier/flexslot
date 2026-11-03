// Result matching before an operation is treated as successful (DESIGN 7, "結果の照合").

import { amountEquals, type Money } from './money.ts';
import type { Amount } from './schemas.ts';

export interface MatchExpectation {
  amount: Money;
  customId?: string;
  payeeMerchantId?: string;
}

interface Matchable {
  amount?: Amount | undefined;
  custom_id?: string | undefined;
  payee?: { merchant_id?: string | undefined } | undefined;
}

/** Names of the fields that differ from the expectation. Fields left out of the expectation are not checked. */
export function mismatches(resource: Matchable, expected: MatchExpectation): string[] {
  const out: string[] = [];
  if (!amountEquals(resource.amount, expected.amount)) out.push('amount');
  if (expected.customId !== undefined && resource.custom_id !== expected.customId) out.push('custom_id');
  if (expected.payeeMerchantId !== undefined && resource.payee?.merchant_id !== expected.payeeMerchantId) out.push('payee');
  return out;
}
