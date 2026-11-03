// V6: 10.00 partial refund on A's capture, same-id resend, queries, then a refund above the remaining amount (run only when the 10.00 refund is confirmed on this capture).
// All steps act on the current verification run (work/verify/runs.json); see steps.ts.

import { run, sandboxStepContext } from './_lib.ts';
import { v6 } from './steps.ts';

await run('V6', 'SANDBOX', (r) => v6(sandboxStepContext(r)));
