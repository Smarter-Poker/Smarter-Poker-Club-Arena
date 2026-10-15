# Roster Last Seen Is The Latest Activity

Read live on 2026-10-15 in SHARK CLUB's Player Management: players who were At
Table minutes earlier showed "Seen 7mo Ago" once they stood up.

Cause: `ca_club_roster_rows` reported activity as
`coalesce(last_login, last_seen, last_active_at)`, which picks the first
non-null value. `profiles.last_login` is written only by an interactive sign-in,
so it is months old for long sessions and for every horse, while `last_seen` is
current. The same value drives the Recent Activity sort, the export and the
Inactive 30/60/90 filters, so active players also sorted last and filtered as
inactive. `ca_club_member_detail` had the same expression.

Fix (`20261015093645`): `greatest(...)` of the same columns in both functions,
patched against their exact current definitions.
