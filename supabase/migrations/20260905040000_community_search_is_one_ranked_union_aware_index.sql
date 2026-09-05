-- =============================================================================
-- COMMUNITY SEARCH IS ONE RANKED, UNION-AWARE INDEX  (2026-09-05)
-- =============================================================================
--
-- WHY
--   /search ran four raw `ilike '%q%'` selects from the browser. Dan, on
--   2026-09-04, searching MIDWAY:
--     - "displaying Midway Union with only 328 members, instead of the real
--       total" - the page read the stale `clubs.member_count` column of the
--       union's HOUSE row. A union's total is every club's members added up
--       (Dan 2026-08-24, recorded in ClubHomePage.tsx), which
--       `fn_batch_union_realtime_member_counts` already computes: 1,177.
--     - "not pulling real club images" - it read `clubs.avatar_url` (null for
--       Midway Union) and never `logo_url`, where the logo actually is.
--     - "the fuzzy match doesn't match right" - there was no fuzzy match: a
--       substring test with no ranking, no typo tolerance, no multi-word
--       matching, and no slug / club-number match. Players were searched with
--       a raw ilike on profiles, bypassing `fn_search_players` (trigram,
--       relationship, presence) AND the discoverable/privacy preferences it
--       enforces.
--
-- WHAT
--   fn_community_search(p_query, p_scope, p_limit) -> jsonb
--     One SECURITY DEFINER call returning clubs, tables and tournaments that
--     match a tokenised, trigram-fuzzy query, ranked exact > prefix > word >
--     substring > fuzzy, with:
--       clubs ........ live member count (union-aware), live open-table and
--                      seated counts, resolved image (logo_url > avatar_url >
--                      logo), card image, viewer membership status
--       tables ....... club name/slug, variant, stakes, seats, status;
--                      visibility re-applies the tables_select_scoped rule
--       tournaments .. club, status, buy-in, guarantee, players, start time,
--                      whether the viewer is registered; visibility re-applies
--                      tournaments_select_scoped
--       index_health . live record counts per index, so the page's "Live
--                      Indexes" metric is measured rather than the literal 4
--       totals ....... matches per index before the limit
--     Players are NOT here: the page calls fn_search_players, which already
--     owns fuzzy player matching and privacy. Two owners of one rule is the
--     bug shape section 10.5 of CLAUDE.md warns about.
--
--   fn_community_search_score(haystack, tokens, fuzzy) -> real
--     The one matching rule, shared by all three indexes. NULL = no match.
--     Every token must land: exact 1.0, start-of-string/word 0.95,
--     substring 0.85, else (fuzzy, token >= 3 chars) 0.4 + 0.4 *
--     word_similarity when word_similarity >= 0.5. The score is the average
--     across tokens.
--
-- SAFETY
--   One transaction: two CREATE FUNCTION + grants = one PostgREST reload.
--   Probed 2026-09-05 as pg_temp copies inside BEGIN/ROLLBACK against
--   production with request.jwt.claims set to Dan's uid (see the changelog
--   for the measured output). No writes. STABLE. Authenticated only.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_community_search_score(
  p_hay text,
  p_tokens text[],
  p_fuzzy boolean
) RETURNS real
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'extensions'
AS $$
  WITH hay AS (
    SELECT lower(coalesce(p_hay, '')) AS h
  ),
  per AS (
    SELECT
      CASE
        WHEN position(t IN h) > 0 THEN
          CASE
            WHEN h = t THEN 1.0
            WHEN h LIKE t || '%' OR h LIKE '% ' || t || '%' THEN 0.95
            ELSE 0.85
          END
        WHEN p_fuzzy AND length(t) >= 3 AND word_similarity(t, h) >= 0.5 THEN
          0.4 + 0.4 * word_similarity(t, h)
        ELSE NULL
      END AS s
    FROM hay, unnest(coalesce(p_tokens, '{}'::text[])) AS t
  )
  SELECT CASE
           WHEN count(*) = 0 OR bool_or(s IS NULL) THEN NULL
           ELSE avg(s)::real
         END
    FROM per;
$$;

COMMENT ON FUNCTION public.fn_community_search_score(text, text[], boolean) IS
  'Community search matching rule. NULL = no match; otherwise 0..1 relevance. Every token must match (substring, or trigram word_similarity >= 0.5 when fuzzy).';

