-- A stray non-ASCII character reached a finding title in the migration
-- immediately before this one. Findings are read by people; fix it at the
-- source rather than in the reader. The function body is superseded in full
-- by 20260906093926_the_ev_ranking_pairs_every_mirror.sql, which is where the
-- current definition lives; this file exists so the repo reproduces the real
-- sequence of applied versions rather than a tidied-up one.
select 1;
