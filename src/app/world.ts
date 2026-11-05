// Demo worlds (DESIGN 6.1 step 1, D10): one fictional shop per world, with the SPEC 4 sample regenerated relative
// to the demo day (SPEC 4: "future days with the same relative conditions; record the base date").
// A's booking starts unpaid: A pays it on the A screen (Sandbox approval, or the mock approval in mock mode).
// Each role gets an invite token (256-bit, only its SHA-256 is stored, DESIGN 5).

import { createHash, randomBytes } from 'node:crypto';
import { immediate, type Db } from '../db/database.ts';
import type { StructureContext } from '../ai/structure.ts';
import { localInterval, toLocal } from '../time.ts';

export type Role = 'OWNER' | 'A' | 'B';
export const ROLES: readonly Role[] = ['OWNER', 'A', 'B'];
export type AiMode = 'VERTEX' | 'MOCK';
export type PaymentMode = 'SANDBOX' | 'MOCK';

export const WORLD_LIFETIME_MS = 14 * 24 * 3_600_000;

/** SPEC 9 fictional assumptions (not PayPal rates); opportunity loss = 30% x 40.00. */
export const PROFIT_ASSUMPTIONS = {
  bServiceCostMinor: 1500,
  paymentFeesMinor: 250,
  fillProbabilityBasisPoints: 3000,
  marginalProfitMinor: 4000,
  otherIncrementalCostMinor: 0,
} as const;

export const SAMPLE_SHOP = {
  name: 'Flex Salon',
  timeZone: 'Asia/Tokyo',
  currency: 'USD',
  compensationMinor: 1000,
  openMin: 10 * 60,
  closeMin: 18 * 60,
  stylist: 'Mika',
  services: [
    { key: 'cut', name: 'Cut', durationMin: 60, priceMinor: 6000 },
    { key: 'cut-color', name: 'Cut + Color', durationMin: 120, priceMinor: 10000 },
  ],
  /** A's booking: base + 2 days 14:00-15:00, Cut. A's move window in the hint text: base + 5 days 10:00-12:00. */
  aBookingDayOffset: 2,
  aMoveDayOffset: 5,
} as const;

