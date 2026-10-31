# Keep candidate health separate from observed subjects

A bounded discovery batch contained a stale unselected table and failed before its healthy backup could be selected. Exact candidate IDs now retain the same request and returned-ID validation while using discovery semantics. Ready-table admission still excludes stale candidates; selected table health remains strict, and all-stale discovery retains named failure evidence. No health timeout, recovery assertion, engine invariant or live data changes.
