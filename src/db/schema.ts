// SQLite schema for DESIGN 3 (design-v0.3). Money is integer minor units; times are UTC epoch ms.
// Raised error messages (SLOT_CONFLICT etc.) are part of the contract with the application code.

export const SCHEMA_VERSION = 1;

export const CASE_STATUSES = [
  'DRAFT',
  'NEEDS_CLARIFICATION',
  'AWAITING_APPROVAL',
  'A_ACCEPTED',
  'READY',
  'PAYMENT_STARTED',
  'AUTHORIZING',
  'AUTHORIZED',
  'CAPTURING',
  'CAPTURED',
  'PAYMENT_PENDING',
  'PAYMENT_UNKNOWN',
  'RECONCILING',
  'BOOKING_COMMIT_PENDING',
  'BOOKING_COMMITTED',
  'REFUND_PENDING',
  'REFUND_FAILED',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
  'VOID_PENDING',
  'B_REFUND_PENDING',
  'B_REFUND_FAILED',
  'COMPENSATED',
] as const;

/** A case in any other status is in progress and blocks a second case for the same A booking. */
export const TERMINAL_CASE_STATUSES = ['COMPLETED', 'REJECTED', 'EXPIRED', 'COMPENSATED'] as const;

export const ATTEMPT_STATUSES = ['OPEN', 'ORDER_CREATED', 'AUTHORIZED', 'CAPTURED', 'SUCCEEDED', 'EXPIRED', 'FAILED'] as const;
export const UNFINISHED_ATTEMPT_STATUSES = ['OPEN', 'ORDER_CREATED', 'AUTHORIZED'] as const;
export const SUCCESSFUL_ATTEMPT_STATUSES = ['CAPTURED', 'SUCCEEDED'] as const;

export const OPERATION_KINDS = ['ORDER_CREATE', 'ORDER_AUTHORIZE', 'AUTH_CAPTURE', 'AUTH_VOID', 'CAPTURE_REFUND'] as const;
/** UNKNOWN = sent, outcome not known; PENDING = PayPal reported PENDING; NOT_ACCEPTED = first send rejected as invalid input. */
export const OPERATION_STATUSES = ['PREPARED', 'SENDING', 'UNKNOWN', 'PENDING', 'SUCCEEDED', 'FAILED', 'NOT_ACCEPTED'] as const;
export const UNCONFIRMED_OPERATION_STATUSES = ['PREPARED', 'SENDING', 'UNKNOWN', 'PENDING'] as const;

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

// Overlap rule shared by the triggers: [start, end) intervals overlap when a.start < b.end AND b.start < a.end.
const bookingBlocks = (excludeSelf: boolean) => `
  EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.stylist_id = NEW.stylist_id AND b.status = 'CONFIRMED'
      AND b.start_ms < NEW.end_ms AND NEW.start_ms < b.end_ms
      ${excludeSelf ? 'AND b.id <> NEW.id' : ''}
  )`;
const holdBlocks = (excludeSelf: boolean) => `
  EXISTS (
    SELECT 1 FROM slot_holds h
    WHERE h.stylist_id = NEW.stylist_id AND h.status IN ('ACTIVE', 'FROZEN')
      AND h.start_ms < NEW.end_ms AND NEW.start_ms < h.end_ms
      ${excludeSelf ? 'AND h.id <> NEW.id' : ''}
  )`;

