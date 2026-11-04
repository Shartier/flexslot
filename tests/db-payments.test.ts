import { describe, expect, it } from 'vitest';
import { immediate, type Db } from '../src/db/database.ts';
import { insertAttempt, insertCase, insertObligation, insertOperation, seeded } from './helpers.ts';

function setUp() {
  const { db, ids } = seeded();
  const termsHash = insertCase(db, ids, { id: 'C7', status: 'PAYMENT_STARTED', version: 3 });
  return { db, ids, termsHash };
}

const setOp = (db: Db, id: string, fields: Record<string, string | number | null>) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE payment_operations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => fields[k] ?? null),
    id,
  );
};

describe('compensation grants (AC14)', () => {
  it('allow one compensation per booking, across cases', () => {
    const { db, ids } = seeded();
    insertCase(db, ids, { id: 'C1', status: 'COMPLETED' });
    insertCase(db, ids, { id: 'C2' });
    const grant = db.prepare('INSERT INTO compensation_grants (booking_id, case_id, granted_at) VALUES (?, ?, 1)');
    grant.run(ids.aBookingId, 'C1');
    expect(() => grant.run(ids.aBookingId, 'C2')).toThrow(/UNIQUE constraint failed: compensation_grants\.booking_id/);
  });
});

describe('money obligations', () => {
  it('are unique per case and kind, start OPEN, and keep their amount', () => {
    const { db } = setUp();
    insertObligation(db, { id: 'OB1', caseId: 'C7', kind: 'B_CHARGE', amount: 6000 });
    expect(() => insertObligation(db, { id: 'OB2', caseId: 'C7', kind: 'B_CHARGE', amount: 6000 })).toThrow(
      /UNIQUE constraint failed: money_obligations\.case_id, money_obligations\.kind/,
    );
    expect(() =>
      db.prepare("INSERT INTO money_obligations (id, case_id, kind, amount_minor, currency, status) VALUES ('OB3', 'C7', 'B_AUTH_VOID', 6000, 'USD', 'CANCELLED')").run(),
    ).toThrow('OBLIGATION_MUST_START_OPEN');
    expect(() => db.prepare("UPDATE money_obligations SET amount_minor = 7000 WHERE id = 'OB1'").run()).toThrow('OBLIGATION_IMMUTABLE');
    expect(() => db.prepare("UPDATE money_obligations SET currency = 'JPY' WHERE id = 'OB1'").run()).toThrow('OBLIGATION_IMMUTABLE');
    // SETTLED needs the operation that settled it.
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED' WHERE id = 'OB1'").run()).toThrow(/CHECK constraint failed/);
  });
});

describe('payment attempts', () => {
  it('allow one unfinished and one successful attempt per obligation; a new attempt only after a failure', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB-A', caseId: 'C7', kind: 'A_COMPENSATION_REFUND', amount: 1000, target: 'CAP-A' });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB-A', termsHash });
    expect(() => insertAttempt(db, { id: 'AT2', obligationId: 'OB-A', attemptNo: 2, previous: 'AT1', termsHash })).toThrow(
      /UNIQUE constraint failed: payment_attempts\.obligation_id/,
    );

    db.prepare("UPDATE payment_attempts SET status = 'FAILED' WHERE id = 'AT1'").run();
    insertAttempt(db, { id: 'AT2', obligationId: 'OB-A', attemptNo: 2, previous: 'AT1', termsHash });
    db.prepare("UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = 'AT2'").run();

    // A third attempt can be opened (none unfinished) but can never also succeed.
    insertAttempt(db, { id: 'AT3', obligationId: 'OB-A', attemptNo: 3, previous: 'AT2', termsHash });
    expect(() => db.prepare("UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = 'AT3'").run()).toThrow(
      /UNIQUE constraint failed: payment_attempts\.obligation_id/,
    );
  });

  it('link every later attempt to the previous one', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB-A', caseId: 'C7', kind: 'A_COMPENSATION_REFUND', amount: 1000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB-A', status: 'FAILED', termsHash });
    expect(() => insertAttempt(db, { id: 'AT2', obligationId: 'OB-A', attemptNo: 2, previous: null, termsHash })).toThrow(/CHECK constraint failed/);
    expect(() => insertAttempt(db, { id: 'AT2', obligationId: 'OB-A', attemptNo: 1, previous: 'AT1', termsHash })).toThrow(/CHECK constraint failed/);
  });
});

