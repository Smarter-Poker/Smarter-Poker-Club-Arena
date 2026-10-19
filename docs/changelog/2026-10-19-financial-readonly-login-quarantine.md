# Financial Read-Only Login Quarantine

The Financial Admin browser certificate now aborts the exact global shell POST to `fn_achievement_record_login` as a quarantined shell write. The signed-in identity shell invokes this RPC to update the server-owned login streak and potentially award achievement diamonds; it is never permitted through the read-only RPC allowlist.

The guard still records and refuses Financial-page mutations, alternate methods and similarly named RPCs. A focused route-handler regression proves the login request is aborted without forwarding, retained in the quarantine record, and excluded from page-mutation violations while unrelated writes still fail the final assertion. No production behavior or database contract changes.
