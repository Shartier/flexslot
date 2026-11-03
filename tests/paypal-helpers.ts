import { randomUUID } from 'node:crypto';
import { ManualClock } from '../src/clock.ts';
import { MockPayPalServer, createMockPayPal, type ReplayModes } from '../src/paypal/mock-server.ts';
import type { PayPalLogEntry } from '../src/paypal/port.ts';
import type { CreateOrderInput } from '../src/paypal/requests.ts';

export const T0 = Date.UTC(2026, 10, 3, 3, 0, 0);

export const rid = () => randomUUID();

export const orderInput = (intent: 'CAPTURE' | 'AUTHORIZE', minor = 6000): CreateOrderInput => ({
  intent,
  amount: { currency: 'USD', minor },
  customId: 'case:C7:v3:att:AT1',
  invoiceId: `FS-C7-B-${randomUUID().slice(0, 8)}`,
  returnUrl: 'http://localhost:5173/paypal/return',
  cancelUrl: 'http://localhost:5173/paypal/cancel',
});

/** Mock server + MOCK adapter sharing one manual clock, with a log sink. Short timeout for TIMEOUT faults. */
export function mockSetup(timeoutMs = 50, replay?: ReplayModes) {
  const clock = new ManualClock(T0);
  const server = new MockPayPalServer({ clock, ...(replay ? { replay } : {}) });
  const logs: PayPalLogEntry[] = [];
  const paypal = createMockPayPal(server, { clock, logger: (e) => logs.push(e), timeoutMs });
  return { clock, server, paypal, logs };
}

export function expectKind<T extends { kind: string }, K extends T['kind']>(r: T, kind: K): Extract<T, { kind: K }> {
  if (r.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(r)}`);
  return r as Extract<T, { kind: K }>;
}

/** Creates an AUTHORIZE order, approves it as the buyer would, authorizes it. Returns the ids. */
export async function authorized(setup: ReturnType<typeof mockSetup>, minor = 6000) {
  const created = expectKind(await setup.paypal.createOrder(orderInput('AUTHORIZE', minor), { requestId: rid() }), 'SUCCEEDED');
  setup.server.approveOrder(created.resource.id);
  const auth = expectKind(await setup.paypal.authorizeOrder(created.resource.id, { requestId: rid() }), 'SUCCEEDED');
  return { orderId: created.resource.id, authorizationId: auth.resource.authorization.id };
}

/** Creates a CAPTURE order (A's original payment), approves it and captures it. */
export async function captured(setup: ReturnType<typeof mockSetup>, minor = 6000) {
  const created = expectKind(await setup.paypal.createOrder(orderInput('CAPTURE', minor), { requestId: rid() }), 'SUCCEEDED');
  setup.server.approveOrder(created.resource.id);
  const cap = expectKind(await setup.paypal.captureOrder(created.resource.id, { requestId: rid() }), 'SUCCEEDED');
  return { orderId: created.resource.id, captureId: cap.resource.capture.id };
}
