// SQLite schema for DESIGN 3 (design-v0.5). Money is integer minor units; times are UTC epoch ms.
// Raised error messages (SLOT_CONFLICT etc.) are part of the contract with the application code.
// Version 2 (executor, DESIGN 14.3): operation rows keep their fixed input, the reconciliation marker
// (D20 / IP1-04) and timestamps; A's original payment has its own operation table (STATUS I08).
// Version 3 (AI adapter and screens, DESIGN 14.4-14.5): AI call records and quotas, intake drafts, the person's
// edit marker on confirmed versions, candidate evaluations, the world's base date and the profit assumptions.

export const SCHEMA_VERSION = 3;

export const INPUT_SOURCES = ['AI_VERTEX', 'AI_MOCK', 'MANUAL'] as const;
export const AI_CALL_OUTCOMES = ['IN_FLIGHT', 'OK', 'INVALID_OUTPUT', 'TIMEOUT', 'API_ERROR', 'QUOTA'] as const;

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
/** D20: AWAITING = the POST succeeded but FlexSlot has not reconciled it yet; MATCHED = reconciled. */
export const RECONCILE_STATUSES = ['AWAITING', 'MATCHED'] as const;
/** A's original payment (intent=CAPTURE, DESIGN 6.1): not a money obligation, so it has its own table. */
export const A_OPERATION_KINDS = ['ORDER_CREATE', 'ORDER_CAPTURE'] as const;

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

// Columns shared by payment_operations and a_payment_operations (DESIGN 7.1, 7.2).
// request_json is the fixed input the request hash was computed from; it is never rebuilt before a resend.
const operationColumns = `
  op_seq INTEGER NOT NULL CHECK (op_seq >= 1),
  target_external_id TEXT,
  paypal_request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN (${sqlList(OPERATION_STATUSES)})),
  result_external_id TEXT,
  external_status TEXT,
  external_update_time TEXT,
  reconcile_status TEXT CHECK (reconcile_status IN (${sqlList(RECONCILE_STATUSES)})),
  reconciled_at INTEGER,
  result_amount_minor INTEGER,
  observed_total_refunded_minor INTEGER,
  lease_owner TEXT,
  lease_gen INTEGER NOT NULL DEFAULT 0 CHECK (lease_gen >= 0),
  lease_until INTEGER,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  prior_unknown INTEGER NOT NULL DEFAULT 0 CHECK (prior_unknown IN (0, 1)),
  next_send_at INTEGER,
  last_error_class TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  CHECK (reconcile_status IS NULL OR status = 'SUCCEEDED'),
  CHECK ((reconcile_status IS 'MATCHED') = (reconciled_at IS NOT NULL))`;

// DESIGN 7.2: an operation's status only moves forward (PREPARED < SENDING/UNKNOWN < PENDING < final), the
// reconciliation marker never goes back, and the stored request and the identified resource never change.
const operationTriggers = (table: string) => `
CREATE TRIGGER ${table}_no_regression BEFORE UPDATE OF status ON ${table}
WHEN (OLD.status IN ('SUCCEEDED', 'FAILED', 'NOT_ACCEPTED') AND NEW.status IS NOT OLD.status)
  OR (OLD.status = 'PENDING' AND NEW.status IN ('PREPARED', 'SENDING', 'UNKNOWN'))
  OR (OLD.status IN ('SENDING', 'UNKNOWN') AND NEW.status = 'PREPARED')
BEGIN SELECT RAISE(ABORT, 'OPERATION_STATUS_REGRESSION'); END;

CREATE TRIGGER ${table}_reconcile_forward BEFORE UPDATE OF reconcile_status ON ${table}
WHEN (OLD.reconcile_status = 'MATCHED' AND NEW.reconcile_status IS NOT 'MATCHED')
  OR (OLD.reconcile_status = 'AWAITING' AND NEW.reconcile_status IS NULL)
BEGIN SELECT RAISE(ABORT, 'RECONCILE_REGRESSION'); END;

CREATE TRIGGER ${table}_request_immutable
BEFORE UPDATE OF op_kind, op_seq, target_external_id, paypal_request_id, request_hash, request_json, result_external_id ON ${table}
WHEN NEW.op_kind IS NOT OLD.op_kind OR NEW.op_seq IS NOT OLD.op_seq
  OR NEW.target_external_id IS NOT OLD.target_external_id OR NEW.paypal_request_id IS NOT OLD.paypal_request_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.request_json IS NOT OLD.request_json
  OR (OLD.result_external_id IS NOT NULL AND NEW.result_external_id IS NOT OLD.result_external_id)
BEGIN SELECT RAISE(ABORT, 'OPERATION_IMMUTABLE'); END;
`;

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
  -- Shop-local date the sample bookings were generated from (SPEC 4: regenerate relative to the demo day).
  base_local_date TEXT,
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
  -- SPEC 9 assumptions shown with the owner's profit estimate (fictional values, not PayPal rates).
  profit_assumptions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profit_assumptions_json)),
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

