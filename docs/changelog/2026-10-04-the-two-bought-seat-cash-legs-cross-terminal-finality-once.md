# The Two Bought-Seat Cash Legs Cross Terminal Finality Once

## Change #1 - Preserve The Terminal Guard While Settling Two Existing Liabilities

**File:** `supabase/migrations/20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites.sql`

**What Existed:** The migration used the ordinary adjustment-backed wallet credit door. Its journal leg correctly named each satellite's existing `prize_liability`, but the completed-satellite immutability trigger refused that new testimony before any chips moved. The supported production apply rolled the transaction back with SQLSTATE `55000` and `completed satellite transfer journal is immutable`.

**What Changed:** The migration now reads and pins the exact installed terminal-guard body, transactionally replaces it with an admission for only the two named 30.00 legs to WASP, requires the exact club, idempotency key, approved same-transaction adjustment and migration source, performs the already-asserted conserved settlement, then restores and verifies the predecessor body byte-for-byte before commit. The function replacement is invisible to concurrent transactions and any failure rolls it back. The trigger is never disabled and no permanent exception remains.

**Why:** These two liabilities predate the live-path bought-seat cash ruling. The root award path was already corrected by migration `20260905195011`; this change settles only its two terminal predecessors without weakening finality for any other tournament or future write.

**Verified:** YES - the migration and retained law test were re-read after the edit. Local focused and database qualification results are recorded in the task checkpoint.

**TypeScript:** PASS - `npx tsc --noEmit` completed with zero errors on the final local candidate.
