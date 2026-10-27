# Horse prize capture builds the canonical ladder once

Finalized tournament prize capture rebuilt and normalized the whole payout
ladder for every paid place. A 5,000-place original capture took about 3.2
seconds in the local fixed-input comparison, blocking the engine thread.

The shared payout arithmetic now exports `computePrizeLadder`. The existing
per-place API delegates to that same implementation, and capture reads one
completed ladder. Both client and server copies retain identical rule bytes.
All basis-point, cent, asset-unit, short-field, duplicate-place and residual
rules are preserved. No prizes, payouts, qualification selections or stored
records are changed.

The source-read regression fails before the fix (2,003,998 reads for 1,000
places) and passes the linear bound afterward. Focused independent integer
arithmetic, original capture and mirror checks pass, as do both TypeScript
checks. A fixed-seed differential comparison with protected main checks
22,032 per-place values exactly; complete 1,000/5,000-place capture outputs,
including source digests, remain identical. Local capture timings changed
from 86.5/3,207 ms to 0.52/2.45 ms. These observations are local source
validation, not production exposure or live adoption evidence.
