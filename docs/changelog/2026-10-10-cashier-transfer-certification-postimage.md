# Certify the installed Diamond transfer refusal

The production cashier database gate in run 38093341921 failed after the
independently qualified deleted-player transfer migration was installed. Its
release contract still expected the preceding function definition. Update only
that exact postimage pin to `655fd3a4fc415ef0032bb8799ee9e842`.

The installed migration `20261010220349_deleted_players_cannot_transfer_diamonds.sql`
retains receipt replay before the new refusal and uses the existing ordered
profile locks. The original isolated PostgreSQL qualification passed 34 checks,
including unchanged wallets/journal on refusal, immutable receipt replay,
deleted sender refusal, and allowed retained null-status profiles. Production
catalogue readback agrees with the qualified hash, postgres owner, pinned search
path and existing execution grants. No migration is replayed by this correction.

The maintained runner regression now binds the certification pin to that actual
isolated writer qualification and its SHA-bound migration installation proof.
It failed against the old pin and passes after the correction; all 21 focused
cashier contract tests pass. Required hosted checks, normal publication and the
corrected production database gate remain separate delivery evidence.
