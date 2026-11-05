// V8 evidence (DESIGN 12.1, AC07): what arrived at /webhooks/paypal during the window, as stored in the app's
// database (read only), with anonymized ids. `tamper` re-sends a stored genuine delivery to the LOCAL server with a
// changed body and the same headers, and checks that it becomes INVALID without touching the genuine event.
// Usage:
//   node scripts/verify/v8-webhook.ts report <since ISO time>
//   node scripts/verify/v8-webhook.ts tamper <since ISO time>

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { anon, NotReady, ROOT, run } from './_lib.ts';

const [mode, sinceArg] = process.argv.slice(2);
const dbPath = join(ROOT, process.env.FLEXSLOT_DATA_DIR ?? 'data', 'flexslot.sqlite');
const local = `http://127.0.0.1:${Number(process.env.FLEXSLOT_PORT ?? 8787)}/webhooks/paypal`;

interface Delivery {
  id: string;
  received_at: number;
  event_id: string | null;
  headers_json: string;
  body: string;
  verify_status: string;
  verify_tries: number;
}

const typeOf = (body: string): string => {
  try {
    const t = (JSON.parse(body) as { event_type?: unknown }).event_type;
    return typeof t === 'string' ? t : '(none)';
  } catch {
    return '(not JSON)';
  }
};

await run(mode === 'tamper' ? 'V8-TAMPER' : 'V8-REPORT', 'SANDBOX', async (r) => {
  const since = sinceArg ? Date.parse(sinceArg) : NaN;
  if (!['report', 'tamper'].includes(mode ?? '') || Number.isNaN(since)) throw new NotReady('usage: node scripts/verify/v8-webhook.ts report|tamper <since ISO time>');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const deliveries = () => db.prepare('SELECT * FROM webhook_deliveries WHERE received_at >= ? ORDER BY received_at, rowid').all(since) as unknown as Delivery[];
  const eventRow = (eventId: string) =>
    db.prepare('SELECT delivery_id, verified_at, processed_at FROM webhook_events WHERE event_id = ?').get(eventId) as { delivery_id: string; verified_at: number; processed_at: number | null } | undefined;

  if (mode === 'report') {
    const all = deliveries();
    r.note('since', new Date(since).toISOString());
    r.note('deliveries', all.length);
    for (const d of all) {
      const ev = d.event_id ? eventRow(d.event_id) : undefined;
      const role = !ev ? 'not registered' : ev.delivery_id === d.id ? (ev.processed_at ? 'registered+processed' : 'registered, not processed') : 'duplicate of a registered event';
      r.say(`${new Date(d.received_at).toISOString()} ${typeOf(d.body)} ${anon('event', d.event_id ?? undefined)} ${d.verify_status} tries=${d.verify_tries} -> ${role}`);
    }
    const verified = all.filter((d) => d.verify_status === 'VERIFIED');
    r.check('at least one delivery from PayPal was VERIFIED by the verify-webhook-signature API', verified.length > 0);
    const ids = [...new Set(verified.map((d) => d.event_id!))];
    r.check('every VERIFIED event is registered exactly once (by one of its VERIFIED deliveries)', ids.every((id) => {
      const ev = eventRow(id);
      return !!ev && verified.some((d) => d.id === ev.delivery_id);
    }));
    r.check('every registered event was processed (used once)', ids.every((id) => !!eventRow(id)?.processed_at));
    const dup = ids.filter((id) => verified.filter((d) => d.event_id === id).length > 1);
    r.note('events_delivered_more_than_once', dup.length);
    r.note('event_types_verified', [...new Set(verified.map((d) => typeOf(d.body)))].sort().join(','));
    r.note('invalid_deliveries', all.filter((d) => d.verify_status === 'INVALID').length);
    r.note('pending_or_error', all.filter((d) => d.verify_status === 'UNVERIFIED' || d.verify_status === 'VERIFY_ERROR').length);
    const audits = (db.prepare("SELECT detail_json FROM audit_log WHERE action = 'WEBHOOK_EVENT' AND created_at >= ?").all(since) as Array<{ detail_json: string }>).map(
      (a) => JSON.parse(a.detail_json) as { type: string; wokenOperations: number },
    );
    r.note('events_used', audits.length);
    r.note('operations_woken', audits.reduce((s, a) => s + a.wokenOperations, 0));
    return;
  }

  // tamper: the latest VERIFIED genuine delivery, body changed, same headers, sent to the local server only.
  const genuine = deliveries().filter((d) => d.verify_status === 'VERIFIED' && d.event_id).at(-1);
  if (!genuine) throw new NotReady('no VERIFIED delivery in the window yet');
  const before = eventRow(genuine.event_id!);
  const changed = JSON.parse(genuine.body) as Record<string, unknown>;
  changed.summary = `${String(changed.summary ?? '')} (tampered by the V8 check)`;
  const headers = { ...(JSON.parse(genuine.headers_json) as Record<string, string>), 'content-type': 'application/json' };
  r.note('tampered_copy_of', `${typeOf(genuine.body)} ${anon('event', genuine.event_id!)}`);
  const sentAt = Date.now();
  const res = await fetch(local, { method: 'POST', headers, body: JSON.stringify(changed) });
  r.check('local server stored the tampered copy (200)', res.status === 200);
  let copy: Delivery | undefined;
  for (let i = 0; i < 40; i++) {
    copy = (db.prepare('SELECT * FROM webhook_deliveries WHERE event_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 1').get(genuine.event_id, sentAt - 1000) as unknown as Delivery | undefined);
    if (copy && copy.verify_status !== 'UNVERIFIED' && copy.verify_status !== 'VERIFY_ERROR') break;
    await new Promise((x) => setTimeout(x, 1000));
  }
  r.check('the tampered copy was verified by PayPal as INVALID', copy?.verify_status === 'INVALID');
  const after = eventRow(genuine.event_id!);
  r.check('the genuine event stays registered and processed once (same delivery, same time)', !!before && !!after && JSON.stringify(before) === JSON.stringify(after));
  db.close();
});
