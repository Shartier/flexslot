// V3: B's authorization (intent=AUTHORIZE). Two orders: b1 is later captured (V4) and refunded (V7), b2 is voided (V5).
//   start  — joins (or opens) a verification run, creates both orders and prints two approval URLs.
//   finish — authorizes both and checks the representation: authorization id, status, expiry, amount, payee.

import { NotReady, run, sandboxStepContext } from './_lib.ts';
import { v3Finish, v3Start } from './steps.ts';

const phase = process.argv[2];

await run(`V3 ${phase ?? '(no phase)'}`, 'SANDBOX', async (r) => {
  if (phase === 'start') return v3Start(sandboxStepContext(r));
  if (phase === 'finish') return v3Finish(sandboxStepContext(r));
  throw new NotReady('usage: node scripts/verify/v3-b-authorize.ts start|finish');
});
