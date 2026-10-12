# Diamond Phase 12: the retirement migrations are live

2026-10-05. Three migrations merged on October 4 are applied to production and every `@live-proof` predicate reads true:

- `20261004214251_the_legacy_diamond_arena_database_objects_are_dropped` (#6102): the two retired arena doors, their guard lines, `diamond_arena_events` and `profiles.diamond_arena_preferences` are gone.
- `20261004231413_the_diamond_snapshot_reads_the_register_once_per_holder` (#6117): the hourly snapshot reads the register once per holder; eleven consecutive hourly runs since apply succeeded, averaging 5.3 s (p95 was 26 s before).
- `20261004231057_page_preferences_count_the_row_they_wrote_and_the_dead_arena` (#6118): `update_page_preferences` counts the row it wrote instead of testing FOUND after EXECUTE, and the dead `arena_withdrawals` freeze scope is retired. World Hub's preference callers merge before saving (World Hub #2117, live at `202f005f`).

`diamond.smarter.poker` needs no deletion: it has no record of its own. The zone answers every unnamed subdomain the same way (a random name resolves to the same Vercel addresses and the same 404 NOT_FOUND), and no project serves it.

Not done from this session: archiving the old Diamond Arena repository (settings writes refused).
