// The pass/fail rules of `interrupts.ts report` (IR2-02, Codex): what the database and PayPal must agree on for one
// interruption run. Pure: interrupts.ts gathers the facts (DB rows and PayPal GETs) and prints these checks; tests
// feed it inconsistent facts and expect failures. A PayPal query that failed is never a pass.

export type RunId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
/** How each run must end: the swap completed (A refunded), B refunded in full (E-R), or the authorization voided (E-V). */
export type Outcome = 'SWAP_COMPLETED' | 'B_REFUNDED' | 'AUTH_VOIDED';
export const OUTCOME: Record<RunId, Outcome> = { R1: 'SWAP_COMPLETED', R2: 'SWAP_COMPLETED', R3: 'B_REFUNDED', R4: 'AUTH_VOIDED', R5: 'SWAP_COMPLETED' };

export interface Money {
  minor: number;
  currency: string;
}
export type Query<T> = { ok: true; value: T } | { ok: false; why: string };

export interface Facts {
  outcome: Outcome;
  caseStatus: string;
  /** Terms of the case from the database. */
  terms: { aCaptureId: string; bPrice: Money; aComp: Money; origin: [number, number]; dest: [number, number]; bSlot: [number, number] };
  obligations: Array<{ kind: string; status: string; amount: Money; target: string | null }>;
  /** Payment operations of the case; `rid` is the same short hash as in the POST log. */
  ops: Array<{ obligation: string; kind: string; status: string; sends: number; rid: string; res: string | null }>;
  /** A's original-payment operations (order create, capture) of this world. */
  aOps: Array<{ kind: string; rid: string }>;
  /** Money POSTs the verification processes logged (route = operation kind); `sent` false for an injected refusal. */
  posts: Array<{ route: string; rid: string; sent: boolean }>;
  aBooking: { start: number; end: number; status: string } | null;
  bBooking: { start: number; end: number; status: string } | null;
  grants: number;
  paypal: {
    bOrder: Query<{ auths: Array<{ id: string; status: string; amount: Money | null }>; caps: Array<{ id: string; status: string; amount: Money | null }>; refunds: Array<{ id: string }> }>;
    aOrderRefunds: Query<Array<{ id: string }>>;
    aCapture: Query<{ status: string }>;
    /** GET of each successful refund operation's refund, by refund id. */
    refunds: Record<string, Query<{ status: string; amount: Money | null; parentCapture: string | null }>>;
  };
}

export interface Check {
  name: string;
  ok: boolean;
}

const sameMoney = (a: Money | null | undefined, b: Money) => !!a && a.minor === b.minor && a.currency === b.currency;
const at = (b: { start: number; end: number; status: string } | null, slot: [number, number]) => !!b && b.status === 'CONFIRMED' && b.start === slot[0] && b.end === slot[1];
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

