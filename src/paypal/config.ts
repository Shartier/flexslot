// PayPal settings from the environment (.env). Values are never printed; errors name variables only.

import type { Clock } from '../clock.ts';
import { MissingConfigError, present, type Env } from '../config-error.ts';
import type { PayPalLogger } from './port.ts';
import { NonSandboxEndpointError, normalizeApiBase, PayPalRestAdapter, SANDBOX_API_BASE, type FetchLike } from './rest.ts';

export { MissingConfigError };

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  apiBase: typeof SANDBOX_API_BASE;
  expectedMerchantId?: string;
  webhookId?: string;
}

/** Throws NonSandboxEndpointError when PAYPAL_API_BASE names anything but the Sandbox. */
export function loadPayPalConfig(env: Env): PayPalConfig {
  const base = env.PAYPAL_API_BASE;
  if (present(base) && normalizeApiBase(base.trim()) !== SANDBOX_API_BASE) throw new NonSandboxEndpointError();
  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'].filter((k) => !present(env[k]));
  if (missing.length > 0) throw new MissingConfigError(missing);
  return {
    clientId: env.PAYPAL_CLIENT_ID!.trim(),
    clientSecret: env.PAYPAL_CLIENT_SECRET!.trim(),
    apiBase: SANDBOX_API_BASE,
    ...(present(env.PAYPAL_EXPECTED_MERCHANT_ID) ? { expectedMerchantId: env.PAYPAL_EXPECTED_MERCHANT_ID.trim() } : {}),
    ...(present(env.PAYPAL_WEBHOOK_ID) ? { webhookId: env.PAYPAL_WEBHOOK_ID.trim() } : {}),
  };
}

export interface AdapterDeps {
  fetch?: FetchLike;
  clock?: Clock;
  logger?: PayPalLogger;
  timeoutMs?: number;
}

export function createSandboxPayPal(config: PayPalConfig, deps: AdapterDeps = {}): PayPalRestAdapter {
  return new PayPalRestAdapter({
    mode: 'SANDBOX',
    apiBase: config.apiBase,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });
}
