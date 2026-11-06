// Shapes of the server's per-role views (src/app/views.ts). The browser only displays them.

export interface Money {
  minor: number;
  currency: string;
  text: string;
}

export interface Window {
  date: string;
  start: string;
  end: string;
}

export interface Header {
  worldId: string;
  role: 'OWNER' | 'A' | 'B';
  modes: { ai: 'VERTEX' | 'MOCK'; aiModel: string | null; aiAvailable: boolean; payment: 'SANDBOX' | 'MOCK' };
  shop: {
    name: string;
    timeZone: string;
    hours: string;
    stylists: string[];
    services: Array<{ id: string; name: string; durationMin: number; price: Money }>;
    compensation: Money;
  };
  baseDate: string | null;
  serverTime: string;
  examples: { a: string; b: string };
}

export interface Step {
  state: string;
  text: string;
}

export interface CaseView {
  id: string;
  version: number;
  termsHash: string;
  status: string;
  statusLabel: string;
  origin: string;
  destination: string;
  bSlot: string;
  aService: string;
  bService: string | null;
  stylist: string;
  bPrice: Money;
  aCompensation: Money;
  offerExpiresAt: string;
  paymentDeadline: string | null;
  approvals: { OWNER: string | null; A: string | null; B: string | null };
  actions: { approve: boolean; reject: boolean; pay: boolean; payPal: boolean };
  steps: { bPayment: Step; authorizationRelease: Step | null; aRefund: Step; bRefund: Step | null; bookings: string; bookingsChanged: boolean };
  events: Array<{ at: string; text: string }>;
}

export interface OwnerCase extends CaseView {
  profit: {
    lines: Array<{ name: string; sign: 1 | -1; amount: Money }>;
    additionalRevenue: Money;
    additionalProfit: Money;
    note: string;
  };
  obligations: Array<{
    id: string;
    kind: string;
    amount: Money;
    status: string;
    retryable: boolean;
    attempts: Array<{ no: number; status: string; ops: Array<{ kind: string; status: string; external: string | null; reconcile: string | null; sends: number; error: string | null }> }>;
  }>;
}

export interface Draft {
  id: string;
  rawText: string;
  source: 'AI_VERTEX' | 'AI_MOCK' | 'MANUAL';
  sourceText: string;
  manualReason: string | null;
  proposal: { windows: Window[]; serviceId?: string | null; stylistId?: string | null } | null;
  questions: Array<{ field: string; question: string }>;
}

export interface Conditions {
  version: number;
  windows: Window[];
  source: string;
  edited: boolean;
  rawText: string;
  compensation?: Money;
  service?: string;
}

export interface OwnerState {
  header: Header;
  bookings: Array<{ customer: string; time: string; service: string; status: string; version: number; price: Money; payment: string }>;
  preference: Conditions | null;
  request: Conditions | null;
  evaluation: { at: string; feasible: boolean; reasons: Array<{ code: string; text: string }>; detail: unknown } | null;
  cases: OwnerCase[];
  stopped: Array<{ obligation: string; operation: string; status: string; reason: string }>;
  checking: Array<{ obligation: string; operation: string; status: string; reason: string }>;
  needsAttentionObligations: string[];
  history: Array<{ at: string; actor: string; action: string; detail: Record<string, unknown> }>;
  aiUsage: Array<{ mode: string; model: string; kind: string; outcome: string; attempts: number; latencyMs: number | null }>;
}

export interface CustomerBase {
  header: Header;
  draft: Draft | null;
  intakeBlocked: string | null;
  cases: CaseView[];
}

export interface AState extends CustomerBase {
  booking: { time: string; service: string; stylist: string; price: Money; payment: Step };
  preference: Conditions | null;
  refundNote: string;
}

export interface BState extends CustomerBase {
  request: Conditions | null;
  result: { feasible: boolean; reasons: string[] } | null;
}

export type Approval = { kind: 'MOCK' } | { kind: 'PAYPAL'; url: string } | { kind: 'UNAVAILABLE' };
