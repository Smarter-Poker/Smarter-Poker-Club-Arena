# Original all-in runout obligations reach stats

The accepted stats projector omitted `all_in_equity_owed`, and the shared facts
builder did not emit it. An original cards-to-come runout could therefore leave
the durable witness false, hiding a missing equity recording.

HandController now retains its first immutable runout witness before remaining
cards or asynchronous equity work. Both physical settlement and Lightning pass
that private, hand-scoped witness to the existing builder. It covers the active
shove, calling and covering actors, including forced all-ins, and excludes folded
actors. River and fold-only endings create no obligation. Successful equity and
EV calculations are unchanged; a missing equity remains null with an owed witness.

Migration `20261026181909` patches only the current accepted-facts projector,
preserving paired daily counts and the physical seat clock. New facts persist the
boolean, absent legacy fields mean false, and immutable source/row conflicts
remain refusals. It does not backfill or rewrite historical facts or receipts.
The migration must be installed and read back before claiming the new runtime's
witness persistence. Existing installations must never be replayed.

Qualification: the new real Lightning street/fold regressions fail against the
original source and pass after repair. The actual PG17 projector reproduces the
dropped true witness before the candidate; all 58 native checks then execute the
candidate alongside the existing paired-count, concurrency, rollback, permissions
and seat-clock controls. The maintained `CI - Build & Type Safety` shard 4 already
executes this extended `scripts/ci/test-horse-daily-counts.py` check. Focused shared
builder tests compare captured equity, EV and transfers with and without the
witness. Source qualification does not establish production installation or
natural runout coverage.
