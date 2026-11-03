import { describe, expect, it } from 'vitest';
import { immediate, isSlotConflict, type Db } from '../src/db/database.ts';
import { SAMPLE_NOW_MS } from '../src/sample.ts';
import { at, insertBooking, insertCase, insertHold, insertStylist, seeded } from './helpers.ts';

// The sample A booking occupies Mika on 2026-11-07 14:00-15:00 (Asia/Tokyo).
const D = '2026-11-07';

function expectSlotConflict(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isSlotConflict(caught), `expected SLOT_CONFLICT, got ${String(caught)}`).toBe(true);
}

const count = (db: Db, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('bookings: SLOT_CONFLICT on INSERT', () => {
  it('rejects an overlapping booking for the same stylist', () => {
    const { db, ids } = seeded();
    expectSlotConflict(() => insertBooking(db, ids, { id: 'b1', start: at(D, '14:30'), end: at(D, '15:30') }));
    expectSlotConflict(() => insertBooking(db, ids, { id: 'b2', start: at(D, '13:00'), end: at(D, '16:00') }));
    expect(count(db, 'SELECT count(*) AS n FROM bookings')).toBe(1);
  });

  it('allows adjacent bookings (end == start)', () => {
    const { db, ids } = seeded();
    insertBooking(db, ids, { id: 'before', start: at(D, '13:00'), end: at(D, '14:00') });
    insertBooking(db, ids, { id: 'after', start: at(D, '15:00'), end: at(D, '16:00') });
    expect(count(db, 'SELECT count(*) AS n FROM bookings')).toBe(3);
  });

  it('allows the same time for another stylist, and cancelled rows do not block or get checked', () => {
    const { db, ids } = seeded();
    insertStylist(db, ids, 'other');
    insertBooking(db, ids, { id: 'other-stylist', start: at(D, '14:00'), end: at(D, '15:00'), stylistId: 'other' });
    insertBooking(db, ids, { id: 'cancelled', start: at(D, '14:00'), end: at(D, '15:00'), status: 'CANCELLED' });
    db.prepare("UPDATE bookings SET status = 'CANCELLED' WHERE id = ?").run(ids.aBookingId);
    insertBooking(db, ids, { id: 'reuse', start: at(D, '14:00'), end: at(D, '15:00') });
  });
});

describe('bookings: SLOT_CONFLICT on UPDATE of time, stylist or status', () => {
  it('rejects moving a booking onto another', () => {
    const { db, ids } = seeded();
    insertBooking(db, ids, { id: 'b1', start: at(D, '16:00'), end: at(D, '17:00') });
    expectSlotConflict(() =>
      db.prepare('UPDATE bookings SET start_ms = ?, end_ms = ? WHERE id = ?').run(at(D, '14:30'), at(D, '15:30'), 'b1'),
    );
    expect(db.prepare("SELECT start_ms FROM bookings WHERE id = 'b1'").get()).toEqual({ start_ms: at(D, '16:00') });
  });

  it('excludes the row itself: shifting a booking over its own old time is allowed', () => {
    const { db, ids } = seeded();
    db.prepare('UPDATE bookings SET start_ms = ?, end_ms = ? WHERE id = ?').run(at(D, '14:30'), at(D, '15:30'), ids.aBookingId);
    expect(db.prepare('SELECT start_ms, end_ms FROM bookings').get()).toEqual({ start_ms: at(D, '14:30'), end_ms: at(D, '15:30') });
  });

  it('rejects re-confirming a cancelled booking that now overlaps', () => {
    const { db, ids } = seeded();
    insertBooking(db, ids, { id: 'old', start: at(D, '14:00'), end: at(D, '15:00'), status: 'CANCELLED' });
    expectSlotConflict(() => db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = 'old'").run());
  });

  it('rejects changing the stylist into a conflict', () => {
    const { db, ids } = seeded();
    insertStylist(db, ids, 'other');
    insertBooking(db, ids, { id: 'b1', start: at(D, '14:00'), end: at(D, '15:00'), stylistId: 'other' });
    expectSlotConflict(() => db.prepare('UPDATE bookings SET stylist_id = ? WHERE id = ?').run(ids.stylistId, 'b1'));
  });

  it('does not re-check updates of other columns', () => {
    const { db, ids } = seeded();
    db.prepare('UPDATE bookings SET price_minor = 6500, version = version + 1 WHERE id = ?').run(ids.aBookingId);
  });
});

describe('slot holds share the overlap rule', () => {
  const dest = { start: at('2026-11-10', '10:00'), end: at('2026-11-10', '11:00') };

  it('rejects a hold overlapping a confirmed booking, allows an adjacent one', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1' });
    expectSlotConflict(() => insertHold(db, ids, { id: 'h1', caseId: 'C1', start: at(D, '14:30'), end: at(D, '15:30') }));
    insertHold(db, ids, { id: 'h2', caseId: 'C1', start: at(D, '15:00'), end: at(D, '16:00') });
  });

  it('rejects bookings over ACTIVE and FROZEN holds, not over RELEASED or CONVERTED ones', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1' });
    insertHold(db, ids, { id: 'h', caseId: 'C1', ...dest, status: 'ACTIVE' });
    expectSlotConflict(() => insertBooking(db, ids, { id: 'b1', ...dest }));
    db.prepare("UPDATE slot_holds SET status = 'FROZEN' WHERE id = 'h'").run();
    expectSlotConflict(() => insertBooking(db, ids, { id: 'b1', ...dest }));
    db.prepare("UPDATE slot_holds SET status = 'RELEASED' WHERE id = 'h'").run();
    insertBooking(db, ids, { id: 'b1', ...dest });
  });

  it('rejects overlapping holds, and re-activating a released hold into a conflict', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1' });
    insertHold(db, ids, { id: 'h1', caseId: 'C1', ...dest });
    expectSlotConflict(() => insertHold(db, ids, { id: 'h2', caseId: 'C1', start: at('2026-11-10', '10:30'), end: at('2026-11-10', '11:30') }));
    insertHold(db, ids, { id: 'h3', caseId: 'C1', ...dest, status: 'RELEASED' });
    expectSlotConflict(() => db.prepare("UPDATE slot_holds SET status = 'ACTIVE' WHERE id = 'h3'").run());
    // Moving the hold itself over its own old time is fine; moving it onto the booking is not.
    db.prepare('UPDATE slot_holds SET start_ms = ?, end_ms = ? WHERE id = ?').run(at('2026-11-10', '10:30'), at('2026-11-10', '11:30'), 'h1');
    expectSlotConflict(() => db.prepare('UPDATE slot_holds SET start_ms = ?, end_ms = ? WHERE id = ?').run(at(D, '14:00'), at(D, '15:00'), 'h1'));
  });

  it('does not lapse ACTIVE holds by time inside the DB (the app releases them first, DESIGN 4.3)', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1' });
    insertHold(db, ids, { id: 'h', caseId: 'C1', ...dest, expiresAt: SAMPLE_NOW_MS - 1 });
    expectSlotConflict(() => insertBooking(db, ids, { id: 'b1', ...dest }));
  });
});

