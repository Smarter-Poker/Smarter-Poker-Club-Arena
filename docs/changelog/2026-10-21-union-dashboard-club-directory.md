# Union Dashboard club directory

Follow-up to the Union Bank fix (#7621). A sweep of every browser query against the twelve tables that carry column-level SELECT grants found one more embedded wildcard: the Union Dashboard read `union_clubs` with `clubs:club_id(*)`. PostgREST expands that to every club column, including the withheld money columns, and refuses the whole read with `permission denied for table clubs`, so the dashboard's clubs, club treasuries and agent lists failed to load.

The dashboard now reads club identity only (`id, club_id, name, member_count, active_tables`) and takes each club's treasury and this week's rake from `fn_club_money_panel`, the SECURITY DEFINER read that checks union staff on the server. A refused or failed panel shows the figure as unknown ("-"), never 0. The per-club rake label now reads "Rake This Week", which is what the panel reports.

`tests/union-dashboard-club-directory.test.ts` pins the projection and the panel folding, and scans all of `src/` so no browser query can ask a column-protected table for every column again, as an embedded `(*)` or as `.from('<table>').select('*')`.

No database, grant, money RPC or engine change.
