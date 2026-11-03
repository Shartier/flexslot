// V1: PayPal Sandbox access token. Prints success and lifetime only.

import { run, sandboxFromEnv } from './_lib.ts';

await run('V1', 'SANDBOX', async (r) => {
  const { paypal } = sandboxFromEnv();
  const result = await paypal.checkCredentials();
  if (result.ok) {
    r.check('access token obtained', true);
    r.note('expires_in_sec', result.expiresInSec);
  } else {
    r.check('access token obtained', false);
    r.note('failure', `${result.reason}${result.httpStatus ? ` http=${result.httpStatus}` : ''}`);
  }
});
