// V2: A's original payment (intent=CAPTURE).
//   start  — opens (or joins) a verification run, creates the order and prints the approval URL
//            (log in there with the Sandbox buyer account).
//   finish — after approval: captures, then checks amount, currency and payee by querying capture and order.

import { NotReady, run, sandboxStepContext } from './_lib.ts';
import { v2Finish, v2Start } from './steps.ts';

const phase = process.argv[2];

await run(`V2 ${phase ?? '(no phase)'}`, 'SANDBOX', async (r) => {
  if (phase === 'start') return v2Start(sandboxStepContext(r));
  if (phase === 'finish') return v2Finish(sandboxStepContext(r));
  throw new NotReady('usage: node scripts/verify/v2-a-capture.ts start|finish');
});
