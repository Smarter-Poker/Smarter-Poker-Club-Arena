# Eleven migrations were live in production and absent from git

**2026-09-03.** `applied-migrations-recorded.yml` was red and `Post-Deploy E2E`
had failed four runs straight on

    cashier function drift: public.fn_club_cashier_members_page_v3(...)
    expected 952e98a237f975ca9bac24251efe6d54, got 69233cd46670fbc2989173f6ba9f4328

Both had the same cause: eleven migrations applied to production today existed
**nowhere in git** - not on `main`, not on any branch. The repo could not
reproduce the database, and nobody could review what had been applied.

## Nothing was lost

Supabase keeps the applied SQL in `supabase_migrations.schema_migrations.statements`,
and all eleven had a body. Each file here is that recorded SQL, verbatim, with a
header saying when it was applied and that re-applying it is a no-op. **These
are recoveries, not reconstructions** - nobody guessed at what the database
does.

| applied (UTC) | migration                                                   |
| ------------- | ----------------------------------------------------------- |
| 03:21:51      | one_definition_each_and_the_snapshot_pages                  |
| 03:28:28      | player_search_escapes_like_wildcards                        |
| 03:52:52      | four_rpcs_still_told_a_super_agent_which_players_are_horses |
| 04:19:23      | the_agent_table_says_what_the_agent_costs                   |
| 04:21:07      | commission_that_belongs_to_nobody_listed_is_still_owed      |
| 04:40:23      | a_search_narrows_the_list_not_the_denominator               |
| 04:44:30      | the_agent_table_can_be_searched_and_sorted                  |
| 04:45:07      | the_count_is_of_matches_not_of_the_page_you_landed_on       |
| 04:50:23      | a_row_says_whether_it_opens                                 |
| 04:51:09      | the_snapshot_carries_the_search_and_the_sort                |
| 05:10:36      | the_union_card_counts_its_own_tables_again                  |

## One of them is a security fix, which is why this mattered

`four_rpcs_still_told_a_super_agent_which_players_are_horses` masks the horse
flag in `ca_club_player_breakdown`, `ca_club_player_page`,
`ca_club_player_export_start` and `fn_club_cashier_members_page_v3`. The first
three are gated by `ca_can_view_club_finances`, which admits `SUPER_AGENT` - a
role `fn_can_see_horse_flag` deliberately excludes - so a super agent opening
Club Data was being told, row by row, which players are horses. The fourth is
the ordinary version of the mistake: `v2` masked and the paged `v3` written
after it did not, so the same data leaked through the newer door.

A fix of that shape living only in the database, with no file to review, is the
argument for the ledger rule in one example.

## The contract hash

That same migration is what moved `fn_club_cashier_members_page_v3`. The pin in
`scripts/verification-harness/cashier-release-contract.sql` still named the old
body, so the check was correctly reporting a real difference between the repo
and production - it was the repo that was wrong.

Re-pinned to the live hash, with the reason written beside it. **Every other
hash in that file was re-checked against production in the same pass and all
five still match**, so this is one intended change and not a stale contract.

## Why this is being fixed by someone else's hand

This is the club-data agent's work and their pull requests are still open. The
files are theirs; only the recording was missing. If they commit the same
migrations, git will show identical content and the duplicate resolves itself -
that is a far better failure than production keeping schema nobody can review.
