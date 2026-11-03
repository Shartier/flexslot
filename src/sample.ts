// SPEC 4 sample (fictional values). Mock mode only: the A payment below is a mock capture, not a Sandbox one.
// Dates are the fixed SPEC values; regenerating them relative to the demo day is a later step.

import { immediate, type Db } from './db/database.ts';
import { localInterval, localToUtcMs } from './time.ts';

export const SAMPLE = {
  shop: {
    name: 'Flex Salon',
    timeZone: 'Asia/Tokyo',
    currency: 'USD',
    compensationMinor: 1000,
    businessOpenMinute: 10 * 60,
    businessCloseMinute: 18 * 60,
  },
  stylistName: 'Mika',
  services: {
    cut: { name: 'Cut', durationMin: 60, priceMinor: 6000 },
    cutColor: { name: 'Cut + Color', durationMin: 120, priceMinor: 10000 },
  },
  aBooking: { date: '2026-11-07', start: '14:00', end: '15:00' },
  aPreferenceWindow: { date: '2026-11-10', start: '10:00', end: '12:00' },
  bRequestWindow: { date: '2026-11-07', start: '14:00', end: '15:00' },
} as const;

export interface SampleWorldIds {
  worldId: string;
  shopId: string;
  stylistId: string;
  cutServiceId: string;
  cutColorServiceId: string;
  customerAId: string;
  customerBId: string;
  aBookingId: string;
  aPaymentId: string;
  aPreferenceId: string;
  bRequestId: string;
}

/** Inserts the SPEC 4 world in mock mode, in one transaction. Ids are prefixed with worldId. */
export function seedSampleWorld(db: Db, worldId: string, nowMs: number): SampleWorldIds {
  const tz = SAMPLE.shop.timeZone;
  const ids: SampleWorldIds = {
    worldId,
    shopId: `${worldId}:shop`,
    stylistId: `${worldId}:stylist:mika`,
    cutServiceId: `${worldId}:service:cut`,
    cutColorServiceId: `${worldId}:service:cut-color`,
    customerAId: `${worldId}:customer:a`,
    customerBId: `${worldId}:customer:b`,
    aBookingId: `${worldId}:booking:a`,
    aPaymentId: `${worldId}:payment:a`,
    aPreferenceId: `${worldId}:preference:a:1`,
    bRequestId: `${worldId}:request:b`,
  };
  const aSlot = localInterval(SAMPLE.aBooking.date, SAMPLE.aBooking.start, SAMPLE.aBooking.end, tz);
  const w = SAMPLE.aPreferenceWindow;
  const r = SAMPLE.bRequestWindow;

  immediate(db, () => {
    db.prepare('INSERT INTO worlds (id, mode_ai, mode_payment, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      worldId, 'MOCK', 'MOCK', nowMs, nowMs + 30 * 24 * 3_600_000,
    );
    db.prepare(
      `INSERT INTO shops (id, world_id, name, timezone, currency, compensation_minor, expected_payee_merchant_id,
         business_open_min, business_close_min) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      ids.shopId, worldId, SAMPLE.shop.name, tz, SAMPLE.shop.currency, SAMPLE.shop.compensationMinor,
      SAMPLE.shop.businessOpenMinute, SAMPLE.shop.businessCloseMinute,
    );
    db.prepare('INSERT INTO stylists (id, shop_id, name) VALUES (?, ?, ?)').run(ids.stylistId, ids.shopId, SAMPLE.stylistName);
    const insertService = db.prepare('INSERT INTO services (id, shop_id, name, duration_min, price_minor) VALUES (?, ?, ?, ?, ?)');
    for (const [id, s] of [
      [ids.cutServiceId, SAMPLE.services.cut],
      [ids.cutColorServiceId, SAMPLE.services.cutColor],
    ] as const) {
      insertService.run(id, ids.shopId, s.name, s.durationMin, s.priceMinor);
    }
    const insertCustomer = db.prepare('INSERT INTO customers (id, world_id, display_name) VALUES (?, ?, ?)');
    insertCustomer.run(ids.customerAId, worldId, 'Customer A');
    insertCustomer.run(ids.customerBId, worldId, 'Customer B');
    db.prepare(
      `INSERT INTO bookings (id, shop_id, stylist_id, customer_id, service_id, start_ms, end_ms, status, version, price_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 1, ?)`,
    ).run(
      ids.aBookingId, ids.shopId, ids.stylistId, ids.customerAId, ids.cutServiceId, aSlot.startMs, aSlot.endMs,
      SAMPLE.services.cut.priceMinor,
    );
    db.prepare(
      `INSERT INTO payments (id, booking_id, kind, order_id, capture_id, amount_minor, currency, payee_merchant_id,
         status_raw, verified_at) VALUES (?, ?, 'A_ORIGINAL', ?, ?, ?, ?, NULL, 'COMPLETED', ?)`,
    ).run(
      ids.aPaymentId, ids.aBookingId, `MOCK-ORDER-${worldId}-A`, `MOCK-CAPTURE-${worldId}-A`,
      SAMPLE.services.cut.priceMinor, SAMPLE.shop.currency, nowMs,
    );
    db.prepare(
      `INSERT INTO flex_preferences (id, booking_id, version, raw_text, structured_json, input_source, confirmed_at,
         compensation_minor) VALUES (?, ?, 1, ?, ?, 'MANUAL', ?, ?)`,
    ).run(
      ids.aPreferenceId, ids.aBookingId, `I can move to ${w.date} if I finish between ${w.start} and ${w.end}.`,
      JSON.stringify({ windows: [{ date: w.date, start: w.start, end: w.end }], sameStylist: true, sameService: true }),
      nowMs, SAMPLE.shop.compensationMinor,
    );
    db.prepare(
      `INSERT INTO b_requests (id, world_id, customer_id, version, raw_text, structured_json, input_source, confirmed_at)
       VALUES (?, ?, ?, 1, ?, ?, 'MANUAL', ?)`,
    ).run(
      ids.bRequestId, worldId, ids.customerBId, `Only ${r.date} ${r.start}-${r.end} works for me.`,
      JSON.stringify({ serviceId: ids.cutServiceId, windows: [{ date: r.date, start: r.start, end: r.end }] }),
      nowMs,
    );
  });
  return ids;
}

/** SPEC 4 reference instant used by tests: 2026-11-03 12:00 in the shop's zone. */
export const SAMPLE_NOW_MS = localToUtcMs('2026-11-03', '12:00', SAMPLE.shop.timeZone);
