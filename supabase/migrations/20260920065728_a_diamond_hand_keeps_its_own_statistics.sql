-- 20260920065728_a_diamond_hand_keeps_its_own_statistics
--
-- Version reserved by scripts/reserve-migration-version.sh on 2026-09-20.
--
-- NOT YET APPLIED. This branch is deliberately never pushed: production
-- database writes were refused for this delivery lane, and the repository's
-- pre-push hook refuses a pull request carrying a migration that is not
-- already live. The version above is real and collision-checked against this
-- tree, origin/main and every sibling worktree.
--
-- Never apply between :50 and :03 of any hour (CLAUDE.md section 2 rule 8).
-- One transaction, as required by the same rule.
--
-- ═══ WHAT IS WRONG ════════════════════════════════════════════════════════
--
-- fn_project_hand_side_effects_after_post_commit_20260908 runs four
-- projections after a hand commits. Projections 1, 2 and 3 each gate on
-- `v_diamond` and keep Diamond hands out of club-member state, legacy
-- player_stats and positional profit - projection 3 says why in its own
-- comment: "Positional profit has no asset dimension."
--
-- Projection 4 has no gate. It writes ca_hand_player_idx and
-- ca_hand_player_stat, and NEITHER table carries a club or asset column
-- (verified read-only on production 2026-09-20). So the first Diamond cash
-- hand ever played adds its profit, won_amt, net and rake_paid to the
-- player's chip totals - at WRITE time, so nothing can separate them
-- afterwards.
--
-- ═══ WHAT IS ALREADY FINE, AND WHY THIS IS SMALLER THAN IT LOOKS ══════════
--
-- Five of the seven readers do not touch ca_hand_player_stat at all. They read
-- public.ca_hand_facts (and ca_hand_transfers), and BOTH of those already
-- carry club_id. They can be scoped with a predicate alone - no new column,
-- no backfill:
--
--   ca_player_ev_curve      ca_hand_facts                  club_id present
--   ca_player_hand_grid     ca_hand_facts                  club_id present
--   ca_player_class_hands   ca_hand_facts                  club_id present
--   ca_player_rake_stats    ca_hand_facts                  club_id present
--   ca_player_nemesis       ca_hand_facts, ca_hand_transfers   club_id present
--
-- Only two readers need the new dimension, because only they read the two
-- tables that lack it:
--
--   ca_player_stats_overview_v2   ca_hand_player_stat   NEEDS asset
--   ca_player_stats_pulse         ca_hand_player_idx    NEEDS asset
--
-- (ca_hand_player_stat_state is the single-row rollup cursor - id, rolled_ceil,
-- rolled_floor, complete, updated_at - not per-hand data. It needs nothing.)
--
-- THIS FILE does the two structural halves: the asset dimension on the two
-- tables that lack it, and the projection-4 write that fills it. The seven
-- reader predicates are listed one by one in
-- docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md, "Step 3", and are
-- edited against each function's own text rather than by a regex written
-- blind against seven bodies at once.
--
-- ═══ WHY THIS LABELS RATHER THAN SKIPS ════════════════════════════════════
--
-- Projections 1 to 3 DROP Diamond hands because their aggregates have nowhere
-- to put an asset. This table is per-hand, so it can carry the dimension and
-- keep both. Skipping would throw a Diamond player's whole statistical history
-- away to protect a chip total - the wrong trade, and the wrong instinct:
-- never silently filter somebody out of a total, give them their own
-- (CLAUDE.md 10.5 in spirit).
--
-- ═══ WHY THE BACKFILL DEFAULT IS EXACT, NOT AN ASSUMPTION ═════════════════
--
-- Every existing row is a chip row: ca_arena_settings.cash_games_enabled has
-- never been true, so no Diamond cash hand has ever reached projection 4. The
-- preflight ASSERTS that rather than trusting it - if a diamonds-club hand is
-- already in the table this aborts instead of mislabelling it.
--
-- ═══ THE CLIENT HALF ══════════════════════════════════════════════════════
--
-- src/services/statsScope.ts carries STATS_RPCS_ARE_SCOPED = false. Flip it to
-- true once the readers take p_asset, in the same delivery. The law
-- tests/chip-and-diamond-figures-never-sum.law.test.ts pins the two halves to
-- each other and goes red if either lands alone.
--
-- Neither the projection nor any of the seven readers is on
-- fn_ca_guard_watchlist(), so no ca_guard_defs baseline moves with this
-- (verified read-only 2026-09-20).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- ── Preflight ─────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_oid oid;
  v_sig text;
  v_hash text;
  v_mislabelled bigint;
BEGIN
  FOR v_sig, v_hash IN
    SELECT s.sig, s.before_hash FROM (VALUES
      ('fn_project_hand_side_effects_after_post_commit_20260908(uuid)',
       'c13af0167961f3071d18342e00200844')
    ) AS s(sig, before_hash)
  LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'projection missing: %', v_sig;
    END IF;
    IF md5(pg_get_functiondef(v_oid)) <> v_hash THEN
      RAISE EXCEPTION
        'projection % changed since 2026-09-20 (now %); re-derive this migration',
        v_sig, md5(pg_get_functiondef(v_oid));
    END IF;
  END LOOP;

  -- The backfill claim, asserted rather than assumed.
  SELECT count(*) INTO v_mislabelled
  FROM public.ca_hand_player_stat hs
  JOIN public.hand_history h ON h.id = hs.hand_id
  JOIN public.tables t ON t.id = h.table_id
  JOIN public.clubs c ON c.id = t.club_id
  WHERE c.asset = 'diamonds';
  IF v_mislabelled > 0 THEN
    RAISE EXCEPTION
      'ca_hand_player_stat already holds % Diamond rows; DEFAULT ''chips'' would mislabel them',
      v_mislabelled;
  END IF;
