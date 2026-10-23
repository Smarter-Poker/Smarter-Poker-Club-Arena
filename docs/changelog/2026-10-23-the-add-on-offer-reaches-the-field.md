# The add-on offer reaches the field

Production history confirmed two complete 60-second pauses with no overlapping hands, but only 32 horses purchased in the funded Midnight Free Buy's closing minute. The original offer processed at most 20 identities, then applied its 20-second retry cooldown to the next part of that same field. A numeric cursor also indexed a pending list that shrank after receipts.

Continue unfinished batches through the existing shared elimination scheduler immediately. Each admission remains bounded to 20 identities and four concurrent canonical purchase RPCs. Retain the last identity rather than an offset into the shrinking list. Once the field has been offered, preserve the existing retry cadence. Ambiguous replies remain retryable through the same idempotent purchase path, and every launched request settles before the admission exits. Maintenance, stop, deadline and cooperative budget checks remain authoritative.

The real manager regression fails on the old source (60 of 451 selected identities reached in a 500-player field). The corrected path reaches all 451 with simulated 300ms requests within 40 seconds, never more than four in flight. Separate cases cover an ambiguous early identity and maintenance arriving with a group already dispatched. The existing per-request maintenance source guard now follows the bounded group map.

This is an engine follow-up. It requires protected checks and the existing 4 AM America/Chicago activation, followed by natural production receipt verification. Local tests and source merge do not establish the requested live participation rate.

The database entry-close edge now also starts an already-open FreeBuy early window's closing drain. A maintenance-thawed offer deadline previously left play running for five minutes after canonical late registration closed. The connected entry-close regression fails before and passes after; the existing all-table drain still owns the full minute and never renews a bounded closing window.
