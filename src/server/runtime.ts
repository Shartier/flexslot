// Background work of the single process (DESIGN 2, 7.5, 8): startup recovery, then a timer that runs the send
// queue of each payment mode, ends expired proposals, and watches PayPal orders waiting for the buyer's approval.
// The watcher only queries (GET order) and, when PayPal says APPROVED, gives the executor the same signal as the
// browser's return page (E3). The executor decides everything else; no money moves on the watcher's own account.

import type { Clock } from '../clock.ts';
import { immediate, type Db } from '../db/database.ts';
import type { Executor } from '../executor/executor.ts';
import type { PayPalPort } from '../paypal/port.ts';
import { expireOffers, reevaluateInTx } from '../app/cases.ts';
import type { PaymentMode } from '../app/world.ts';

export const TICK_MS = 1_500;
export const WATCH_EVERY_MS = 5_000;
/** A's unapproved order is watched this long after it was created (the A screen's button works after that too). */
export const A_WATCH_WINDOW_MS = 3 * 3_600_000;

export interface RuntimeDeps {
  db: Db;
  clock: Clock;
  executors: Partial<Record<PaymentMode, Executor>>;
  paypal: Partial<Record<PaymentMode, PayPalPort>>;
  offerTtlMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

export class Runtime {
  readonly #d: RuntimeDeps;
  readonly #lastWatch = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(d: RuntimeDeps) {
    this.#d = d;
  }

  #log(line: Record<string, unknown>): void {
    this.#d.log?.(line);
  }

  /** Startup recovery for every mode (DESIGN 7.5): unconfirmed operations first, then active cases. */
  async startup(): Promise<void> {
    for (const [mode, ex] of Object.entries(this.#d.executors)) {
      const r = await ex.recover();
      this.#log({ event: 'recovery', mode, recovered: r.recovered.length, excluded: r.excluded.length, busy: r.busy.length });
    }
  }

  /** One tick. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const expired = expireOffers(this.#d.db, this.#d.clock.now());
      if (expired.length) this.#log({ event: 'offers.expired', count: expired.length });
      for (const ex of Object.values(this.#d.executors)) {
        try {
          await ex.processDue();
        } catch (e) {
          this.#log({ event: 'queue.error', mode: ex.mode, error: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown' });
        }
      }
      try {
        await this.watchApprovals();
      } catch (e) {
        this.#log({ event: 'watch.error', error: e instanceof Error ? `${e.name}: ${e.message}` : 'unknown' });
      }
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs = TICK_MS): void {
    this.stop();
    this.#timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #due(key: string, now: number): boolean {
    const last = this.#lastWatch.get(key);
    if (last !== undefined && now - last < WATCH_EVERY_MS) return false;
    this.#lastWatch.set(key, now);
    return true;
  }

  /** Orders that wait for the buyer: when PayPal reports APPROVED, signal the executor (E3 / A's capture). */
  async watchApprovals(): Promise<void> {
    const { db, clock } = this.#d;
    const now = clock.now();
    const b = db
      .prepare(
        `SELECT c.id AS case_id, op.result_external_id AS order_id, w.mode_payment AS mode
         FROM payment_attempts t JOIN money_obligations m ON m.id = t.obligation_id JOIN swap_cases c ON c.id = m.case_id
         JOIN worlds w ON w.id = c.world_id
         JOIN payment_operations op ON op.attempt_id = t.id AND op.op_kind = 'ORDER_CREATE' AND op.status = 'SUCCEEDED'
         WHERE m.kind = 'B_CHARGE' AND t.status = 'ORDER_CREATED' AND t.expires_at > ? AND c.status = 'PAYMENT_STARTED'
           AND NOT EXISTS (SELECT 1 FROM payment_operations x WHERE x.attempt_id = t.id AND x.op_kind = 'ORDER_AUTHORIZE' AND x.status NOT IN ('FAILED', 'NOT_ACCEPTED'))`,
      )
      .all(now) as Array<{ case_id: string; order_id: string; mode: PaymentMode }>;
    for (const r of b) {
      const ex = this.#d.executors[r.mode];
      const port = this.#d.paypal[r.mode];
      if (!ex || !port || !this.#due(r.order_id, now)) continue;
      const q = await port.getOrder(r.order_id);
      if (q.kind !== 'FOUND' || q.resource.status !== 'APPROVED') continue;
      this.#log({ event: 'watch.approved', who: 'B', mode: r.mode });
      const res = await ex.onBuyerApproved(r.case_id);
      if (res.ok) await ex.advance(r.case_id);
    }
    const a = db
      .prepare(
        `SELECT op.booking_id, op.result_external_id AS order_id, w.mode_payment AS mode, s.world_id
         FROM a_payment_operations op JOIN bookings bk ON bk.id = op.booking_id JOIN shops s ON s.id = bk.shop_id JOIN worlds w ON w.id = s.world_id
         WHERE op.op_kind = 'ORDER_CREATE' AND op.status = 'SUCCEEDED' AND op.created_at > ?
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = op.booking_id AND p.kind = 'A_ORIGINAL')
           AND NOT EXISTS (SELECT 1 FROM a_payment_operations x WHERE x.booking_id = op.booking_id AND x.op_kind = 'ORDER_CAPTURE' AND x.status NOT IN ('FAILED', 'NOT_ACCEPTED'))`,
      )
      .all(now - A_WATCH_WINDOW_MS) as Array<{ booking_id: string; order_id: string; mode: PaymentMode; world_id: string }>;
    for (const r of a) {
      const ex = this.#d.executors[r.mode];
      const port = this.#d.paypal[r.mode];
      if (!ex || !port || !this.#due(r.order_id, now)) continue;
      const q = await port.getOrder(r.order_id);
      if (q.kind !== 'FOUND' || q.resource.status !== 'APPROVED') continue;
      this.#log({ event: 'watch.approved', who: 'A', mode: r.mode });
      const res = await ex.captureAPayment(r.booking_id);
      if (res.ok && res.paid) immediate(db, () => reevaluateInTx(db, clock.now(), r.world_id, this.#d.offerTtlMs));
    }
  }
}
