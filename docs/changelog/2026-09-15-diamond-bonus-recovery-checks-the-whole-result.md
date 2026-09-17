# Diamond Bonus Recovery Checks The Whole Result

Crash bonus start and saved-request replay now use the same outcome validator
as settlement polling and cashout. The former duplicated checks allowed an
open crash-point reveal, an out-of-range live multiplier, or disagreement
between the revealed crash point and the payout outcome to clear recovery.
These receipts now leave the original wager saved for an exact retry.

Plinko requires each saved path to terminate at its reported prize slot before
accepting the receipt. Its saved-result lookup also requires the requested
club and game, explicit success, and either a result or an explicit null for
empty history. A missing result is not interpreted as an empty history.

The regression scenarios check malformed Crash receipts followed by exact
valid retries, retained Plinko recovery after a path/slot mismatch, sealed open
Crash receipts, consistent losses, and missing or cross-club/game history.

Source review also found defects in the existing financial probes. The funding
probe's different-host case selected the same host. It now selects the other
host and explicitly requires distinct, authorized test operators so a permission
refusal cannot substitute for proof of request identity. The claimed Daily
Bonus probe now fails on missing response fields and balances using null-safe
comparisons, requires the returned ticket, and checks the entry funding metadata.
These are test changes; no wallet, Mint, entitlement or payout rule changes.

The normal local source guards and formatting are separate from execution
evidence. Behavioral tests, SQL probes, typechecks, builds and browser checks
remain unexecuted until the protected pipeline admits this exact revision.
An independent source review was requested from the existing program review
task; any resulting review must name the final revision it inspected. No direct
application execution, database mutation, GitHub action or publication occurs
as part of this source-only continuation.