export function evaluate(f: Facts): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean) => checks.push({ name, ok });
  const ob = (kind: string) => f.obligations.find((o) => o.kind === kind);
  const succeeded = (obligation: string, kind: string) => f.ops.filter((o) => o.obligation === obligation && o.kind === kind && o.status === 'SUCCEEDED' && o.res);
  const swap = f.outcome === 'SWAP_COMPLETED';
  const bRefunded = f.outcome === 'B_REFUNDED';
  const voided = f.outcome === 'AUTH_VOIDED';

  // 1. Request ids: every logged money POST belongs to a recorded operation of the same kind, and an operation was
  //    never logged more often than it records sending (the owner's recovery in R2 was sent by the app server, outside
  //    this log; the database and the refund query cover it below).
  const all = [...f.ops.map((o) => ({ kind: o.kind, rid: o.rid, sends: o.sends })), ...f.aOps.map((o) => ({ kind: o.kind, rid: o.rid, sends: Number.POSITIVE_INFINITY }))];
  check(
    'every logged money POST carries the request id of a recorded operation of the same kind',
    f.posts.every((p) => all.some((o) => o.rid === p.rid && o.kind === p.route)),
  );
  check(
    'no operation was logged more often than it records sending',
    f.ops.every((o) => f.posts.filter((p) => p.rid === o.rid).length <= o.sends),
  );
  check('at most one capture operation for B', f.ops.filter((o) => o.kind === 'AUTH_CAPTURE').length <= 1);

  // 2. Case, obligations, bookings, compensation grant.
  check(`case status is ${swap ? 'COMPLETED' : bRefunded ? 'COMPENSATED' : 'REJECTED'}`, f.caseStatus === (swap ? 'COMPLETED' : bRefunded ? 'COMPENSATED' : 'REJECTED'));
  const charge = ob('B_CHARGE');
  check(`B's charge is ${voided ? 'CANCELLED' : 'SETTLED'} for B's price`, !!charge && charge.status === (voided ? 'CANCELLED' : 'SETTLED') && sameMoney(charge.amount, f.terms.bPrice));
  const aRefund = ob('A_COMPENSATION_REFUND');
  const bRefund = ob('B_RECOVERY_REFUND');
  const bVoid = ob('B_AUTH_VOID');
  if (swap) {
    check(
      "A's compensation refund is SETTLED for the compensation, against A's original capture, with one successful refund",
      !!aRefund && aRefund.status === 'SETTLED' && sameMoney(aRefund.amount, f.terms.aComp) && aRefund.target === f.terms.aCaptureId && succeeded('A_COMPENSATION_REFUND', 'CAPTURE_REFUND').length === 1,
    );
    check('no refund to B and no void', !bRefund && !bVoid);
    check("A's booking moved to the destination and B's booking is confirmed in the original slot", at(f.aBooking, f.terms.dest) && at(f.bBooking, f.terms.bSlot));
    check('one compensation grant', f.grants === 1);
  } else {
    if (bRefunded) {
      check(
        "B's full refund is SETTLED for B's price, with one successful refund",
        !!bRefund && bRefund.status === 'SETTLED' && sameMoney(bRefund.amount, f.terms.bPrice) && succeeded('B_RECOVERY_REFUND', 'CAPTURE_REFUND').length === 1,
      );
      check('no compensation refund and no void', !aRefund && !bVoid);
    } else {
      check("the release of B's authorization is SETTLED", !!bVoid && bVoid.status === 'SETTLED' && succeeded('B_AUTH_VOID', 'AUTH_VOID').length === 1);
      check('no refunds', !aRefund && !bRefund);
    }
    check("A's booking kept in the original slot and no booking for B", at(f.aBooking, f.terms.origin) && !(f.bBooking && f.bBooking.status === 'CONFIRMED'));
    check('no compensation grant', f.grants === 0);
  }

  // 3. PayPal: B's order (authorization, capture), A's original capture.
  const authOp = succeeded('B_CHARGE', 'ORDER_AUTHORIZE')[0];
  const capOp = succeeded('B_CHARGE', 'AUTH_CAPTURE')[0];
  if (!f.paypal.bOrder.ok) check(`B's order queried at PayPal (${f.paypal.bOrder.why})`, false);
  else {
    const { auths, caps } = f.paypal.bOrder.value;
    check(
      `PayPal holds one authorization for B, the recorded one, for B's price, ${voided ? 'VOIDED' : 'CAPTURED'}`,
      auths.length === 1 && !!authOp && auths[0]!.id === authOp.res && sameMoney(auths[0]!.amount, f.terms.bPrice) && auths[0]!.status === (voided ? 'VOIDED' : 'CAPTURED'),
    );
    check(
      voided ? 'PayPal holds no capture for B' : `PayPal holds one capture for B, the recorded one, for B's price, ${bRefunded ? 'REFUNDED' : 'COMPLETED'}`,
      voided ? caps.length === 0 : caps.length === 1 && !!capOp && caps[0]!.id === capOp.res && sameMoney(caps[0]!.amount, f.terms.bPrice) && caps[0]!.status === (bRefunded ? 'REFUNDED' : 'COMPLETED'),
    );
  }
  if (!f.paypal.aCapture.ok) check(`A's original capture queried at PayPal (${f.paypal.aCapture.why})`, false);
  else check(`A's original capture is ${swap ? 'PARTIALLY_REFUNDED' : 'COMPLETED'}`, f.paypal.aCapture.value.status === (swap ? 'PARTIALLY_REFUNDED' : 'COMPLETED'));

  // 4. Each successful refund operation's refund at PayPal: found, COMPLETED, the obligation's amount and capture.
  for (const [obligation, refundOb] of [
    ['A_COMPENSATION_REFUND', aRefund],
    ['B_RECOVERY_REFUND', bRefund],
  ] as const) {
    for (const op of succeeded(obligation, 'CAPTURE_REFUND')) {
      const q = f.paypal.refunds[op.res!];
      const name = `${obligation}: PayPal's refund is COMPLETED, for the obligation's amount, against its capture`;
      if (!q || !q.ok) check(`${name} (query ${q ? q.why : 'missing'})`, false);
      else check(name, q.value.status === 'COMPLETED' && !!refundOb && sameMoney(q.value.amount, refundOb.amount) && q.value.parentCapture !== null && q.value.parentCapture === refundOb.target);
    }
  }

  // 5. No extra or repeated refund at PayPal: each order lists exactly the recorded successful refunds.
  const okA = f.paypal.aOrderRefunds;
  const okB = f.paypal.bOrder;
  check(
    'the refunds PayPal lists on the A and B orders are exactly the recorded successful refund operations (none extra, none twice)',
    okA.ok &&
      okB.ok &&
      sameSet(okA.value.map((r) => r.id), succeeded('A_COMPENSATION_REFUND', 'CAPTURE_REFUND').map((o) => o.res!)) &&
      sameSet(okB.value.refunds.map((r) => r.id), succeeded('B_RECOVERY_REFUND', 'CAPTURE_REFUND').map((o) => o.res!)),
  );
  return checks;
}