-- DESIGN 9: one row per structuring request to the AI (never a mock fallback for a failed Vertex call).
-- attempts counts the requests actually sent to the model (the one retry on 5xx/429 included); the quotas
-- (per world, per UTC day) are checked and counted before every attempt. No customer text is stored here.
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('A_PREFERENCE', 'B_REQUEST')),
  mode TEXT NOT NULL CHECK (mode IN ('VERTEX', 'MOCK')),
  model TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (${sqlList(AI_CALL_OUTCOMES)})),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  latency_ms INTEGER,
  http_status INTEGER,
  issues_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issues_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ai_calls_world ON ai_calls(world_id);
CREATE INDEX ai_calls_day ON ai_calls(utc_day);

-- A structuring proposal waiting for the person's confirmation (DESIGN 9). Confirming writes a new version of
-- flex_preferences / b_requests; the draft keeps the AI's proposal and its questions as they were.
CREATE TABLE intake_drafts (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('A_PREFERENCE', 'B_REQUEST')),
  party_id TEXT NOT NULL,
  raw_text TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK (source IN (${sqlList(INPUT_SOURCES)})),
  ai_call_id TEXT REFERENCES ai_calls(id),
  -- Why the person is filling the form by hand: NULL (chose AI), or the AI failure / quota / CHOSEN_MANUAL.
  manual_reason TEXT,
  proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
  questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(questions_json)),
  previous_draft_id TEXT REFERENCES intake_drafts(id),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CONFIRMED', 'SUPERSEDED')),
  created_at INTEGER NOT NULL,
  CHECK ((source = 'MANUAL') = (ai_call_id IS NULL)),
  CHECK (source = 'MANUAL' OR proposal_json IS NOT NULL)
) STRICT;
CREATE INDEX intake_drafts_party ON intake_drafts(world_id, party_id);

CREATE TABLE flex_preferences (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  raw_text TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
  input_source TEXT NOT NULL CHECK (input_source IN (${sqlList(INPUT_SOURCES)})),
  confirmed_at INTEGER,
  compensation_minor INTEGER NOT NULL CHECK (compensation_minor >= 0),
  draft_id TEXT REFERENCES intake_drafts(id),
  -- 1 when the person changed the AI's proposal before confirming (the source still names who proposed it).
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  UNIQUE (booking_id, version)
) STRICT;

CREATE TABLE b_requests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  raw_text TEXT NOT NULL,
  structured_json TEXT NOT NULL CHECK (json_valid(structured_json)),
  input_source TEXT NOT NULL CHECK (input_source IN (${sqlList(INPUT_SOURCES)})),
  confirmed_at INTEGER,
  draft_id TEXT REFERENCES intake_drafts(id),
  edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
  UNIQUE (customer_id, version)
) STRICT;

