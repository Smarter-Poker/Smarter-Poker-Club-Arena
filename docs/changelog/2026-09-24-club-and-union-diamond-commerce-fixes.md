# Club And Union Diamond Costs: The Review Fixes Ship Forward

Date: 2026-09-24. Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), continuation.

## What happened

`20260922143541_club_and_union_diamond_commerce` merged in #5077 and was
installed on 2026-09-23 at 17:06 UTC. Nothing has used it yet: no trial,
quote, purchase, mandate, refund, sponsorship or notice exists in production.
A line-by-line review of the migration, the page and the service found real
defects, several of them about money. The installed file is never edited, so
every fix ships in a forward migration,
`20260924033509_club_and_union_diamond_commerce_fixes.sql`.

The forward migration first proves it is changing what was installed: the 11
function bodies it replaces must match the installed md5s, and the mandate key
must be the original one. If anything else changed first, it stops.

## The defects, each fixed at its line and pinned by a harness check

Money:

1. Cancelling a post-trial authorization required a sku the page never sends,
   so an owner could not stop the charge at the end of the free month.
2. Mandates were unique per (right, sku). Re-authorizing a different product
   added a second mandate on the same right, which bought the next period
   twice and made the status read fail. Now one mandate per right.
3. A renewal whose next period was already covered quoted and charged a later
   period at once. It now stops at `needs_attention` (`period_already_covered`).
4. Value credited into an upgrade could still be refunded, and value already
   refunded could still be credited into an upgrade. Both directions are
   netted.
5. Renewal execution locked the mandate, then the scope; upgrades and refunds
   lock the scope, then the mandate. One order now, with a concurrent test
   that deadlocks on the old order.
6. A staff refund from a browser session died mid-refund with a raw 42501 from
   the profile wallet guard. The refund door now says
   `refund_requires_service_route` in JSON before any work. See the owner
   decision below.

Correctness:

7. The catalog version was the latest publication second, so two publications
   in one second did not withdraw quotes. It now names the published set.
8. A future-dated price publication retired the current price immediately,
   leaving no price until the date. The current price now stays in effect
   until then.
9. A service-role publication raised a raw trigger error; now JSON.
10. A union coverage downgrade mid-period was accepted at net 0; refused.
11. An upgrade picked the prepaid next period instead of the right in effect.
12. An over-reserved lot counted as negative availability in the lot proof.
13. Receipts always said "effective", even after a full refund.
14. A re-authorized mandate that failed again was never notified, and the
    notice showed a raw sku and a snake_case reason.
15. Concurrent refunds with one key raised a unique error instead of the
    replay; a malformed quantity raised a cast error; a purchase could be
    committed under a kind its quote did not describe.
16. Sponsorship eligibility read `clubs.union_id`, which the union's own shell
    club carries without being a covered club. Membership is the `union_clubs`
    link everywhere now, the same rule the covered-club count always used.

The page (`ClubDiamondCostsPage.tsx`, `ClubCommerceService.ts`):

- Renewal ceilings are per right, whole numbers, at least today's price (an
  empty field used to authorize at 0).
- After an unknown purchase outcome the page offers only Retry Same Order and
  Check Again, so a lost response cannot become a second charge.
- A stale quote is thrown away when any input changes; double taps send one
  call.
- During the free month the quote offers Authorize At Trial End instead of a
  purchase the server refuses.
- Every refusal code the SQL can return has Title Case copy; a contract test
  parses the migrations and fails if one is missing or if an RPC key drifts.
- Union page: a Buy For A Covered Club console for the sponsor, listing each
  covered club's roster, capacity and trial state, with sponsored receipts
  labelled by club.

## The harness now sees what production sees

`tests/sql/run-diamond-club-commerce.py` used to set only the legacy
`request.jwt.claim.*` settings and ran every call as the superuser. Production
guards read `request.jwt.claims` and EXECUTE grants follow the JWT role, so
the harness could not see the refund failure (6) at all. It now presents
identity exactly as PostgREST does (the claims object plus `SET ROLE`) and
applies the installed file, then the forward fix: 155 scenarios pass.

## Owner decision left open

Naming `fn_ca_commerce_refund` in `fn_guard_profile_privileged_columns` (one
line, the pattern `20260914120854` used for `fn_diamond_game_take_bet`) would
let platform staff refund from the browser. That is a permission change to a
shared wallet guard; this session's action classifier refused it as a
permission grant, so it is not in this migration. Refunds work today through a
service-role route, and no page or engine path calls the refund door.

## Delivery record

- PR #5164, every required check green (all four client unit shards, engine
  shards, CSS Beat E2E, PostgreSQL 17 accounting suite), squash-merged
  2026-09-24 04:52 UTC as `a886fbbe69a82dc0684c60c3631edddb3965f8a1`.
- Full client suite on main plus these commits before merge: 26,467 passed;
  the one failure was main's own duplicate anon allowlist entry, fixed on main
  by #5167.
- Migration: `Apply Merged Migration` run 35958324928 on main `ceb59aa60`,
  05:04 UTC: "not present in schema_migrations; applying as ONE transaction",
  committed in 359 ms, recorded `20260924033509
club_and_union_diamond_commerce_fixes`.
- Readback: all 35 `fn_ca_commerce_*` bodies in production are byte-identical
  (md5 of prosrc) to the qualified build of both files; the mandate key is
  `ca_commerce_renewal_mandates_entitlement_id_key`; no commerce function is
  executable by anon; the 15 browser doors are executable by authenticated;
  0 purchases, 0 trials.
- Client: `Publish Club Arena` run 35957482468 for `a886fbbe6` succeeded;
  `ca-static.smarter.poker/build-info.json` and
  `smarter.poker/hub/club-arena/build-info.json` both serve `abea9a1af`,
  one commit ahead of the merge and containing it. The served chunk
  `ClubDiamondCostsPage-DtL3iof--v6.js` carries the new code (Buy For A
  Covered Club, Retry Same Order, Authorize At Trial End, the new refusal
  copy).
- Page render: headless at 393px and 1280px with RPCs mocked from the two
  migrations; twelve visual defects found and fixed in `30d297b96`, no
  horizontal overflow, no decimals, no em dash in any state.
- Engine: the renewal consumer (in main since #5077) is not live yet. Every
  engine release since 2026-09-21 fails at "Publish Through Hetzner" (legacy
  checkpoint cleanup refused), owned by the release workstream (#5161). The
  engine is `8825af51`. The production-doors gate that refused builds while
  the commerce functions were missing now passes. Nothing is due: no mandate
  exists.
