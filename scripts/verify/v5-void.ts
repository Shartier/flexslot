// V5: void B's second authorization (b2) and confirm VOIDED by querying it.
// All steps act on the current verification run (work/verify/runs.json); see steps.ts.

import { run, sandboxStepContext } from './_lib.ts';
import { v5 } from './steps.ts';

await run('V5', 'SANDBOX', (r) => v5(sandboxStepContext(r)));
