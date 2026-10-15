# Player Management Fees Count From This Week's Reset

Dan, 2026-10-15: fees should only start from this week's reset, with all old
fees removed from every horse and player account.

- `ca_club_member_fee_totals`, the one reader behind every fee figure in
  Player Management (roster rows, filters, sorts, export, downline list,
  player detail Total Fee and MTT Fee), now counts only from the current
  weekly reset: Monday 00:00 America/Los_Angeles (`fn_ca_fee_week_start`,
  built on `fn_union_week_start`), the same Monday-to-Sunday week as
  `rakeback_periods`. Every player and horse starts at zero each Monday.
- The fee ledgers are not deleted or rewritten. Agent commissions, rakeback
  and statements are paid from them, and settled records are immutable
  (CLAUDE.md 10.9). Old weeks are simply no longer counted here.
- The Simple row label reads "Fees This Week"; Metric Definitions say so.

Migration `20261015121331_player_management_fees_count_from_this_weeks_reset`.

Installed 2026-10-15 as version `20261015121331` (file renamed to match).
Read back: week starts 2026-10-12; Deep Stack Society reads 59,995.87 of fees
this week across 405 players (all tournament fees; no cash rake this week),
and the roster total equals the ledger total to the cent. Tournament receipts
are unchanged by this migration.
