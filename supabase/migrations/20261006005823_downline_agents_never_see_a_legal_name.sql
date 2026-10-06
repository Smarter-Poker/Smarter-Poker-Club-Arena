-- Applied to production as version 20261006010336 (match by name).
--
-- DOWNLINE AGENTS NEVER SEE A LEGAL NAME
--
-- Ruling 25 (docs/DIAMOND-RULINGS.md): a person's money, real identity and
-- whereabouts are readable only by that person and platform staff. The
-- column revoke of 20260930234500 cannot reach a SECURITY DEFINER function,
-- and four Club Arena definers still read profiles.full_name for somebody
-- other than the caller:
--
--   ca_club_my_downline        returned p.full_name, raw, for every agent in
--                              the caller's downline (any signed-in agent can
--                              call it; no page does any more)
--   calculate_agent_settlement fell back to full_name for the agent's name
--   calculate_agent_spread     fell back to full_name for each sub-agent
--   fn_club_bank_ledger        fell back to full_name after fn_arena_name
--                              (unreachable - fn_arena_name never returns
--                              NULL - but it is the same promise, kept)
--
-- ca_club_my_downline keeps its result shape: the full_name column now holds
-- the public name (display name, else username). The other three drop the
-- legal-name term. fn_arena_name(..., full_name) calls stay: they read the
-- legal name only to SUPPRESS a display name equal to it, never to return it.
--
-- Reviewed and kept: ca_club_member_detail and ca_club_members_export show a
-- member's last login to that club's own staff and the member's upline only
-- (v_sensitive / staff-access gates). That is the club's credit-risk view of
-- its own members, decided 2026-10-06 as a club-operations exception, not a
-- stranger's read.
--
-- Each function is pinned by md5 so this refuses to run on a definition that
-- changed since it was read; every fragment must occur the reviewed number of
-- times; CREATE OR REPLACE keeps owner, grants and settings. The companion
-- World Hub change is migration 20261006001817 (fifteen home-game and
-- messenger definers), World Hub PR #2148.
--
-- Never apply between :50 and :03 UTC.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $do$
DECLARE
  v_plan constant jsonb := $plan$[
    {"fn": "public.ca_club_my_downline(uuid)", "md5": "75a72820141d7fb034cae5527f808c01",
     "subs": [["p.username, p.full_name, p.avatar_url,", "p.username, coalesce(nullif(btrim(p.display_name), ''), p.username) AS full_name, p.avatar_url,", 1]]},
    {"fn": "public.calculate_agent_settlement(uuid,uuid)", "md5": "ea1e585cbe3e768e346dfdef8a9d7caf",
     "subs": [[", NULLIF(username,''), NULLIF(full_name,''))", ", NULLIF(username,''))", 1]]},
    {"fn": "public.calculate_agent_spread(uuid,uuid)", "md5": "e426da164a857284fb37cc38b3dc3451",
     "subs": [[", NULLIF(pr.full_name,''), 'Sub-agent '", ", 'Sub-agent '", 1]]},
    {"fn": "public.fn_club_bank_ledger(uuid,integer,integer,text[])", "md5": "7657cfba6f83b5c651a4ab48e990ba37",
     "subs": [[", pf.username, pf.full_name)", ", pf.username)", 1],
              [", pt.username, pt.full_name)", ", pt.username)", 1]]}
  ]$plan$;
  v_item jsonb; v_sub jsonb; v_fn regprocedure; v_def text; v_new text; v_frag text; v_found int;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
    v_fn := (v_item->>'fn')::regprocedure;
    v_def := pg_get_functiondef(v_fn);
    IF md5(v_def) <> v_item->>'md5' THEN
      RAISE EXCEPTION '% changed since 2026-10-06 (expected md5 %, found %); re-read before applying',
        v_fn, v_item->>'md5', md5(v_def);
    END IF;
    v_new := v_def;
    FOR v_sub IN SELECT * FROM jsonb_array_elements(v_item->'subs') LOOP
      v_frag := v_sub->>0;
      v_found := (length(v_new) - length(replace(v_new, v_frag, ''))) / length(v_frag);
      IF v_found <> (v_sub->>2)::int THEN
        RAISE EXCEPTION '%: fragment "%" found % time(s), reviewed %', v_fn, v_frag, v_found, v_sub->>2;
      END IF;
      v_new := replace(v_new, v_frag, v_sub->>1);
    END LOOP;
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
      RAISE EXCEPTION '%: post-image mismatch', v_fn;
    END IF;
  END LOOP;
END $do$;

-- POST: no legal name is RETURNED by any of the four. Strip the
-- suppress-only fn_arena_name(...) calls and the RETURNS TABLE column name,
-- and nothing may still name full_name.
DO $post$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
    FROM pg_proc p
   WHERE p.oid IN ('public.ca_club_my_downline(uuid)'::regprocedure,
                   'public.calculate_agent_settlement(uuid,uuid)'::regprocedure,
                   'public.calculate_agent_spread(uuid,uuid)'::regprocedure,
                   'public.fn_club_bank_ledger(uuid,integer,integer,text[])'::regprocedure)
     AND (regexp_replace(regexp_replace(p.prosrc, 'fn_arena_name\s*\([^()]*\)', '', 'gi'),
                         'AS full_name', '', 'g') ~* '\mfull_name\M'
          OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'post: still returns a legal name or lost its grant: %', v_bad;
  END IF;
END $post$;

COMMIT;