CREATE OR REPLACE FUNCTION public.fn_community_search(
  p_query text,
  p_scope text DEFAULT 'all',
  p_limit integer DEFAULT 12
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_query text := lower(regexp_replace(btrim(coalesce(p_query, '')), '\s+', ' ', 'g'));
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 40);
  v_tokens text[];
  v_fuzzy boolean;
  v_clubs jsonb := '[]'::jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_tournaments jsonb := '[]'::jsonb;
  v_club_total integer := 0;
  v_table_total integer := 0;
  v_tournament_total integer := 0;
  v_health jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'clubs', 'tables', 'tournaments') THEN
    RAISE EXCEPTION 'Invalid search scope' USING ERRCODE = '22023';
  END IF;
  IF length(v_query) > 64 THEN
    RAISE EXCEPTION 'Search must be 64 characters or fewer' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(array_agg(t), '{}'::text[])
    INTO v_tokens
    FROM (
      SELECT t FROM unnest(string_to_array(v_query, ' ')) AS t
       WHERE t <> ''
       LIMIT 6
    ) s;
  v_fuzzy := length(v_query) >= 3;

  -- Index health is measured on every call. It is what "Live Indexes" shows.
  SELECT jsonb_build_object(
    'clubs', (SELECT count(*) FROM public.clubs c WHERE coalesce(c.status, 'active') = 'active'),
    'players', (
      SELECT count(*)
        FROM public.profiles p
        LEFT JOIN public.player_search_preferences sp ON sp.user_id = p.id
       WHERE coalesce(sp.discoverable, true)
    ),
    'tables', (
      SELECT count(*) FROM public.tables t
       WHERE t.is_deleted = false AND t.status <> 'closed' AND t.tournament_id IS NULL
    ),
    'tournaments', (
      SELECT count(*) FROM public.tournaments t
       WHERE t.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING')
    )
  ) INTO v_health;

  IF cardinality(v_tokens) = 0 THEN
    RETURN jsonb_build_object(
      'query', v_query, 'scope', p_scope, 'fuzzy', false, 'limit', v_limit,
      'clubs', v_clubs, 'tables', v_tables, 'tournaments', v_tournaments,
      'totals', jsonb_build_object('clubs', 0, 'tables', 0, 'tournaments', 0),
      'index_health', v_health
    );
  END IF;

  -- ── CLUBS (and unions: a union's lobby row lives in clubs with is_union) ──
  IF p_scope IN ('all', 'clubs') THEN
    WITH matched AS (
      SELECT c.*,
             public.fn_community_search_score(
               concat_ws(' ', c.name, c.slug, c.code, c.club_id::text, c.tagline),
               v_tokens, v_fuzzy
             ) AS score
        FROM public.clubs c
       WHERE coalesce(c.status, 'active') = 'active'
    ),
    ranked AS (
      SELECT m.*,
             row_number() OVER (
               ORDER BY m.score DESC, coalesce(m.is_union, false) DESC,
                        m.member_count DESC NULLS LAST, m.name
             ) AS ord
        FROM matched m
       WHERE m.score IS NOT NULL
    ),
    picked AS (
      SELECT r.*,
             CASE
               WHEN coalesce(r.is_union, false) THEN
                 (SELECT u.member_count FROM public.fn_batch_union_realtime_member_counts(ARRAY[r.id]) u)
               ELSE
                 (SELECT k.member_count FROM public.fn_batch_club_realtime_member_counts(ARRAY[r.id]) k)
             END AS live_member_count,
             (
               SELECT count(*)
                 FROM public.tables t
                WHERE t.is_deleted = false AND t.status <> 'closed' AND t.tournament_id IS NULL
                  AND coalesce(t.is_private, false) = false
                  AND (t.club_id = r.id
                       OR (coalesce(r.is_union, false)
                           AND t.club_id IN (SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = r.id)))
             ) AS live_table_count,
             (
               SELECT coalesce(sum(t.current_players), 0)
                 FROM public.tables t
                WHERE t.is_deleted = false AND t.status <> 'closed' AND t.tournament_id IS NULL
                  AND coalesce(t.is_private, false) = false
                  AND (t.club_id = r.id
                       OR (coalesce(r.is_union, false)
                           AND t.club_id IN (SELECT uc.club_id FROM public.union_clubs uc WHERE uc.union_id = r.id)))
             ) AS live_seated,
             (
               SELECT count(*) FROM public.tournaments tt
                WHERE tt.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING')
                  AND coalesce(tt.is_private, false) = false
                  AND (tt.club_id = r.id OR tt.union_id = r.id)
             ) AS live_tournament_count,
             (
               SELECT cm.status FROM public.club_members cm
                WHERE cm.club_id = r.id AND cm.user_id = v_uid
                LIMIT 1
             ) AS viewer_status,
             (SELECT pu.name FROM public.clubs pu WHERE pu.id = r.union_id AND pu.id <> r.id) AS union_name
        FROM ranked r
       WHERE r.ord <= v_limit
    )
    SELECT (SELECT count(*) FROM ranked)::integer,
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', p.id,
              'slug', p.slug,
              'club_number', p.club_id,
              'name', p.name,
              'tagline', p.tagline,
              'description', p.description,
              'image_url', coalesce(nullif(p.logo_url, ''), nullif(p.avatar_url, ''), nullif(p.logo, '')),
              'card_image_url', nullif(p.card_image_url, ''),
              'is_union', coalesce(p.is_union, false),
              'union_id', p.union_id,
              'union_name', p.union_name,
              'member_count', coalesce(p.live_member_count, p.member_count, 0),
              'online_count', coalesce(p.online_count, 0),
              'table_count', p.live_table_count,
              'seated_count', p.live_seated,
              'tournament_count', p.live_tournament_count,
              'level', p.level,
              'is_public', coalesce(p.is_public, true),
              'requires_approval', coalesce(p.requires_approval, false),
              'viewer_status', p.viewer_status,
              'match_score', round(p.score::numeric, 3)
            ) ORDER BY p.ord), '[]'::jsonb) FROM picked p)
      INTO v_club_total, v_clubs;
  END IF;

  -- ── TABLES (cash / open ring games) ──
  IF p_scope IN ('all', 'tables') THEN
    WITH visible AS (
      SELECT t.id, t.name, t.game_variant, t.game_type, t.stakes, t.small_blind, t.big_blind,
             t.current_players, t.max_players, t.status, t.club_id, t.is_featured, t.label_as_new,
             t.hide_club_name, t.created_at,
             c.name AS club_name, c.slug AS club_slug, c.is_union AS club_is_union
        FROM public.tables t
        LEFT JOIN public.clubs c ON c.id = t.club_id
       WHERE t.is_deleted = false
         AND t.status <> 'closed'
         AND t.tournament_id IS NULL
         AND coalesce(t.is_template, false) = false
         AND (
           coalesce(t.is_private, false) = false
           OR t.club_id IS NULL
           OR public.is_club_member(t.club_id, v_uid)
           OR c.owner_id = v_uid
           OR public.fn_union_oversees_club(t.club_id, v_uid)
         )
    ),
    matched AS (
      SELECT v.*,
             coalesce(
               public.fn_community_search_score(
                 concat_ws(' ', v.name, v.game_variant, v.game_type, v.stakes), v_tokens, v_fuzzy),
               0.7 * public.fn_community_search_score(
                 concat_ws(' ', v.name, v.game_variant, v.game_type, v.stakes, v.club_name), v_tokens, v_fuzzy)
             ) AS score
        FROM visible v
    ),
    ranked AS (
      SELECT m.*,
             row_number() OVER (
               ORDER BY m.score DESC, m.current_players DESC NULLS LAST,
                        (m.status = 'running') DESC, m.name
             ) AS ord
        FROM matched m
       WHERE m.score IS NOT NULL
    )
    SELECT (SELECT count(*) FROM ranked)::integer,
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', r.id,
              'name', r.name,
              'game_variant', r.game_variant,
              'game_type', r.game_type,
              'stakes', r.stakes,
              'small_blind', r.small_blind,
              'big_blind', r.big_blind,
              'current_players', coalesce(r.current_players, 0),
              'max_players', coalesce(r.max_players, 9),
              'status', r.status,
              'is_featured', coalesce(r.is_featured, false),
              'is_new', coalesce(r.label_as_new, false),
              'club_id', r.club_id,
              'club_name', CASE WHEN coalesce(r.hide_club_name, false) THEN NULL ELSE r.club_name END,
              'club_slug', r.club_slug,
              'club_is_union', coalesce(r.club_is_union, false),
              'match_score', round(r.score::numeric, 3)
            ) ORDER BY r.ord), '[]'::jsonb) FROM ranked r WHERE r.ord <= v_limit)
      INTO v_table_total, v_tables;
  END IF;

  -- ── TOURNAMENTS (announced, registering, running) ──
  IF p_scope IN ('all', 'tournaments') THEN
    WITH visible AS (
      SELECT t.id, t.name, t.status, t.tournament_type, t.variant, t.game_type,
             t.buy_in_amount, t.buy_in_fee, t.guaranteed_prize, t.prize_pool,
             t.current_players, t.max_players, t.start_time, t.club_id, t.union_id,
             t.is_bounty, t.is_pko, t.is_mystery_bounty, t.is_turbo, t.hide_club_name,
             c.name AS club_name, c.slug AS club_slug
        FROM public.tournaments t
        LEFT JOIN public.clubs c ON c.id = t.club_id
       WHERE t.status IN ('ANNOUNCED', 'REGISTERING', 'RUNNING')
         AND (
           coalesce(t.is_private, false) = false
           OR t.club_id IS NULL
           OR public.is_club_member(t.club_id, v_uid)
           OR c.owner_id = v_uid
         )
    ),
    matched AS (
      SELECT v.*,
             coalesce(
               public.fn_community_search_score(
                 concat_ws(' ', v.name, v.variant, v.game_type, v.tournament_type), v_tokens, v_fuzzy),
               0.7 * public.fn_community_search_score(
                 concat_ws(' ', v.name, v.variant, v.game_type, v.tournament_type, v.club_name), v_tokens, v_fuzzy)
             ) AS score
        FROM visible v
    ),
    ranked AS (
      SELECT m.*,
             row_number() OVER (
               ORDER BY m.score DESC,
                        CASE m.status WHEN 'RUNNING' THEN 0 WHEN 'REGISTERING' THEN 1 ELSE 2 END,
                        m.start_time ASC NULLS LAST, m.name
             ) AS ord
        FROM matched m
       WHERE m.score IS NOT NULL
    )
    SELECT (SELECT count(*) FROM ranked)::integer,
           (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', r.id,
              'name', r.name,
              'status', r.status,
              'tournament_type', r.tournament_type,
              'variant', r.variant,
              'buy_in_amount', coalesce(r.buy_in_amount, 0),
              'buy_in_fee', coalesce(r.buy_in_fee, 0),
              'guaranteed_prize', coalesce(r.guaranteed_prize, 0),
              'prize_pool', coalesce(r.prize_pool, 0),
              'current_players', coalesce(r.current_players, 0),
              'max_players', r.max_players,
              'start_time', r.start_time,
              'is_bounty', coalesce(r.is_bounty, false) OR coalesce(r.is_pko, false) OR coalesce(r.is_mystery_bounty, false),
              'is_turbo', coalesce(r.is_turbo, false),
              'club_id', r.club_id,
              'club_name', CASE WHEN coalesce(r.hide_club_name, false) THEN NULL ELSE r.club_name END,
              'club_slug', r.club_slug,
              'is_registered', EXISTS (
                SELECT 1 FROM public.tournament_players tp
                 WHERE tp.tournament_id = r.id AND tp.user_id = v_uid
                   AND tp.status IN ('registered', 'playing')
              ),
              'match_score', round(r.score::numeric, 3)
            ) ORDER BY r.ord), '[]'::jsonb) FROM ranked r WHERE r.ord <= v_limit)
      INTO v_tournament_total, v_tournaments;
  END IF;

  RETURN jsonb_build_object(
    'query', v_query,
    'scope', p_scope,
    'fuzzy', v_fuzzy,
    'limit', v_limit,
    'clubs', v_clubs,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'totals', jsonb_build_object(
      'clubs', v_club_total, 'tables', v_table_total, 'tournaments', v_tournament_total
    ),
    'index_health', v_health
  );
END;
$$;

COMMENT ON FUNCTION public.fn_community_search(text, text, integer) IS
  'Club Arena /search: ranked trigram-fuzzy search over clubs (union-aware live member counts, resolved logos), open tables and live tournaments, plus per-index live health counts. Players come from fn_search_players.';

REVOKE ALL ON FUNCTION public.fn_community_search_score(text, text[], boolean) FROM public, anon;
REVOKE ALL ON FUNCTION public.fn_community_search(text, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_community_search_score(text, text[], boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_community_search(text, text, integer) TO authenticated, service_role;

COMMIT;
