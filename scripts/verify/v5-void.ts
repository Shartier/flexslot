// V5: void B's second authorization (b2) and confirm VOIDED by querying it.

import { randomUUID } from 'node:crypto';
import { anon, NotReady, readState, run, sandboxFromEnv, saveState, str } from './_lib.ts';

await run('V5', 'SANDBOX', async (r) => {
  const { paypal } = sandboxFromEnv();
  const state = readState();
  const authorizationId = str(state.v3_b2?.authorizationId);
  if (!authorizationId) throw new NotReady('V3 finish has not stored the b2 authorization');
  const requestId = str(state.v5?.requestId) ?? randomUUID();
  saveState('v5', { requestId });

  r.note('authorization', anon('auth', authorizationId));
  const res = await paypal.voidAuthorization(authorizationId, { requestId });
  r.note('void_outcome', res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);
  r.note('void_http_status', 'httpStatus' in res && res.httpStatus !== undefined ? res.httpStatus : '-');
  r.note('void_confirmed_by', res.confirmedBy ?? '-');
  r.check('void accepted (VOIDED)', res.kind === 'SUCCEEDED');

  const q = await paypal.getAuthorization(authorizationId);
  if (r.check('GET authorization found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.note('authorization_status', q.resource.status);
    r.check('GET authorization: VOIDED', q.resource.status === 'VOIDED');
  }
});
