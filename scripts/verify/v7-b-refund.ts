// V7: full refund of B's capture (V4), the recovery path E-R. The amount is explicit.
// All steps act on the current verification run (work/verify/runs.json); see steps.ts.

import { run, sandboxStepContext } from './_lib.ts';
import { v7 } from './steps.ts';

await run('V7', 'SANDBOX', (r) => v7(sandboxStepContext(r)));
