-- @live-proof: (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE (n.nspname, c.relname) IN (('public','hand_atomic_commits'), ('public','hand_history'),
--           ('public','ca_hand_player_idx'), ('smarter_private','f06_hand_permits'))
--     AND array_to_string(c.reloptions,',') LIKE '%autovacuum_analyze_scale_factor=0%'
--     AND array_to_string(c.reloptions,',') LIKE '%autovacuum_analyze_threshold=%') = 4
-- THE RESUME PATH PLANS ON CURRENT STATISTICS (2026-09-28)
--
-- fn_ca_resume_hand_submission picks its candidate with one query (line 8). On
-- 2026-09-28 that query was the single largest source of statement timeouts on
-- the platform: 4,443 cancellations in seven and a half hours, measured at
-- 57,367 ms against the 8s engine budget, answering "nothing to resume" for a
-- table that had 19,767 submissions and 0 unresolved.
--
-- IT WAS NEVER A MISSING INDEX. Every column the query filters on is indexed,
-- and a covering index does not help: measured on a disposable PostgreSQL 17
-- cluster, the planner keeps the unique hand_number path and ignores a wider
-- covering index, because a unique equality lookup already costs "1 row".
--
-- THE PLANNER WAS FLYING BLIND. public.hand_atomic_commits carries 3.78M rows
-- in 11 GB and had analyze_count = 0, last_autoanalyze = NULL: it had never
-- been analyzed, not once. It was given aggressive VACUUM settings and no
-- ANALYZE settings, so autovacuum ran 11 times while autoanalyze still used
-- the global rule of 50 + 10% of the table, which is 377,643 modifications.
-- n_mod_since_analyze stood at 374,433, just under that bar, so it never
-- fired. smarter_private.hand_submissions, hand_submission_disposals and
-- f06_hand_permits declared no storage parameters at all; f06_hand_permits
-- held more dead tuples (93,527) than live ones (93,296).
--
-- With stale estimates the planner costed LIMIT 1 at 6.35 and chose a nested
-- loop that probes hand_atomic_commits once per candidate row through the
-- unique hand_number index, which is 16,065 random heap fetches into 11 GB
-- (84,282 buffers, 31,567 of them read from disk). With current statistics it
-- chooses an ordered merge against hand_atomic_commits_pkey and the same query
-- runs in 112 ms warm. That is the same query, the same data, the same
-- indexes: only the statistics changed.
--
-- THE FIX IS THE POLICY, NOT THE ANALYZE. A one off ANALYZE goes stale again.
-- These four tables now carry the analyze policy the money tables already had
-- (chip_ledger and tournaments both declare autovacuum_analyze_scale_factor 0
-- with an absolute threshold), so their statistics can never drift by a tenth
-- of the table again. No cron, no repair function, no retry, no raised
-- timeout: the work now fits because the planner can see.

ALTER TABLE public.hand_atomic_commits SET (
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 20000
);

ALTER TABLE smarter_private.hand_submissions SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 20000,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 20000
);

ALTER TABLE smarter_private.hand_submission_disposals SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 5000
);

ALTER TABLE smarter_private.f06_hand_permits SET (
  autovacuum_enabled = true,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 5000
);

ANALYZE public.hand_atomic_commits;
ANALYZE smarter_private.hand_submissions;
ANALYZE smarter_private.hand_submission_disposals;
ANALYZE smarter_private.f06_hand_permits;
