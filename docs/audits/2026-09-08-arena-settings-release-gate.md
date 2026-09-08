# Arena settings foreign-key index restores the release gate

Date: 2026-09-08

The live fn_ca_fk_index_gaps('public.clubs') gate reported
ca_arena_settings.club_id without a usable index. That unrelated database change
failed the TypeScript Check job's "A Club Stays Deletable" step on PR #3668.

The table held one row / 49,152 bytes at verification. A non-partial index leading
on club_id was applied in one transaction with a two-second lock acquisition
limit. The live gate now returns gaps=[].

Applied migration: 20260908040659_arena_settings_club_foreign_key_index.
This restores the required database invariant; no check is disabled or relaxed.