export const SCHEMA_SQL = `
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  mode_ai TEXT NOT NULL CHECK (mode_ai IN ('VERTEX', 'MOCK')),
  mode_payment TEXT NOT NULL CHECK (mode_payment IN ('SANDBOX', 'MOCK')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at)
) STRICT;

CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  compensation_minor INTEGER NOT NULL CHECK (compensation_minor >= 0),
  expected_payee_merchant_id TEXT,
  business_open_min INTEGER NOT NULL CHECK (business_open_min BETWEEN 0 AND 1439),
  business_close_min INTEGER NOT NULL CHECK (business_close_min BETWEEN 1 AND 1440),
  CHECK (business_close_min > business_open_min)
) STRICT;

CREATE TABLE stylists (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL
) STRICT;

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0)
) STRICT;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  display_name TEXT NOT NULL
) STRICT;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  stylist_id TEXT NOT NULL REFERENCES stylists(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  CHECK (end_ms > start_ms)
) STRICT;
CREATE INDEX bookings_stylist_time ON bookings(stylist_id, start_ms);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('A_ORIGINAL', 'B_SWAP')),
  order_id TEXT NOT NULL,
  capture_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  payee_merchant_id TEXT,
  status_raw TEXT NOT NULL,
  verified_at INTEGER
) STRICT;

CREATE TABLE flex_preferences (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  raw_text TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
  input_source TEXT NOT NULL CHECK (input_source IN ('AI_VERTEX', 'AI_MOCK', 'MANUAL')),
  confirmed_at INTEGER,
  compensation_minor INTEGER NOT NULL CHECK (compensation_minor >= 0),
  UNIQUE (booking_id, version)
) STRICT;

CREATE TABLE b_requests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  raw_text TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
  input_source TEXT NOT NULL CHECK (input_source IN ('AI_VERTEX', 'AI_MOCK', 'MANUAL')),
  confirmed_at INTEGER
) STRICT;

CREATE TABLE swap_cases (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN (${sqlList(CASE_STATUSES)})),
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64),
  a_booking_id TEXT NOT NULL REFERENCES bookings(id),
  a_booking_version INTEGER NOT NULL,
  b_request_id TEXT NOT NULL REFERENCES b_requests(id),
  stylist_id TEXT NOT NULL REFERENCES stylists(id),
  origin_start_ms INTEGER NOT NULL,
  origin_end_ms INTEGER NOT NULL,
  b_start_ms INTEGER NOT NULL,
  b_end_ms INTEGER NOT NULL,
  dest_start_ms INTEGER NOT NULL,
  dest_end_ms INTEGER NOT NULL,
  b_price_minor INTEGER NOT NULL CHECK (b_price_minor > 0),
  a_comp_minor INTEGER NOT NULL CHECK (a_comp_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  a_capture_id TEXT NOT NULL,
  offer_expires_at INTEGER NOT NULL,
  CHECK (origin_end_ms > origin_start_ms AND b_end_ms > b_start_ms AND dest_end_ms > dest_start_ms),
  CHECK (origin_start_ms <= b_start_ms AND b_end_ms <= origin_end_ms)
) STRICT;
CREATE UNIQUE INDEX swap_cases_one_active_per_a_booking
  ON swap_cases(a_booking_id) WHERE status NOT IN (${sqlList(TERMINAL_CASE_STATUSES)});

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES swap_cases(id),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'A', 'B')),
  party_id TEXT NOT NULL,
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decided_at INTEGER NOT NULL,
  UNIQUE (case_id, role, terms_hash)
) STRICT;

CREATE TABLE slot_holds (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES swap_cases(id),
  stylist_id TEXT NOT NULL REFERENCES stylists(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'RELEASED', 'CONVERTED')),
  expires_at INTEGER NOT NULL,
  CHECK (end_ms > start_ms)
) STRICT;
CREATE INDEX slot_holds_stylist_time ON slot_holds(stylist_id, start_ms);

CREATE TABLE compensation_grants (
  booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
  case_id TEXT NOT NULL REFERENCES swap_cases(id),
  granted_at INTEGER NOT NULL
) STRICT;

CREATE TABLE money_obligations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES swap_cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('B_CHARGE', 'B_AUTH_VOID', 'A_COMPENSATION_REFUND', 'B_RECOVERY_REFUND')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  target_external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'SETTLED', 'NEEDS_ATTENTION', 'CANCELLED')),
  settled_by_operation_id TEXT UNIQUE REFERENCES payment_operations(id),
  UNIQUE (case_id, kind),
  CHECK ((status = 'SETTLED') = (settled_by_operation_id IS NOT NULL))
) STRICT;

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES money_obligations(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  previous_attempt_id TEXT REFERENCES payment_attempts(id),
  case_version INTEGER NOT NULL,
  terms_hash TEXT NOT NULL CHECK (length(terms_hash) = 64),
  expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN (${sqlList(ATTEMPT_STATUSES)})),
  UNIQUE (obligation_id, attempt_no),
  CHECK ((attempt_no = 1) = (previous_attempt_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX payment_attempts_one_unfinished_per_obligation
  ON payment_attempts(obligation_id) WHERE status IN (${sqlList(UNFINISHED_ATTEMPT_STATUSES)});
CREATE UNIQUE INDEX payment_attempts_one_success_per_obligation
  ON payment_attempts(obligation_id) WHERE status IN (${sqlList(SUCCESSFUL_ATTEMPT_STATUSES)});

CREATE TABLE payment_operations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
  op_kind TEXT NOT NULL CHECK (op_kind IN (${sqlList(OPERATION_KINDS)})),
  op_seq INTEGER NOT NULL CHECK (op_seq >= 1),
  previous_operation_id TEXT REFERENCES payment_operations(id),
  target_external_id TEXT,
  paypal_request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL CHECK (status IN (${sqlList(OPERATION_STATUSES)})),
  result_external_id TEXT,
  external_status TEXT,
  external_update_time TEXT,
  lease_owner TEXT,
  lease_gen INTEGER NOT NULL DEFAULT 0 CHECK (lease_gen >= 0),
  lease_until INTEGER,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  next_send_at INTEGER,
  last_error_class TEXT,
  UNIQUE (attempt_id, op_kind, op_seq),
  CHECK ((op_seq = 1) = (previous_operation_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX payment_operations_one_unconfirmed_per_attempt
  ON payment_operations(attempt_id) WHERE status IN (${sqlList(UNCONFIRMED_OPERATION_STATUSES)});
CREATE UNIQUE INDEX payment_operations_one_success_per_attempt_kind
  ON payment_operations(attempt_id, op_kind) WHERE status = 'SUCCEEDED';

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  event_id TEXT,
  transmission_id TEXT,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  headers_json TEXT NOT NULL CHECK (json_valid(headers_json)),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
  verify_status TEXT NOT NULL CHECK (verify_status IN ('UNVERIFIED', 'VERIFIED', 'INVALID', 'VERIFY_ERROR')),
  verify_tries INTEGER NOT NULL DEFAULT 0 CHECK (verify_tries >= 0),
  next_verify_at INTEGER
) STRICT;
CREATE INDEX webhook_deliveries_event ON webhook_deliveries(event_id);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES webhook_deliveries(id),
  verified_at INTEGER NOT NULL,
  processed_at INTEGER
) STRICT;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  world_id TEXT REFERENCES worlds(id),
  case_id TEXT REFERENCES swap_cases(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'A', 'B')),
  party_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'A', 'B')),
  party_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64)
) STRICT;

-- DESIGN 4.2: reject time overlap for the same stylist, on insert and on updates of time/stylist/status.
CREATE TRIGGER bookings_slot_conflict_insert BEFORE INSERT ON bookings
WHEN NEW.status = 'CONFIRMED' AND (${bookingBlocks(false)} OR ${holdBlocks(false)})
BEGIN SELECT RAISE(ABORT, 'SLOT_CONFLICT'); END;

CREATE TRIGGER bookings_slot_conflict_update BEFORE UPDATE OF stylist_id, start_ms, end_ms, status ON bookings
WHEN NEW.status = 'CONFIRMED' AND (${bookingBlocks(true)} OR ${holdBlocks(false)})
BEGIN SELECT RAISE(ABORT, 'SLOT_CONFLICT'); END;

CREATE TRIGGER slot_holds_slot_conflict_insert BEFORE INSERT ON slot_holds
WHEN NEW.status IN ('ACTIVE', 'FROZEN') AND (${bookingBlocks(false)} OR ${holdBlocks(false)})
BEGIN SELECT RAISE(ABORT, 'SLOT_CONFLICT'); END;

CREATE TRIGGER slot_holds_slot_conflict_update BEFORE UPDATE OF stylist_id, start_ms, end_ms, status ON slot_holds
WHEN NEW.status IN ('ACTIVE', 'FROZEN') AND (${bookingBlocks(false)} OR ${holdBlocks(true)})
BEGIN SELECT RAISE(ABORT, 'SLOT_CONFLICT'); END;

-- DESIGN 3: payment mode is fixed when the world is created (AI mode likewise, DESIGN 10).
CREATE TRIGGER worlds_modes_immutable BEFORE UPDATE OF mode_ai, mode_payment ON worlds
WHEN NEW.mode_ai IS NOT OLD.mode_ai OR NEW.mode_payment IS NOT OLD.mode_payment
BEGIN SELECT RAISE(ABORT, 'MODE_IMMUTABLE'); END;

-- DESIGN 7.1: an obligation starts OPEN, its amount is fixed at creation, and SETTLED is final.
CREATE TRIGGER money_obligations_start_open BEFORE INSERT ON money_obligations
WHEN NEW.status <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'OBLIGATION_MUST_START_OPEN'); END;

CREATE TRIGGER money_obligations_immutable BEFORE UPDATE OF case_id, kind, amount_minor, currency ON money_obligations
WHEN NEW.case_id IS NOT OLD.case_id OR NEW.kind IS NOT OLD.kind
  OR NEW.amount_minor IS NOT OLD.amount_minor OR NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT, 'OBLIGATION_IMMUTABLE'); END;

CREATE TRIGGER money_obligations_settled_final BEFORE UPDATE OF status, settled_by_operation_id ON money_obligations
WHEN OLD.status = 'SETTLED'
  AND (NEW.status IS NOT 'SETTLED' OR NEW.settled_by_operation_id IS NOT OLD.settled_by_operation_id)
BEGIN SELECT RAISE(ABORT, 'OBLIGATION_SETTLED'); END;

-- DESIGN 7.1: settle only through a SUCCEEDED operation of this obligation, of the kind that completes it
-- (B_CHARGE by AUTH_CAPTURE, never by order creation or authorization). AFTER, so the UNIQUE check runs first.
CREATE TRIGGER money_obligations_settlement_matches AFTER UPDATE OF status, settled_by_operation_id ON money_obligations
WHEN NEW.settled_by_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id
  WHERE o.id = NEW.settled_by_operation_id AND t.obligation_id = NEW.id AND o.status = 'SUCCEEDED'
    AND o.op_kind = CASE NEW.kind
      WHEN 'B_CHARGE' THEN 'AUTH_CAPTURE'
      WHEN 'B_AUTH_VOID' THEN 'AUTH_VOID'
      ELSE 'CAPTURE_REFUND'
    END
)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_MISMATCH'); END;

-- DESIGN 7.4: only a VERIFIED delivery with the same event_id may register an event.
CREATE TRIGGER webhook_events_verified_only BEFORE INSERT ON webhook_events
WHEN NOT EXISTS (
  SELECT 1 FROM webhook_deliveries d
  WHERE d.id = NEW.delivery_id AND d.verify_status = 'VERIFIED' AND d.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'DELIVERY_NOT_VERIFIED'); END;
`;