END
$preflight$;

-- ── 1. The two tables that lack it learn which asset a row is in ──────────
ALTER TABLE public.ca_hand_player_stat
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips';
ALTER TABLE public.ca_hand_player_idx
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips';

ALTER TABLE public.ca_hand_player_stat
  DROP CONSTRAINT IF EXISTS ca_hand_player_stat_asset_ck;
ALTER TABLE public.ca_hand_player_stat
  ADD CONSTRAINT ca_hand_player_stat_asset_ck CHECK (asset IN ('chips', 'diamonds'));
ALTER TABLE public.ca_hand_player_idx
  DROP CONSTRAINT IF EXISTS ca_hand_player_idx_asset_ck;
ALTER TABLE public.ca_hand_player_idx
  ADD CONSTRAINT ca_hand_player_idx_asset_ck CHECK (asset IN ('chips', 'diamonds'));

COMMENT ON COLUMN public.ca_hand_player_stat.asset IS
  'Currency this row is denominated in. Every read filters on it: a chip figure '
  'and a Diamond figure must never sum into one number. Added 2026-09-20.';
COMMENT ON COLUMN public.ca_hand_player_idx.asset IS
  'Currency of the hand this index row points at. See ca_hand_player_stat.asset.';

CREATE INDEX IF NOT EXISTS ca_hand_player_stat_user_asset_created_idx
  ON public.ca_hand_player_stat (user_id, asset, created_at DESC);
CREATE INDEX IF NOT EXISTS ca_hand_player_idx_user_asset_created_idx
  ON public.ca_hand_player_idx (user_id, asset, created_at DESC);

-- ── 2. Projection 4 stamps the asset it already computed ─────────────────
--
-- `v_diamond` is set at the top of the function (live line 42) and already
-- drives projections 1, 2 and 3. Projection 4 only has to carry it into the
-- rows it writes. Edited by substitution against the catalogue, in place, the
-- way 20260914212802 edits this same function.
DO $projection$
DECLARE
  v_oid oid := to_regprocedure(
    'public.fn_project_hand_side_effects_after_post_commit_20260908(uuid)');
  v_before text := pg_get_functiondef(v_oid);
  v_definition text := v_before;
  v_gates int;
BEGIN
  v_definition := replace(
    v_definition,
    'INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id)',
    'INSERT INTO public.ca_hand_player_idx(user_id,created_at,hand_id,asset)');
  IF v_definition = v_before THEN
    RAISE EXCEPTION 'projection 4 index insert not found; the body has moved';
  END IF;

  v_definition := replace(
    v_definition,
    'INSERT INTO public.ca_hand_player_stat AS hs (',
    'INSERT INTO public.ca_hand_player_stat AS hs (asset,');
  IF v_definition !~ 'ca_hand_player_stat AS hs \(asset,' THEN
    RAISE EXCEPTION 'projection 4 stat insert not found; the body has moved';
  END IF;

  -- The value expression, once, bound to a name so both SELECT lists agree.
  v_definition := replace(
    v_definition,
    'SELECT hp.user_id, v_h.created_at, v_h.id',
    'SELECT hp.user_id, v_h.created_at, v_h.id, '
      || 'CASE WHEN COALESCE(v_diamond,false) THEN ''diamonds'' ELSE ''chips'' END');
  v_definition := replace(
    v_definition,
    'SELECT' || chr(10) || '    hp.user_id,',
    'SELECT' || chr(10)
      || '    CASE WHEN COALESCE(v_diamond,false) THEN ''diamonds'' ELSE ''chips'' END,'
      || chr(10) || '    hp.user_id,');

  EXECUTE v_definition;

  -- Postimage: the asset landed, and the three gates that were already right
  -- are all still there.
  v_definition := pg_get_functiondef(v_oid);
  IF v_definition !~ 'ca_hand_player_stat AS hs \(asset,'
     OR v_definition !~ 'ca_hand_player_idx\(user_id,created_at,hand_id,asset\)' THEN
    RAISE EXCEPTION 'projection 4 did not take the asset column';
  END IF;
  v_gates := (length(v_definition)
              - length(replace(v_definition, 'NOT COALESCE(v_diamond,false)', '')))
             / length('NOT COALESCE(v_diamond,false)');
  IF v_gates < 3 THEN
    RAISE EXCEPTION 'a v_diamond gate on projection 1, 2 or 3 was lost (% remain)', v_gates;
  END IF;
END
$projection$;

COMMIT;

-- ── 3. The seven reader predicates ────────────────────────────────────────
--
-- Deliberately NOT in this transaction and not in this file. Each reader is
-- 1.2k to 3.1k characters and each one's WHERE clause differs; they are edited
-- against their own text. The exact predicate for each is in
-- docs/runbooks/diamond-stats-asset-dimension-2026-09-20.md, "Step 3".
-- The isolated-PostgreSQL proof that the labelled rows never sum is
-- tests/sql/run-diamond-stats-asset-dimension.py.