-- DESIGN 6.1 step 4: the program's verdict for one confirmed B request version, with reasons when infeasible.
CREATE TABLE candidate_evaluations (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  b_request_id TEXT NOT NULL REFERENCES b_requests(id),
  evaluated_at INTEGER NOT NULL,
  feasible INTEGER NOT NULL CHECK (feasible IN (0, 1)),
  case_id TEXT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
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
  previous_operation_id TEXT REFERENCES payment_operations(id),
  ${operationColumns},
  UNIQUE (attempt_id, op_kind, op_seq),
  CHECK ((op_seq = 1) = (previous_operation_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX payment_operations_one_unconfirmed_per_attempt
  ON payment_operations(attempt_id) WHERE status IN (${sqlList(UNCONFIRMED_OPERATION_STATUSES)});
CREATE UNIQUE INDEX payment_operations_one_success_per_attempt_kind
  ON payment_operations(attempt_id, op_kind) WHERE status = 'SUCCEEDED';
CREATE INDEX payment_operations_target ON payment_operations(op_kind, target_external_id);

CREATE TABLE a_payment_operations (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  op_kind TEXT NOT NULL CHECK (op_kind IN (${sqlList(A_OPERATION_KINDS)})),
  previous_operation_id TEXT REFERENCES a_payment_operations(id),
  ${operationColumns},
  UNIQUE (booking_id, op_kind, op_seq),
  CHECK ((op_seq = 1) = (previous_operation_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX a_payment_operations_one_unconfirmed_per_booking
  ON a_payment_operations(booking_id) WHERE status IN (${sqlList(UNCONFIRMED_OPERATION_STATUSES)});
CREATE UNIQUE INDEX a_payment_operations_one_success_per_booking_kind
  ON a_payment_operations(booking_id, op_kind) WHERE status = 'SUCCEEDED';

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
-- D20 / IP1-04: a capture (and a void) settles only once FlexSlot has reconciled it with a query (MATCHED).
CREATE TRIGGER money_obligations_settlement_matches AFTER UPDATE OF status, settled_by_operation_id ON money_obligations
WHEN NEW.settled_by_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id
  WHERE o.id = NEW.settled_by_operation_id AND t.obligation_id = NEW.id AND o.status = 'SUCCEEDED'
    AND o.op_kind = CASE NEW.kind
      WHEN 'B_CHARGE' THEN 'AUTH_CAPTURE'
      WHEN 'B_AUTH_VOID' THEN 'AUTH_VOID'
      ELSE 'CAPTURE_REFUND'
    END
    AND (NEW.kind NOT IN ('B_CHARGE', 'B_AUTH_VOID') OR o.reconcile_status = 'MATCHED')
)
BEGIN SELECT RAISE(ABORT, 'SETTLEMENT_MISMATCH'); END;

-- DESIGN 7.2: an attempt only moves forward (OPEN < ORDER_CREATED < AUTHORIZED < final).
CREATE TRIGGER payment_attempts_no_regression BEFORE UPDATE OF status ON payment_attempts
WHEN (OLD.status IN ('CAPTURED', 'SUCCEEDED', 'EXPIRED', 'FAILED') AND NEW.status IS NOT OLD.status)
  OR (OLD.status = 'ORDER_CREATED' AND NEW.status = 'OPEN')
  OR (OLD.status = 'AUTHORIZED' AND NEW.status IN ('OPEN', 'ORDER_CREATED'))
BEGIN SELECT RAISE(ABORT, 'ATTEMPT_STATUS_REGRESSION'); END;
${operationTriggers('payment_operations')}
${operationTriggers('a_payment_operations')}

-- DESIGN 7.4: only a VERIFIED delivery with the same event_id may register an event.
CREATE TRIGGER webhook_events_verified_only BEFORE INSERT ON webhook_events
WHEN NOT EXISTS (
  SELECT 1 FROM webhook_deliveries d
  WHERE d.id = NEW.delivery_id AND d.verify_status = 'VERIFIED' AND d.event_id = NEW.event_id
)
BEGIN SELECT RAISE(ABORT, 'DELIVERY_NOT_VERIFIED'); END;
`;
