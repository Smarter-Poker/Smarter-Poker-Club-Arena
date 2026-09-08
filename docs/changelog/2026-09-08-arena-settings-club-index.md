# Club settings foreign key index

CI found that ca_arena_settings.club_id lacked an index, causing club deletion checks to require a sequential scan. Added the missing btree index without weakening the invariant gate. Applied migration 20260908040757 and verified its live pg_indexes definition. The table occupied 32 KB at inspection. A five-second lock timeout bounds deployment lock acquisition.
