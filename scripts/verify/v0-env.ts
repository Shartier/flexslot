// V0: required settings are present. Prints "set" / "missing" only, never a value.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { present } from '../../src/config-error.ts';
import { normalizeApiBase, SANDBOX_API_BASE } from '../../src/paypal/rest.ts';
import { loadDotEnv, ROOT, run } from './_lib.ts';

const REQUIRED = [
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_EXPECTED_MERCHANT_ID',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'FLEXSLOT_AI_MODEL',
];
const LATER = ['PAYPAL_WEBHOOK_ID'];

await run('V0', 'CONFIG', async (r) => {
  r.check('.env exists', loadDotEnv());
  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: ROOT });
    ignored = true;
  } catch {
    ignored = false;
  }
  r.check('.env is ignored by Git', ignored);
  for (const k of REQUIRED) r.check(`${k} set`, present(process.env[k]));
  for (const k of LATER) r.note(`${k} (V8 only)`, present(process.env[k]) ? 'set' : 'empty');
  const base = process.env.PAYPAL_API_BASE;
  r.check('PAYPAL_API_BASE absent or Sandbox', !present(base) || normalizeApiBase(base.trim()) === SANDBOX_API_BASE);
  const adc = join(process.env.APPDATA ?? '', 'gcloud', 'application_default_credentials.json');
  r.note('ADC user credentials file', existsSync(adc) ? 'present' : 'absent');
  r.note('GOOGLE_APPLICATION_CREDENTIALS', present(process.env.GOOGLE_APPLICATION_CREDENTIALS) ? 'set (key file; not used by design)' : 'not set');
});
