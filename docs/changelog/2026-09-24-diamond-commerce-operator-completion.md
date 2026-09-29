# Diamond Commerce: The Operator Completion

Assignment CA-DIAMOND-COMMERCE-2026-09-22 R2, the scope left after #5196 and
#5193. Branch `feat/diamond-commerce-operator-completion`.

## What changed

Server (three migrations, each one transaction with `lock_timeout`, each
pinned to the installed bodies it replaces):

- `20260924182605` catalog, terms, written quotes and trial reviews:
  - The Catalog Visible switch is honoured. While it is off, owners see no
    prices and the quote refuses `catalog_not_visible`; staff and renewals
    are unaffected. The catalog names each product's platform capability and
    whether it is available.
  - Operating Service Terms v1; the version in effect is stored on every
    trial and purchase by column default.
  - Every trial stores the waiver reason, catalog version and the prices it
    waived.
  - Quotes are limited to 120 per 10 minutes per person (`rate_limited`).
  - A quote says `free_month_available`; the page offers the free month
    first but paying is never refused.
  - Written quotes above 2,500 members: request, staff offer as a private
    capacity product priced through the normal price doors, decline,
    withdraw, and purchase through the normal order.
  - Free month review for a new independent operator: statement, staff
    approve (a 30-day `review_granted` trial for that scope) or decline.
- `20260924183529` staff metrics: `fn_ca_commerce_metrics(p_days)`.
- `20260924183657` settled earnings coverage:
  `fn_ca_commerce_earnings_coverage(scope_kind, scope_id, days)`, owner or
  staff only. Earnings are Diamond Spins daily settlements whose one wallet
  receipt matches (`diamond-spin-day:<owner>:<day>`, class `transferred`),
  less any part that paid off an earlier diamond debt. Checked read-only
  against production at 19:20 UTC: 2 settled days, 2 matched receipts.

Client:

- Owner Diamond Costs page: catalog hidden state, service terms, the free
  month on the confirm step, the capacity line, Written Quotes, Free Month
  Review, sponsor purchase of club insurance (only while its capability is
  available), Settled Earnings.
- Staff Commerce Desk: Written Quotes, Free Month Reviews and Metrics tabs.
- 393px render pass: metrics rows read "6 For 30,000 Diamonds", desk values
  no longer strand on their own line, the active tab scrolls into view, the
  offer capacity is prefilled with a thousands separator, and the earnings
  sentence introduces its figures with a colon.

CI: the completion, metrics, earnings and recovery runners are registered in
the accounting job (23 runners, 10 on a private cluster); every new object is
declared in `scripts/ci/schema-manifest.d/diamond-commerce-operator-completion.json`.

## Qualification

On isolated PostgreSQL, production migration order, Prompt 1's registry
installed first: completion 17 (7 scenarios fail for the right reason
without the migration and pass with it; the 159 base scenarios re-run with
it on top), metrics 52, earnings 9, recovery 36 (D75 ownership and deletion,
D79 restore-shaped recovery), and base 159, refunds 135, admission 30
unchanged. tsc clean; the commerce unit and render tests pass.

## Decisions

- Paying is not refused while a free month is available: an owner who wants
  to pay now may, and the free month stays available for the operator's
  first scope.
- Written quote validity (1 to 30 days) and trial ends are not given back by
  the hourly thaw. The thaw returns in-flight gameplay deadlines; a quote
  valid for days loses at most five minutes, like every other commerce
  quote and term.
- Named-club union coverage, union insurance covering club insurance and the
  overlap credit are not built while the union SKUs are withdrawn (no union
  admission point exists, so they would price rights that grant nothing).

## Delivery record

- Pull request #5212, merged 2026-09-24 20:22 UTC as
  `1f4e87fd8b59011c89f2f5bb9a333cde5a558577`. The accounting job ran all
  seven commerce runners on PostgreSQL 17 (completion 177, metrics 53,
  earnings 10, recovery 37 PASS lines). Production Build first failed on a
  Google Fonts fetch (`self-host-fonts: fetch failed`) and passed on one
  re-run of that job.
- Published by run 36054424398; both
  `https://ca-static.smarter.poker/build-info.json` and
  `https://smarter.poker/hub/club-arena/build-info.json` serve `1f4e87fd`.
  The served Commerce Desk chunk calls `fn_ca_commerce_metrics`,
  `fn_ca_commerce_written_quote_offer` and `fn_ca_commerce_trial_review_decide`;
  the served Diamond Costs chunk calls `fn_ca_commerce_earnings_coverage`,
  `fn_ca_commerce_written_quote_request` and
  `fn_ca_commerce_trial_review_request` and carries the new copy.
- Installed through Apply Merged Migration, in order, with the platform not
  frozen: `20260924182605` (run 36054810926, 20:25 UTC, 504 ms),
  `20260924183529` (run 36054926079, 20:26 UTC, 118 ms), `20260924183657`
  (run 36055047142, 20:28 UTC). A first dispatch (run 36054669422) was
  refused by the workflow before touching the database because the input
  carried the directory; the input is the bare filename.
- Readback: all three versions are recorded. Every commerce function body in
  production is md5-identical to the isolated build of the same migration
  order (65 commerce functions; the admission doors were read back
  identical at 14:16). `service_terms` v1 exists; the written-quote and
  review tables are empty; the new browser doors are executable by
  `authenticated` and not by `anon`; the waiver trigger function is callable
  by neither.
