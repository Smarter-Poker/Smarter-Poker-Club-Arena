# Weekly accounting authority candidate

**UNAPPLIED. Source review is continuing. No protected execution or release receipt exists for the final package.**

The ordered forward components live outside `supabase/migrations` to prevent an ordinary migration scan from activating an incomplete financial cutover. Installed migration mirrors remain in the normal migration directory. There is one intended accounting coordinator, one source authority per earning instrument, one journaled weekly scope, and one invoice/notification route.

`scripts/ci/build-weekly-accounting-activation.py` is the source for the ordered atomic bundle. It requires an explicit `--output-dir` in reserved artifacts outside this source checkout, and emits one outer transaction and a manifest binding every component. It refuses unlisted component files. Only the protected pipeline may execute that builder and qualification plan under the current owner policy. Added source components must be included before final generation; a previous bundle cannot stand in for the final reviewed tree.

`historical/17-component-candidate.sql` and `historical/17-component-manifest.json` preserve the earlier locally replayed bytes. They are intentionally not the current candidate and exclude later P&L and scheduling fixes. Do not install them.

Before activation, the protected plan must qualify exact live preimages and schema dependencies, compatible receipt readers and daemon rollout order, all required checks on final source, commercial allocation terms, historical exception disposition, complete P&L evidence, migration rollback boundaries, and the publication/observation path. Missing terms or incomplete evidence must remain visible blocked work. It must never become an invented balance, guessed rate or silent successful close.

After any successful financial run, reverse migration is not a financial rollback. Preserve immutable sources, period claims, paid receipts, invoices and notifications. A corrective change requires reconciled forward action with explicit authority; it must not delete evidence or repeat already posted transfers.
