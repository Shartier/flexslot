// V4: capture B's authorization (b1) with an explicit amount, resend with the same PayPal-Request-Id, and query authorization, order and capture.
// All steps act on the current verification run (work/verify/runs.json); see steps.ts.

import { run, sandboxStepContext } from './_lib.ts';
import { v4 } from './steps.ts';

await run('V4', 'SANDBOX', (r) => v4(sandboxStepContext(r)));
