# The migration ledger has two repos, and more than a thousand rows

2026-09-03. `check-applied-migrations-are-recorded` had been reporting
"5 of 1000 applied since ... have no file" for days and it was read as healthy.
Three things were wrong with it, found while making it see World Hub:

1. **PostgREST caps a response at 1,000 rows** and the RPC orders oldest-first.
   1,080 migrations had been applied since the window's floor, so the newest
   80 - everything applied on the day the check ran - were never examined.
   Paged with `limit`/`offset` (a `Range` header is ignored on this RPC,
   verified live). True count tonight: **40 unrecorded**, not 5.
2. **Two repositories write to one ledger.** World Hub's migrations were
   reported here as missing files. The sibling repo's `supabase/migrations`
   is now merged into the index.
3. **GitHub's Contents API caps a directory at 1,000 entries**, and World Hub's
   migrations directory is past that, so the first sibling lookup dropped the
   newest files too. The Git Trees API lists the whole directory.

What the honest report says now: two MLB removals cleared via World Hub;
`chip_supply_snapshot_is_incremental` clears when #2773 merges; the other 39
are tonight's diamond-economy, arena-name and horse-identity migrations whose
files sit on other agents' unmerged branches - which is the case this check
exists to name.
