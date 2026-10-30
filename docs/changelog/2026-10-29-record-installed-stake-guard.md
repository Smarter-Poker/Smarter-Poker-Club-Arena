# Record the already-installed cash stake guard

Restore the existing migration source from open PR #8489, commit `8ccf67aec39f27dc62a23151d4fcfbbd6873f112`, under its original version `20261028223500`. The original 28-line SQL body is unchanged; only the required `BEGIN;` and `COMMIT;` envelope is added so the maintained transaction-shape check accepts the file. PR #8489 and its branch are preserved.

A bounded read-only catalog comparison found that the installed `public.fn_cash_game_max_stake_guard()` definition matches that source, excluding its leading file comment and terminal statement semicolon. Production history already contains the original version with NULL name and NULL statements. Original statement bytes and their hash therefore remain unknown; this recording makes no byte-exact installed-history claim and adds no alias or manifest exemption.

This restores missing source accounting for existing behavior; it does not change the stake policy. The ordinary applier's existing version guard returns ALREADY-APPLIED without sending SQL for this version. Do not replay the migration, fill in the NULL history fields, delete the history row or infer that this wrapper was part of the original installation.

The original unwrapped file fails the maintained transaction-shape rule. Verification of the wrapped recording uses that existing rule and the existing migration installability suite, without changing or grandfathering the test.