describe('payment operations: DESIGN 7.5 B_CHARGE example', () => {
  it('stores order create, authorize and capture as separate succeeded operations of one attempt', () => {
    const { db, termsHash } = setUp();

    // E1: obligation, attempt and the first operation in one transaction.
    immediate(db, () => {
      insertObligation(db, { id: 'OB1', caseId: 'C7', kind: 'B_CHARGE', amount: 6000 });
      insertAttempt(db, { id: 'AT1', obligationId: 'OB1', termsHash, caseVersion: 3 });
      insertOperation(db, { id: 'OP1', attemptId: 'AT1', kind: 'ORDER_CREATE' });
    });

    // E2: OP1 is sent; while it is unconfirmed no second operation may exist in the attempt.
    setOp(db, 'OP1', { status: 'SENDING', sends: 1 });
    expect(() => insertOperation(db, { id: 'OP2', attemptId: 'AT1', kind: 'ORDER_AUTHORIZE', target: 'O1', status: 'SENDING' })).toThrow(
      /UNIQUE constraint failed: payment_operations\.attempt_id$/,
    );
    immediate(db, () => {
      setOp(db, 'OP1', { status: 'SUCCEEDED', result_external_id: 'O1', external_status: 'CREATED' });
      db.prepare("UPDATE payment_attempts SET status = 'ORDER_CREATED' WHERE id = 'AT1'").run();
    });
    // Order creation does not settle B_CHARGE.
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'OP1' WHERE id = 'OB1'").run()).toThrow(
      'SETTLEMENT_MISMATCH',
    );

    // E4: authorize.
    insertOperation(db, { id: 'OP2', attemptId: 'AT1', kind: 'ORDER_AUTHORIZE', target: 'O1', status: 'SENDING' });
    immediate(db, () => {
      setOp(db, 'OP2', { status: 'SUCCEEDED', result_external_id: 'U1', external_status: 'CREATED' });
      db.prepare("UPDATE payment_attempts SET status = 'AUTHORIZED' WHERE id = 'AT1'").run();
    });
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'OP2' WHERE id = 'OB1'").run()).toThrow(
      'SETTLEMENT_MISMATCH',
    );

    // E6: the capture POST succeeded, but it settles the obligation only once reconciled (D20, IP1-04).
    insertOperation(db, { id: 'OP3', attemptId: 'AT1', kind: 'AUTH_CAPTURE', target: 'U1', status: 'SENDING' });
    setOp(db, 'OP3', { status: 'SUCCEEDED', result_external_id: 'C1', external_status: 'COMPLETED', reconcile_status: 'AWAITING' });
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'OP3' WHERE id = 'OB1'").run()).toThrow(
      'SETTLEMENT_MISMATCH',
    );
    immediate(db, () => {
      setOp(db, 'OP3', { reconcile_status: 'MATCHED', reconciled_at: 1 });
      db.prepare("UPDATE payment_attempts SET status = 'CAPTURED' WHERE id = 'AT1'").run();
      db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'OP3' WHERE id = 'OB1'").run();
    });

    expect(db.prepare('SELECT id, kind, amount_minor, status, settled_by_operation_id FROM money_obligations').all()).toEqual([
      { id: 'OB1', kind: 'B_CHARGE', amount_minor: 6000, status: 'SETTLED', settled_by_operation_id: 'OP3' },
    ]);
    expect(db.prepare('SELECT id, attempt_no, case_version, status FROM payment_attempts').all()).toEqual([
      { id: 'AT1', attempt_no: 1, case_version: 3, status: 'CAPTURED' },
    ]);
    const ops = db
      .prepare('SELECT id, op_kind, op_seq, target_external_id, paypal_request_id, result_external_id, external_status, status FROM payment_operations ORDER BY id')
      .all();
    expect(ops).toEqual([
      { id: 'OP1', op_kind: 'ORDER_CREATE', op_seq: 1, target_external_id: null, paypal_request_id: 'rid-OP1', result_external_id: 'O1', external_status: 'CREATED', status: 'SUCCEEDED' },
      { id: 'OP2', op_kind: 'ORDER_AUTHORIZE', op_seq: 1, target_external_id: 'O1', paypal_request_id: 'rid-OP2', result_external_id: 'U1', external_status: 'CREATED', status: 'SUCCEEDED' },
      { id: 'OP3', op_kind: 'AUTH_CAPTURE', op_seq: 1, target_external_id: 'U1', paypal_request_id: 'rid-OP3', result_external_id: 'C1', external_status: 'COMPLETED', status: 'SUCCEEDED' },
    ]);
    const hashes = db.prepare('SELECT DISTINCT request_hash FROM payment_operations').all();
    expect(hashes).toHaveLength(3);

    // A settled obligation stays settled by the same operation.
    expect(() => db.prepare("UPDATE money_obligations SET status = 'OPEN', settled_by_operation_id = NULL WHERE id = 'OB1'").run()).toThrow(
      'OBLIGATION_SETTLED',
    );
  });

  it('rejects a second succeeded operation of the same kind in an attempt', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB1', caseId: 'C7', kind: 'B_CHARGE', amount: 6000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB1', termsHash });
    insertOperation(db, { id: 'OP1', attemptId: 'AT1', kind: 'ORDER_CREATE', status: 'SUCCEEDED' });
    insertOperation(db, { id: 'OP2', attemptId: 'AT1', kind: 'ORDER_AUTHORIZE', target: 'O1', status: 'SUCCEEDED' });
    expect(() =>
      insertOperation(db, { id: 'OP2b', attemptId: 'AT1', kind: 'ORDER_AUTHORIZE', seq: 2, previous: 'OP2', target: 'O1', status: 'SUCCEEDED' }),
    ).toThrow(/UNIQUE constraint failed: payment_operations\.attempt_id, payment_operations\.op_kind$/);
  });

  it('rejects a second unconfirmed operation (PREPARED, SENDING, UNKNOWN or PENDING) in an attempt', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB1', caseId: 'C7', kind: 'B_CHARGE', amount: 6000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB1', termsHash });
    insertOperation(db, { id: 'OP1', attemptId: 'AT1', kind: 'ORDER_CREATE', status: 'UNKNOWN' });
    for (const status of ['PREPARED', 'SENDING', 'UNKNOWN', 'PENDING']) {
      expect(() => insertOperation(db, { id: `X-${status}`, attemptId: 'AT1', kind: 'ORDER_AUTHORIZE', status })).toThrow(
        /UNIQUE constraint failed: payment_operations\.attempt_id$/,
      );
    }
  });

  it('allows a new operation of the same kind only as the next op_seq, with a new request id', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB-A', caseId: 'C7', kind: 'A_COMPENSATION_REFUND', amount: 1000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB-A', termsHash });
    insertOperation(db, { id: 'R1', attemptId: 'AT1', kind: 'CAPTURE_REFUND', status: 'NOT_ACCEPTED' });
    expect(() => insertOperation(db, { id: 'R2', attemptId: 'AT1', kind: 'CAPTURE_REFUND', seq: 2, previous: 'R1', requestId: 'rid-R1' })).toThrow(
      /UNIQUE constraint failed: payment_operations\.paypal_request_id/,
    );
    expect(() => insertOperation(db, { id: 'R2', attemptId: 'AT1', kind: 'CAPTURE_REFUND', seq: 1, previous: null })).toThrow(
      /UNIQUE constraint failed: payment_operations\.attempt_id, payment_operations\.op_kind, payment_operations\.op_seq/,
    );
    expect(() => insertOperation(db, { id: 'R2', attemptId: 'AT1', kind: 'CAPTURE_REFUND', seq: 2, previous: null })).toThrow(/CHECK constraint failed/);
    insertOperation(db, { id: 'R2', attemptId: 'AT1', kind: 'CAPTURE_REFUND', seq: 2, previous: 'R1' });
  });

  it('lets one operation settle at most one obligation', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB-A', caseId: 'C7', kind: 'A_COMPENSATION_REFUND', amount: 1000 });
    insertObligation(db, { id: 'OB-R', caseId: 'C7', kind: 'B_RECOVERY_REFUND', amount: 6000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB-A', termsHash });
    insertOperation(db, { id: 'R1', attemptId: 'AT1', kind: 'CAPTURE_REFUND', status: 'SUCCEEDED' });
    db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'R1' WHERE id = 'OB-A'").run();
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'R1' WHERE id = 'OB-R'").run()).toThrow(
      /UNIQUE constraint failed: money_obligations\.settled_by_operation_id/,
    );
  });

  it('refuses settlement by an operation that has not succeeded', () => {
    const { db, termsHash } = setUp();
    insertObligation(db, { id: 'OB-A', caseId: 'C7', kind: 'A_COMPENSATION_REFUND', amount: 1000 });
    insertAttempt(db, { id: 'AT1', obligationId: 'OB-A', termsHash });
    insertOperation(db, { id: 'R1', attemptId: 'AT1', kind: 'CAPTURE_REFUND', status: 'PENDING' });
    expect(() => db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = 'R1' WHERE id = 'OB-A'").run()).toThrow(
      'SETTLEMENT_MISMATCH',
    );
  });
});
