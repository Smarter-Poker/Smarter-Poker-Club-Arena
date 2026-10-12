# Stranded satellite part two keeps its interval

The uninstalled part-two migration used September 17 at 21:45 UTC for both
ends of its selection. It therefore selected no tickets and always refused
its expected 190 tickets / 7,730.00 chips. Its live proof also described that
empty interval. The already-written settlement account identifies the actual
part-two interval: September 12 at 19:00 through September 17 at 21:45 UTC.

Read-only production evidence on October 12 confirms all five contiguous
windows: 190 / 14,660.00; 190 / 7,730.00; 190 / 14,070.00; 190 / 7,500.00;
168 / 11,160.00. Part two's migration version and name were absent from the
production ledger, so this corrects its uninstalled source. Installed
migrations are unchanged.

The selector, remaining-ticket assertion and live proof now share the correct
lower bound. A preimage check refuses a different count or total before any
payment door is called. The existing exact settlement and receipt assertions
remain in place.

The native PostgreSQL 17 qualification executes the full corrected migration
and the actual closed-target predicate. It reproduces the empty-range failure,
proves the corrected 190-ticket selection and receipt total, keeps adjacent
boundaries and ineligible tickets untouched, and refuses replay, missing
tickets and changed amounts before payment. Its payment door is a receipt
fixture; it proves cohort selection and transaction guards, not production
payment execution. The qualification runs in the existing accounting CI
shard. The source law also checks all five intervals for gaps or overlaps.

Production installation and financial readback remain with the Diamond Wallet
delivery owner. This correction performs no production writes.
