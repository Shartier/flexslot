// PayPal webhook inbox (DESIGN 7.4, D06, D15; AC07).
// 1. Receive: every delivery is stored as it came (selected PayPal headers, raw body, SHA-256) before any check.
//    The HTTP answer is 200 only after that insert has committed; anything bigger than 64 KB is refused unstored.
// 2. Verify: PayPal's verify-webhook-signature API with the configured webhook id. VERIFIED / INVALID (final) /
//    VERIFY_ERROR (try again later, with backoff, also after a restart). Nothing is trusted before VERIFIED.
// 3. Deduplicate: only a VERIFIED delivery may register its event_id in webhook_events (unique). A forged delivery
//    with the same event_id never blocks the genuine one; a genuine event delivered twice is handled once.
// 4. Use: an event only wakes the operations it names (their next query or resend becomes due now) and tells
//    the approval watcher to look at an approved order. The event's content never changes a state directly, so
//    old, repeated or out-of-order events cannot move anything backwards; the REST queries decide (D06).

import { createHash, randomUUID } from 'node:crypto';
import { immediate, type Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import type { PayPalPort } from '../paypal/port.ts';
import { audit } from '../executor/store.ts';

export const MAX_WEBHOOK_BODY_BYTES = 65_536;
const HEADERS = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'] as const;
const FIRST_RETRY_MS = 10_000;
const MAX_RETRY_MS = 10 * 60_000;

export type ReceiveResult = { ok: true; deliveryId: string } | { ok: false; status: 413; reason: 'BODY_TOO_LARGE' };

/** Step 1: store the delivery. Throws if it cannot be stored (the caller then answers 500, never 200). */
export function receiveWebhook(db: Db, now: number, headers: Readonly<Record<string, string | undefined>>, body: string): ReceiveResult {
  if (Buffer.byteLength(body, 'utf8') > MAX_WEBHOOK_BODY_BYTES) return { ok: false, status: 413, reason: 'BODY_TOO_LARGE' };
  let eventId: string | null = null;
  try {
    const id = (JSON.parse(body) as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) eventId = id;
  } catch {
    eventId = null;
  }
  const kept: Record<string, string> = {};
  for (const h of HEADERS) {
    const v = headers[h];
    if (v !== undefined) kept[h] = v.slice(0, 2048);
  }
  const deliveryId = randomUUID();
  db.prepare(
    `INSERT INTO webhook_deliveries (id, received_at, event_id, transmission_id, body_sha256, headers_json, body, verify_status, verify_tries, next_verify_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UNVERIFIED', 0, ?)`,
  ).run(deliveryId, now, eventId, kept['paypal-transmission-id'] ?? null, createHash('sha256').update(body).digest('hex'), JSON.stringify(kept), body, now);
  return { ok: true, deliveryId };
}

interface DeliveryRow {
  id: string;
  event_id: string | null;
  headers_json: string;
  body: string;
  verify_status: string;
  verify_tries: number;
}

export interface InboxDeps {
  db: Db;
  clock: Clock;
  /** The Sandbox adapter (webhooks come only from the Sandbox). Null when PayPal is not configured. */
  paypal: PayPalPort | null;
  /** PAYPAL_WEBHOOK_ID. Without it nothing can be verified, so nothing is used. */
  webhookId: string | null;
  /** CHECKOUT.ORDER.APPROVED: let the approval watcher query this order now. */
  onOrderApproved?: (orderId: string) => void;
  log?: (line: Record<string, unknown>) => void;
}

export class WebhookInbox {
  readonly #d: InboxDeps;

  constructor(d: InboxDeps) {
    this.#d = d;
  }

  /**
   * Step 2-4 for the deliveries that are due: each verified event is used right after its own verification, so a
   * slow verification later in the batch never delays it (IW1-01). Returns how many were verified now.
   */
  async verifyDue(limit = 20): Promise<number> {
    this.processPending(); // events verified before a restart
    const { db, clock } = this.#d;
    const now = clock.now();
    const due = db
      .prepare(
        `SELECT id, event_id, headers_json, body, verify_status, verify_tries FROM webhook_deliveries
         WHERE verify_status IN ('UNVERIFIED', 'VERIFY_ERROR') AND next_verify_at IS NOT NULL AND next_verify_at <= ? ORDER BY received_at LIMIT ?`,
      )
      .all(now, limit) as unknown as DeliveryRow[];
    let verified = 0;
    for (const d of due) {
      if ((await this.#verifyOne(d)) === 'VERIFIED') {
        verified++;
        this.processPending();
      }
    }
    return verified;
  }

  async #verifyOne(d: DeliveryRow): Promise<string> {
    const { db, clock } = this.#d;
    const h = JSON.parse(d.headers_json) as Record<string, string>;
    let event: unknown;
    try {
      event = JSON.parse(d.body);
    } catch {
      return this.#final(d, 'INVALID', 'BODY_NOT_JSON');
    }
    if (!d.event_id || HEADERS.some((k) => !h[k])) return this.#final(d, 'INVALID', 'MISSING_FIELDS');
    if (!this.#d.paypal || !this.#d.webhookId) {
      // Not configured: keep it stored and unverified; look again later (e.g. after the settings are added).
      db.prepare("UPDATE webhook_deliveries SET next_verify_at = ? WHERE id = ? AND verify_status = 'UNVERIFIED'").run(clock.now() + MAX_RETRY_MS, d.id);
      return 'UNVERIFIED';
    }
    const r = await this.#d.paypal.verifyWebhookSignature({
      authAlgo: h['paypal-auth-algo']!,
      certUrl: h['paypal-cert-url']!,
      transmissionId: h['paypal-transmission-id']!,
      transmissionSig: h['paypal-transmission-sig']!,
      transmissionTime: h['paypal-transmission-time']!,
      webhookId: this.#d.webhookId,
      event,
    });
    if (r.kind === 'FAILURE') return this.#final(d, 'INVALID', 'SIGNATURE_FAILURE');
    if (r.kind === 'REJECTED') return this.#final(d, 'INVALID', `REJECTED_${r.httpStatus}`);
    if (r.kind !== 'SUCCESS') {
      const tries = d.verify_tries + 1;
      const wait = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(tries - 1, 10));
      db.prepare("UPDATE webhook_deliveries SET verify_status = 'VERIFY_ERROR', verify_tries = ?, next_verify_at = ? WHERE id = ? AND verify_status IN ('UNVERIFIED', 'VERIFY_ERROR')").run(
        tries, clock.now() + wait, d.id,
      );
      this.#d.log?.({ event: 'webhook.verify_error', reason: r.kind === 'UNAVAILABLE' ? r.reason : r.kind, tries });
      return 'VERIFY_ERROR';
    }
    const now = clock.now();
    immediate(db, () => {
      const w = db
        .prepare("UPDATE webhook_deliveries SET verify_status = 'VERIFIED', verify_tries = verify_tries + 1, next_verify_at = NULL WHERE id = ? AND verify_status IN ('UNVERIFIED', 'VERIFY_ERROR')")
        .run(d.id);
      if (w.changes !== 1) return;
      // D15: the unique event_id is registered only by a VERIFIED delivery; a second genuine copy is a no-op.
      db.prepare('INSERT INTO webhook_events (event_id, delivery_id, verified_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING').run(d.event_id, d.id, now);
    });
    return 'VERIFIED';
  }

  #final(d: DeliveryRow, status: 'INVALID', reason: string): string {
    this.#d.db.prepare("UPDATE webhook_deliveries SET verify_status = ?, verify_tries = verify_tries + 1, next_verify_at = NULL WHERE id = ? AND verify_status IN ('UNVERIFIED', 'VERIFY_ERROR')").run(status, d.id);
    this.#d.log?.({ event: 'webhook.invalid', reason });
    return status;
  }

  /** Step 4 for registered events not yet used. Returns how many were processed. */
  processPending(limit = 50): number {
    const { db, clock } = this.#d;
    const rows = db
      .prepare(
        `SELECT e.event_id, d.body FROM webhook_events e JOIN webhook_deliveries d ON d.id = e.delivery_id
         WHERE e.processed_at IS NULL ORDER BY e.verified_at LIMIT ?`,
      )
      .all(limit) as Array<{ event_id: string; body: string }>;
    for (const r of rows) {
      const now = clock.now();
      const ev = JSON.parse(r.body) as { event_type?: unknown; resource?: { id?: unknown; supplementary_data?: { related_ids?: Record<string, unknown> } } };
      const type = typeof ev.event_type === 'string' ? ev.event_type.slice(0, 80) : 'UNKNOWN';
      const resourceId = typeof ev.resource?.id === 'string' ? ev.resource.id : null;
      // The resource and its parents (order, authorization, capture) as PayPal lists them: ids to look up only.
      const ids = [resourceId, ...Object.values(ev.resource?.supplementary_data?.related_ids ?? {})].filter(
        (x, i, all): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64 && all.indexOf(x) === i,
      );
      const woken = immediate(db, () => {
        const done = db.prepare('UPDATE webhook_events SET processed_at = ? WHERE event_id = ? AND processed_at IS NULL').run(now, r.event_id);
        if (done.changes !== 1) return null;
        let n = 0;
        for (const id of ids) {
          // Wake unconfirmed or awaiting operations that name this resource; held operations stay with the owner.
          for (const table of ['payment_operations', 'a_payment_operations'] as const) {
            n += db
              .prepare(
                `UPDATE ${table} SET next_send_at = ?
                 WHERE (result_external_id = ? OR target_external_id = ?)
                   AND (status IN ('SENDING', 'UNKNOWN', 'PENDING') OR (status = 'SUCCEEDED' AND reconcile_status = 'AWAITING'))
                   AND (last_error_class IS NULL OR last_error_class NOT LIKE 'HOLD:%')
                   AND (next_send_at IS NULL OR next_send_at > ?)`,
              )
              .run(now, id, id, now).changes as number;
          }
        }
        const world = ids.map((id) => this.#worldOf(id)).find((x) => x !== null) ?? null;
        audit(db, now, { worldId: world, actor: 'webhook', action: 'WEBHOOK_EVENT', detail: { type, wokenOperations: n } });
        return n;
      });
      if (woken !== null && type === 'CHECKOUT.ORDER.APPROVED' && resourceId) this.#d.onOrderApproved?.(resourceId);
    }
    return rows.length;
  }

  #worldOf(resourceId: string): string | null {
    const b = this.#d.db
      .prepare(
        `SELECT c.world_id AS w FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id
         JOIN swap_cases c ON c.id = m.case_id WHERE o.result_external_id = ? OR o.target_external_id = ? LIMIT 1`,
      )
      .get(resourceId, resourceId) as { w: string } | undefined;
    if (b) return b.w;
    const a = this.#d.db
      .prepare(
        `SELECT s.world_id AS w FROM a_payment_operations o JOIN bookings k ON k.id = o.booking_id JOIN shops s ON s.id = k.shop_id
         WHERE o.result_external_id = ? OR o.target_external_id = ? LIMIT 1`,
      )
      .get(resourceId, resourceId) as { w: string } | undefined;
    return a?.w ?? null;
  }
}