describe('swap cases: one in-progress case per A booking', () => {
  it('rejects a second in-progress case and allows a new one after the first ends', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1' });
    expect(() => insertCase(db, ids, { id: 'C2' })).toThrow(/UNIQUE constraint failed: swap_cases\.a_booking_id/);
    expect(() => insertCase(db, ids, { id: 'C2', status: 'PAYMENT_STARTED' })).toThrow(/UNIQUE constraint failed/);
    db.prepare("UPDATE swap_cases SET status = 'REJECTED' WHERE id = 'C1'").run();
    insertCase(db, ids, { id: 'C2' });
    insertCase(db, ids, { id: 'C0', status: 'EXPIRED' });
  });
});

describe('E7 booking commit (DESIGN 4.4, 6.2)', () => {
  const dest = { start: at('2026-11-10', '10:00'), end: at('2026-11-10', '11:00') };
  const origin = { start: at(D, '14:00'), end: at(D, '15:00') };

  function setUp() {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1', status: 'CAPTURED' });
    insertHold(db, ids, { id: 'h', caseId: 'C1', ...dest, status: 'FROZEN' });
    return { db, ids };
  }

  function e7(db: Db, ids: ReturnType<typeof seeded>['ids'], opts: { convertHold?: boolean } = {}) {
    immediate(db, () => {
      if (opts.convertHold ?? true) db.prepare("UPDATE slot_holds SET status = 'CONVERTED' WHERE id = 'h'").run();
      db.prepare('UPDATE bookings SET start_ms = ?, end_ms = ?, version = version + 1 WHERE id = ? AND version = 1').run(
        dest.start, dest.end, ids.aBookingId,
      );
      insertBooking(db, ids, { id: 'b-booking', ...origin });
      db.prepare("INSERT INTO compensation_grants (booking_id, case_id, granted_at) VALUES (?, 'C1', ?)").run(ids.aBookingId, SAMPLE_NOW_MS);
      db.prepare(
        "INSERT INTO money_obligations (id, case_id, kind, amount_minor, currency, target_external_id, status) VALUES ('OB-A', 'C1', 'A_COMPENSATION_REFUND', 1000, 'USD', ?, 'OPEN')",
      ).run(`MOCK-CAPTURE-${ids.worldId}-A`);
      db.prepare("UPDATE swap_cases SET status = 'BOOKING_COMMITTED' WHERE id = 'C1' AND status = 'CAPTURED'").run();
    });
  }

  function snapshot(db: Db) {
    return {
      bookings: db.prepare('SELECT id, start_ms, end_ms, version FROM bookings ORDER BY start_ms').all(),
      hold: db.prepare("SELECT status FROM slot_holds WHERE id = 'h'").get(),
      grants: count(db, 'SELECT count(*) AS n FROM compensation_grants'),
      obligations: count(db, 'SELECT count(*) AS n FROM money_obligations'),
      caseStatus: db.prepare("SELECT status FROM swap_cases WHERE id = 'C1'").get(),
    };
  }

  it('commits: hold CONVERTED -> A moved -> B in the original slot, with the grant and the A refund obligation', () => {
    const { db, ids } = setUp();
    e7(db, ids);
    expect(snapshot(db)).toEqual({
      bookings: [
        { id: 'b-booking', start_ms: origin.start, end_ms: origin.end, version: 1 },
        { id: ids.aBookingId, start_ms: dest.start, end_ms: dest.end, version: 2 },
      ],
      hold: { status: 'CONVERTED' },
      grants: 1,
      obligations: 1,
      caseStatus: { status: 'BOOKING_COMMITTED' },
    });
  });

  it('rolls back everything when a statement in the middle fails (SLOT_CONFLICT)', () => {
    const { db, ids } = setUp();
    const before = snapshot(db);
    // Without converting the hold first, moving A onto the destination hits the FROZEN hold.
    expectSlotConflict(() => e7(db, ids, { convertHold: false }));
    expect(snapshot(db)).toEqual(before);
  });

  it('rolls back everything when the compensation grant insert fails (duplicate compensation, AC14)', () => {
    const { db, ids } = setUp();
    // An earlier, finished case already used A's one compensation.
    insertCase(db, ids, { id: 'C0', status: 'COMPLETED' });
    db.prepare("INSERT INTO compensation_grants (booking_id, case_id, granted_at) VALUES (?, 'C0', 1)").run(ids.aBookingId);
    const before = snapshot(db);
    expect(() => e7(db, ids)).toThrow(/UNIQUE constraint failed: compensation_grants\.booking_id/);
    expect(snapshot(db)).toEqual(before);
    expect(before.hold).toEqual({ status: 'FROZEN' });
  });
});
