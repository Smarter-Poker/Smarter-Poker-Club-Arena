# The books survive the arena being torn out

2026-09-08. `supabase/migrations/20260908132937_the_books_survive_the_arena.sql`.

The Diamond Arena is being rebuilt from scratch by another agent, and everything
that previously existed is going. This migration touches none of it. It removes
the reason their teardown would have taken the diamond books down with it.

## The hazard

Three core accounting surfaces called `fn_ca_arena_diamonds()` directly:

| Surface                       | What it does                                  |
| ----------------------------- | --------------------------------------------- |
| `fn_ca_diamond_trial_balance` | proves players + house + float = the register |
| `fn_ca_diamond_snapshot`      | the hourly deploy gate                        |
| `fn_ca_diamond_economy`       | the economy report                            |

Drop that one function - which any honest teardown would - and all three fail.
The snapshot runs hourly and is what tells anybody the supply is sound, so the
platform would have lost its accounting the moment the arena lost its code, and
the first symptom would have been silence rather than an error somebody reads.

## The fix

The accounting side owns its own reader now.
`fn_ca_diamond_offledger_float()` answers one question: how many diamonds does a
player own that are not in `profiles.diamonds`?

The two answers are kept apart, which is the point:

- **no arena exists** - returns 0, and 0 is the truth: nothing is parked anywhere,
  so the books balance on players and house alone;
- **an arena exists but cannot be read** - it RAISES. It does not return 0. A
  float that cannot be measured is not a float of zero, and the books must refuse
  to publish a balance they could not compute rather than publish a wrong one
  that looks right (CLAUDE.md 10.86).

## Proved by doing the teardown

The rolled-back probe dropped `fn_ca_arena_diamonds()`, both arena doors and
`ca_arena_settings` - exactly what the rebuild will do - and then checked the
books. The float read 0, the register identity stayed at `0.00`, and the economy
report still returned its 30 rows.

## The contract for the new arena

Written up in `docs/DIAMOND-ARENA-REBUILD-CONTRACT.md`: provide
`public.fn_ca_arena_diamonds()` if diamonds can sit outside the player wallet,
provide nothing if they cannot, and declare your journal movement kinds so they
are not misclassified as issuance or retirement the way the old ones were.
