-- 20261003091015_a_commission_rollup_reads_only_what_no_settlement_covers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A COMMISSION ROLLUP READS ONLY WHAT NO SETTLEMENT COVERS
--
-- Round 2 of the weekly close (fn_settle_accounting_commission_stage) ends by
-- calling fn_agent_commission_rollup_recompute for every (club, agent) it
-- paid. The rollup counts a commission row while it is open (settled_at IS
-- NULL) and no agent_commission_settlements period of its (club, user)
-- covers its created_at. Routing v3 never sets settled_at, so every open row
-- the pair ever had was read and probed against the settlements, forever
-- growing: 517 s of the 2026-10-01 Midway close (auto_explain, job 391; 142
-- pairs). The open week 2026-09-28 alone holds 3.86M rows for those pairs.
--
-- WHAT CHANGES (fn_agent_commission_rollup_recompute only; one exact anchor
-- on the 2026-10-03 preimage, the fresh CTE): the pair's settlement periods
-- that cover anything (period_start < period_end; both columns are NOT NULL)
-- are merged, and only the ranges they do NOT cover are read, through
-- agent_commissions_open_idx (club_id, user_id, created_at) INCLUDE (amount,
-- id) WHERE settled_at IS NULL. A row whose created_at is NULL or
-- 'infinity' can never be covered (created_at < period_end is never true)
-- and is read by its own index condition. Same predicate, same rows, same
-- sum, count and minimum; the upsert is unchanged.
--
-- PROOF (production, read-only, 2026-10-03 09:56Z, both forms in ONE
-- statement so they share a snapshot): every (club, user) with a settlement
-- plus up to 60 pairs active in the last 10 minutes, 145 pairs:
--   old md5 48af8c6d427aa4778672677f2b604e1f, 7,523,239 rows, owed 2,365,141.87
--   new md5 48af8c6d427aa4778672677f2b604e1f, 7,523,239 rows, owed 2,365,141.87
-- (an earlier run with the NULL/'infinity' branch written as one OR matched
-- too: e7d7553432d8129a917ad9973c230a4d). The new form alone read those 145
-- pairs in 55.6 s, nearly all of it the still-open week 2026-09-28, which
-- the next close covers; the old form needs the whole history every week.
--
-- @live-proof: position('agent_commissions_open_idx, instead of every open row' in pg_get_functiondef('public.fn_agent_commission_rollup_recompute(jsonb)'::regprocedure)) > 0
-- @live-proof: position('AND ac.created_at = ''infinity''::timestamptz' in pg_get_functiondef('public.fn_agent_commission_rollup_recompute(jsonb)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- rollup recompute
 s:='public.fn_agent_commission_rollup_recompute(jsonb)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'5df64c45d986b47ceca85d17ecd37e2f' THEN RAISE EXCEPTION 'rollup recompute preimage %',md5(d); END IF;
 a:=$a$  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(ac.amount), 0)  AS owed,
           count(ac.id)                 AS rows_behind,
           min(ac.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY pr.club_id, pr.user_id
  )
$a$;
 r:=$r$  -- WEEKLY CLOSE SCALE (20261003): a commission row counts when it is open
  -- (settled_at IS NULL) and no settlement period of its (club, player)
  -- covers its created_at. The periods are merged into the ranges they do
  -- NOT cover and only those ranges are read through
  -- agent_commissions_open_idx, instead of every open row the pair ever had
  -- each probing the settlements (517 s in the 2026-10-01 Midway close).
  -- Same predicate, same rows, same sums.
  WITH pairs AS (
    SELECT DISTINCT (p->>'club_id')::uuid AS club_id, (p->>'user_id')::uuid AS user_id
      FROM jsonb_array_elements(p_pairs) p
     WHERE p->>'club_id' IS NOT NULL AND p->>'user_id' IS NOT NULL
  ),
  -- The pair's settlement periods that cover anything (start < end), each
  -- with the furthest end of the periods sorted before it.
  covered AS MATERIALIZED (
    SELECT s.club_id, s.user_id, s.period_start, s.period_end,
           max(s.period_end) OVER (PARTITION BY s.club_id, s.user_id ORDER BY s.period_start, s.period_end
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS reach
      FROM pairs pr JOIN public.agent_commission_settlements s ON s.club_id = pr.club_id AND s.user_id = pr.user_id
     WHERE s.period_start < s.period_end
  ),
  -- The complement of their union: [lo, hi) ranges no settlement covers.
  gaps AS MATERIALIZED (
    SELECT c.club_id, c.user_id, COALESCE(c.reach, '-infinity'::timestamptz) AS lo, c.period_start AS hi
      FROM covered c WHERE c.period_start > COALESCE(c.reach, '-infinity'::timestamptz)
    UNION ALL
    SELECT pr.club_id, pr.user_id,
           COALESCE((SELECT max(c.period_end) FROM covered c WHERE c.club_id = pr.club_id AND c.user_id = pr.user_id),
                    '-infinity'::timestamptz), 'infinity'::timestamptz
      FROM pairs pr
  ),
  open_rows AS (
    SELECT g.club_id, g.user_id, ac.id, ac.amount, ac.created_at
      FROM gaps g JOIN public.agent_commissions ac
        ON ac.club_id = g.club_id AND ac.user_id = g.user_id AND ac.settled_at IS NULL
       AND ac.created_at >= g.lo AND ac.created_at < g.hi
    UNION ALL
    -- No period can cover a NULL or an 'infinity' created_at (each read by
    -- its own index condition).
    SELECT pr.club_id, pr.user_id, ac.id, ac.amount, ac.created_at
      FROM pairs pr JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id AND ac.settled_at IS NULL
       AND ac.created_at IS NULL
    UNION ALL
    SELECT pr.club_id, pr.user_id, ac.id, ac.amount, ac.created_at
      FROM pairs pr JOIN public.agent_commissions ac
        ON ac.club_id = pr.club_id AND ac.user_id = pr.user_id AND ac.settled_at IS NULL
       AND ac.created_at = 'infinity'::timestamptz
  ),
  fresh AS (
    SELECT pr.club_id, pr.user_id,
           coalesce(sum(r.amount), 0)  AS owed,
           count(r.id)                 AS rows_behind,
           min(r.created_at)           AS oldest
      FROM pairs pr
      LEFT JOIN open_rows r ON r.club_id = pr.club_id AND r.user_id = pr.user_id
     GROUP BY pr.club_id, pr.user_id
  )
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'rollup recompute anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'rollup recompute postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
