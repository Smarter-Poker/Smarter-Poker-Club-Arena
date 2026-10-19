# The Club Dashboard Players List Shows Money Only To Those Allowed To See It

The Club Dashboard "Players" tab read `ca_club_members`, which checked only that the viewer could see the club and then returned every member's chip balance and profit. A plain player saw all 200 balances on a page. Its figures were also stale: hands came from an old daily-stats table (8,586 for a member whose funded-club record shows about 102,600), profit came from the same stale source, "last active" was the join date for nearly every row, seated players at union tables were missed, and suspended members were listed.

`ca_club_members` keeps its signature and columns but now follows the same rules as Player Management (`ca_club_roster_rows`):

- Money is a per-row decision: owners, co-owners, admins, union overseers and platform admins see every row; an agent sees themself and their downline; anyone else sees names and presence only. Balance, hands, Win/Loss and last active are empty for rows the viewer may not see, and sorting by them cannot reveal a hidden ranking.
- Hands come from the funded-club member record facts.
- Win/Loss is cash results plus tournament prizes minus entries — the same figure as `ca_club_members_win_loss`.
- Last active is the latest of last login, last seen and membership activity.
- Only active/approved members are listed; seated counts include union tables.

The Blacklist Manager's member picker only shows a name, so it now calls a new identity-only reader, `ca_club_member_search`, and no longer receives balances.

Proof (production, rolled back): money rows for a player 0, for two agents 28 and 12 (self + downline), for the owner all 523, for the union overseer all 267; zero disagreements with `ca_club_roster_access`, `ca_club_roster_rows` and `ca_club_members_win_loss`. A 50-row page takes 35–141 ms, a Win/Loss-sorted page 359 ms for the owner.

Install: `supabase/migrations/20261019145553_club_members_reader_redacts_money.sql`.
