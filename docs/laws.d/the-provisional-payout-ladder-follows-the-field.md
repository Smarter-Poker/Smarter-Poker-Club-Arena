# tests/the-provisional-payout-ladder-follows-the-field.law.test.ts

Dan, 2026-10-21: a live tournament shows and pays its paid depth (12.5% for
union and platform events) of the field it actually has. Until the prize pool is
finalized, `tournaments.payout_structure` is refreshed to
`fn_ca_payout_structure(current field, paid depth)` in the same transaction as
every entry and removal, by statement triggers on `tournament_players` that can
never fail an entry. The lifecycle guard admits exactly that derived ladder and
nothing else; a finalized pool, a Spin or a satellite is never touched.
