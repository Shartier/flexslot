import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { immediate, isSchemaRaise, openDatabase } from '../src/db/database.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { SAMPLE_NOW_MS, seedSampleWorld } from '../src/sample.ts';
import { insertCase, seeded, sha256 } from './helpers.ts';

// a_payment_operations: A's original payment per operation (STATUS I08, schema version 2).
// ai_calls, intake_drafts, candidate_evaluations: AI adapter and screens (DESIGN 14.4-14.5, schema version 3).
const DESIGN_3_TABLES = [
  'a_payment_operations',
  'ai_calls',
  'approvals',
  'audit_log',
  'b_requests',
  'bookings',
  'candidate_evaluations',
  'compensation_grants',
  'customers',
  'flex_preferences',
  'intake_drafts',
  'invites',
  'money_obligations',
  'payment_attempts',
  'payment_operations',
  'payments',
  'services',
  'sessions',
  'shops',
  'slot_holds',
  'stylists',
  'swap_cases',
  'webhook_deliveries',
  'webhook_events',
  'worlds',
];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('schema', () => {
  it('creates every DESIGN 3 table', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(DESIGN_3_TABLES);
  });

  it('opens a file database in WAL mode with foreign keys, and keeps data across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flexslot-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'flexslot.sqlite');

    const first = openDatabase(path);
    expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(first.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(first.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    seedSampleWorld(first, 'w1', SAMPLE_NOW_MS);
    first.close();

    const second = openDatabase(path);
    expect(second.prepare('SELECT count(*) AS n FROM bookings').get()).toEqual({ n: 1 });
    second.close();
  });

  it('stores money as integers only (STRICT tables)', () => {
    const { db, ids } = seeded();
    expect(() =>
      db.prepare("INSERT INTO services (id, shop_id, name, duration_min, price_minor) VALUES ('s3', ?, 'x', 30, 60.5)").run(ids.shopId),
    ).toThrow(/cannot store REAL value in INTEGER column/);
  });

  it('enforces foreign keys', () => {
    const { db, ids } = seeded();
    expect(() =>
      db.prepare(
        `INSERT INTO bookings (id, shop_id, stylist_id, customer_id, service_id, start_ms, end_ms, status, price_minor)
         VALUES ('b9', ?, 'no-such-stylist', ?, ?, 1, 2, 'CONFIRMED', 0)`,
      ).run(ids.shopId, ids.customerBId, ids.cutServiceId),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('fixes AI and payment modes when the world is created', () => {
    const { db, ids } = seeded();
    const update = () => db.prepare("UPDATE worlds SET mode_payment = 'SANDBOX' WHERE id = ?").run(ids.worldId);
    expect(update).toThrow('MODE_IMMUTABLE');
    expect(() => db.prepare("UPDATE worlds SET mode_ai = 'VERTEX' WHERE id = ?").run(ids.worldId)).toThrow('MODE_IMMUTABLE');
  });

  it('keeps one approval per case, role and terms hash', () => {
    const { db, ids } = seeded();
    const hash = insertCase(db, ids, { id: 'C1' });
    const approve = db.prepare(
      "INSERT INTO approvals (case_id, role, party_id, terms_hash, decision, decided_at) VALUES ('C1', 'A', ?, ?, 'APPROVED', 1)",
    );
    approve.run(ids.customerAId, hash);
    expect(() => approve.run(ids.customerAId, hash)).toThrow(/UNIQUE constraint failed: approvals\.case_id, approvals\.role, approvals\.terms_hash/);
    // A new terms hash (new version) needs a new approval and is accepted.
    approve.run(ids.customerAId, sha256('v2'));
  });

  it('keeps one preference row per booking and version', () => {
    const { db, ids } = seeded();
    expect(() =>
      db.prepare(
        `INSERT INTO flex_preferences (id, booking_id, version, raw_text, structured_json, input_source, compensation_minor)
         VALUES ('p-dup', ?, 1, 'x', '{}', 'MANUAL', 1000)`,
      ).run(ids.aBookingId),
    ).toThrow(/UNIQUE constraint failed: flex_preferences\.booking_id, flex_preferences\.version/);
  });

  it('registers webhook events only from VERIFIED deliveries, once per event_id', () => {
    const { db } = seeded();
    const deliver = db.prepare(
      `INSERT INTO webhook_deliveries (id, received_at, event_id, transmission_id, body_sha256, headers_json, body, verify_status)
       VALUES (?, 1, 'EV-1', ?, ?, '{}', '{}', ?)`,
    );
    // The same event_id may arrive many times (a forged copy first, then the genuine one twice).
    deliver.run('d-forged', 't1', sha256('forged'), 'INVALID');
    deliver.run('d-real', 't2', sha256('{}'), 'VERIFIED');
    deliver.run('d-real-again', 't3', sha256('{}'), 'VERIFIED');
    const register = db.prepare("INSERT INTO webhook_events (event_id, delivery_id, verified_at) VALUES ('EV-1', ?, 2)");
    expect(() => register.run('d-forged')).toThrow('DELIVERY_NOT_VERIFIED');
    register.run('d-real');
    expect(() => register.run('d-real-again')).toThrow(/UNIQUE constraint failed: webhook_events\.event_id/);
  });
});

describe('immediate()', () => {
  it('commits when the callback returns', () => {
    const { db, ids } = seeded();
    immediate(db, () => db.prepare("UPDATE shops SET name = 'Renamed' WHERE id = ?").run(ids.shopId));
    expect(db.prepare('SELECT name FROM shops').get()).toEqual({ name: 'Renamed' });
  });

  it('rolls back every statement when a later one fails', () => {
    const { db, ids } = seeded();
    expect(() =>
      immediate(db, () => {
        db.prepare("UPDATE shops SET name = 'Renamed' WHERE id = ?").run(ids.shopId);
        db.prepare("UPDATE worlds SET mode_payment = 'SANDBOX'").run();
      }),
    ).toThrow('MODE_IMMUTABLE');
    expect(db.isTransaction).toBe(false);
    expect(db.prepare('SELECT name FROM shops').get()).toEqual({ name: 'Flex Salon' });
  });

  it('refuses to nest and refuses async callbacks', () => {
    const { db, ids } = seeded();
    expect(() => immediate(db, () => immediate(db, () => 1))).toThrow(/does not nest/);
    expect(() =>
      immediate(db, async () => {
        db.prepare("UPDATE shops SET name = 'Async' WHERE id = ?").run(ids.shopId);
      }),
    ).toThrow(/must be synchronous/);
    expect(db.prepare('SELECT name FROM shops').get()).toEqual({ name: 'Flex Salon' });
  });

  it('exposes trigger errors by code', () => {
    const { db } = seeded();
    try {
      db.prepare("UPDATE worlds SET mode_ai = 'VERTEX'").run();
      expect.unreachable();
    } catch (error) {
      expect(isSchemaRaise(error, 'MODE_IMMUTABLE')).toBe(true);
      expect(isSchemaRaise(error, 'SLOT_CONFLICT')).toBe(false);
    }
  });
});