export interface WorldIds {
  worldId: string;
  shopId: string;
  stylistId: string;
  ownerPartyId: string;
  customerAId: string;
  customerBId: string;
  aBookingId: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export function idsFor(worldId: string): WorldIds {
  return {
    worldId,
    shopId: `${worldId}:shop`,
    stylistId: `${worldId}:stylist:mika`,
    ownerPartyId: `${worldId}:owner`,
    customerAId: `${worldId}:customer:a`,
    customerBId: `${worldId}:customer:b`,
    aBookingId: `${worldId}:booking:a`,
  };
}

export function partyFor(ids: WorldIds, role: Role): string {
  return role === 'OWNER' ? ids.ownerPartyId : role === 'A' ? ids.customerAId : ids.customerBId;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Shop-local date (YYYY-MM-DD) of an instant. */
export function localDate(ms: number, timeZone: string): string {
  const l = toLocal(ms, timeZone);
  return `${l.year}-${pad(l.month)}-${pad(l.day)}`;
}

export function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export interface CreatedWorld {
  ids: WorldIds;
  tokens: Record<Role, string>;
  baseDate: string;
}

export function createWorld(
  db: Db,
  now: number,
  o: { aiMode: AiMode; paymentMode: PaymentMode; payeeMerchantId: string; worldId?: string },
): CreatedWorld {
  if (!o.payeeMerchantId) throw new Error('payee merchant id is required (IP1-02)');
  const worldId = o.worldId ?? `w${randomBytes(6).toString('hex')}`;
  const ids = idsFor(worldId);
  const s = SAMPLE_SHOP;
  const baseDate = localDate(now, s.timeZone);
  const aSlot = localInterval(addDays(baseDate, s.aBookingDayOffset), '14:00', '15:00', s.timeZone);
  const tokens = { OWNER: newToken(), A: newToken(), B: newToken() } satisfies Record<Role, string>;
  const expiresAt = now + WORLD_LIFETIME_MS;
  immediate(db, () => {
    db.prepare('INSERT INTO worlds (id, mode_ai, mode_payment, created_at, expires_at, base_local_date) VALUES (?, ?, ?, ?, ?, ?)').run(
      worldId, o.aiMode, o.paymentMode, now, expiresAt, baseDate,
    );
    db.prepare(
      `INSERT INTO shops (id, world_id, name, timezone, currency, compensation_minor, expected_payee_merchant_id, business_open_min, business_close_min,
         profit_assumptions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.shopId, worldId, s.name, s.timeZone, s.currency, s.compensationMinor, o.payeeMerchantId, s.openMin, s.closeMin, JSON.stringify(PROFIT_ASSUMPTIONS));
    db.prepare('INSERT INTO stylists (id, shop_id, name) VALUES (?, ?, ?)').run(ids.stylistId, ids.shopId, s.stylist);
    for (const sv of s.services) {
      db.prepare('INSERT INTO services (id, shop_id, name, duration_min, price_minor) VALUES (?, ?, ?, ?, ?)').run(
        `${worldId}:service:${sv.key}`, ids.shopId, sv.name, sv.durationMin, sv.priceMinor,
      );
    }
    db.prepare('INSERT INTO customers (id, world_id, display_name) VALUES (?, ?, ?)').run(ids.customerAId, worldId, 'Customer A');
    db.prepare('INSERT INTO customers (id, world_id, display_name) VALUES (?, ?, ?)').run(ids.customerBId, worldId, 'Customer B');
    db.prepare(
      `INSERT INTO bookings (id, shop_id, stylist_id, customer_id, service_id, start_ms, end_ms, status, version, price_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 1, ?)`,
    ).run(ids.aBookingId, ids.shopId, ids.stylistId, ids.customerAId, `${worldId}:service:cut`, aSlot.startMs, aSlot.endMs, s.services[0].priceMinor);
    for (const role of ROLES) {
      db.prepare('INSERT INTO invites (token_hash, world_id, role, party_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        sha256(tokens[role]), worldId, role, partyFor(ids, role), expiresAt,
      );
    }
    db.prepare("INSERT INTO audit_log (world_id, case_id, actor, action, detail_json, created_at) VALUES (?, NULL, 'system', 'WORLD_CREATED', ?, ?)").run(
      worldId, JSON.stringify({ aiMode: o.aiMode, paymentMode: o.paymentMode, baseDate }), now,
    );
  });
  return { ids, tokens, baseDate };
}

export interface WorldRow {
  id: string;
  mode_ai: AiMode;
  mode_payment: PaymentMode;
  created_at: number;
  expires_at: number;
  base_local_date: string | null;
}

export interface ShopRow {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  compensation_minor: number;
  expected_payee_merchant_id: string | null;
  business_open_min: number;
  business_close_min: number;
  profit_assumptions_json: string;
}

export interface ServiceRow {
  id: string;
  name: string;
  duration_min: number;
  price_minor: number;
}

export function getWorld(db: Db, worldId: string): WorldRow | undefined {
  return db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId) as WorldRow | undefined;
}

export function shopOf(db: Db, worldId: string): ShopRow {
  return db.prepare('SELECT * FROM shops WHERE world_id = ?').get(worldId) as unknown as ShopRow;
}

export function servicesOf(db: Db, shopId: string): ServiceRow[] {
  return db.prepare('SELECT id, name, duration_min, price_minor FROM services WHERE shop_id = ? ORDER BY price_minor').all(shopId) as unknown as ServiceRow[];
}

export function stylistsOf(db: Db, shopId: string): Array<{ id: string; name: string }> {
  return db.prepare('SELECT id, name FROM stylists WHERE shop_id = ? ORDER BY id').all(shopId) as Array<{ id: string; name: string }>;
}

export const hhmm = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;

/** The AI's context for this world: shop zone, shop-local today, hours, services and stylists (DESIGN 9). */
export function structureContextFor(db: Db, worldId: string, now: number): StructureContext {
  const shop = shopOf(db, worldId);
  return {
    timeZone: shop.timezone,
    today: localDate(now, shop.timezone),
    businessOpen: hhmm(shop.business_open_min),
    businessClose: hhmm(shop.business_close_min),
    services: servicesOf(db, shop.id).map((s) => ({ id: s.id, name: s.name, durationMin: s.duration_min })),
    stylists: stylistsOf(db, shop.id),
  };
}

/** Example texts shown as placeholders, relative to the world's base date (they are only hints). */
export function exampleTexts(baseDate: string): { a: string; b: string } {
  const aDay = addDays(baseDate, SAMPLE_SHOP.aMoveDayOffset);
  const bDay = addDays(baseDate, SAMPLE_SHOP.aBookingDayOffset);
  return {
    a: `I can move to ${aDay} if my cut is done between 10:00 and 12:00.`,
    b: `I need a cut on ${bDay}, and only 14:00-15:00 works for me.`,
  };
}
