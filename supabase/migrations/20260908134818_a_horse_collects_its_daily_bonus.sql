-- 20260908134818_a_horse_collects_its_daily_bonus.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- A HORSE COLLECTS ITS DAILY BONUS, BECAUSE A HORSE IS A PLAYER.
-- (CLAUDE.md 10.5; Dan 2026-09-08: "ALL HORSES WILL NEED TO EARN DIAMONDS, VIA SOCIAL MEDIA,
--  DAILY CHALLANGES, PLAYING DAILY ETC ... THEY NEED TO BE INCLUDED AND AWARDED DIAMONDS JUST
--  LIKE ANY OTHER USER WOULD BE"; docs/changelog/2026-09-08-a-horse-collects-its-daily-bonus.md)
--
-- I audited every diamond earn path for whether a horse can be paid by it. THE GOOD NEWS FIRST:
-- not one of them excludes a horse by rule. There is no `NOT is_horse` anywhere in the earn
-- engines - the thing 10.5 was written about is genuinely absent.
--
-- The exclusion is mechanical, and this function is the clearest case of it on the platform.
-- `fn_ca_daily_bonus_eligibility` already says, in its own comment:
--
--     -- Horses are players (Diamond Accounting Standard D22). Fixtures are not.
--
-- and returns 'ok' for a horse. Somebody decided this deliberately and wrote it down. Then the
-- only door into the bonus opens with
--
--     v_uid uuid := auth.uid();
--     IF v_uid IS NULL THEN RAISE EXCEPTION 'requires an authenticated caller';
--
-- and a horse has no browser, so it has never held one. **Zero horses have a daily bonus row;
-- four humans do.** A rule saying horses qualify, sitting behind a door only a browser can open,
-- is the exact shape 10.5 forbids: not a filter, an input device the horse does not have.
--
-- THE FIX IS THE ONE 10.5 SANCTIONS. The engine supplies what a browser would, exactly as it
-- already does for the daily-challenge claim: it names the player it is acting for, and only the
-- engine may do that. Everything else about the bonus is untouched - the same tiles, the same
-- once-per-slot-per-day rule, the same idempotency on request id, the same per-user caps inside
-- `award_diamonds_v2`, the same refusal reasons. A horse gets the identical bonus a human gets,
-- through the identical code.
--
-- ONE BODY, NOT TWO. The parameter is added by DROP and CREATE inside this transaction rather
-- than by adding a second overload, because two bodies drift: on 2026-09-08 I patched the wrong
-- overload of `record_daily_challenge_event` and 733 completed challenges went unclaimed while
-- the migration reported success. A browser calling with `{p_slot, p_request_id}` resolves to
-- this function unchanged, because the new parameter defaults to NULL.
--
-- A BROWSER MAY NEVER NAME SOMEBODY ELSE. If a real session is present it decides who the player
-- is, and passing another id is refused rather than ignored - a call that silently does something
-- other than what it says is how the next defect gets written.
--
-- WHAT THIS DOES NOT DO: it does not make a horse claim anything. Deciding that a horse collects
-- its bonus today, and which tile, is engine behaviour and belongs beside the rest of HorseLogic.
-- This opens the door; the engine still has to walk through it, and until it does the only change
-- is that the door is no longer bolted against players who qualify.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid);

CREATE FUNCTION public.fn_ca_daily_bonus_claim(p_slot integer, p_request_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_tile       jsonb;
  v_kind       text;
  v_qty        integer;
  v_diamonds   integer;
  v_feature    text;
  v_existing   public.ca_daily_bonus_claims;
  v_award      jsonb;
  v_credit_id  uuid;
  v_journal_id uuid;
  v_balance    integer;
  v_granted    jsonb;
  v_result     jsonb;
  v_ref        text;
BEGIN
  -- A BROWSER SPEAKS FOR ITSELF AND FOR NOBODY ELSE.
  IF v_uid IS NOT NULL AND p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a daily bonus for another player' USING ERRCODE = '42501';
  END IF;
  -- THE HORSE'S INPUT DEVICE (CLAUDE.md 10.5). A horse has no session, so the engine names the
  -- player it is acting for. Only the engine may: fn_caller_is_engine is false for any browser.
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'request_id_required');
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > 6 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_such_tile');
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('success', false, 'reason', v_elig);
  END IF;

  -- One claim at a time per player. Every path below runs under this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || v_uid::text, 0));

  -- Replay: the same request id returns the stored result and pays nothing.
  SELECT * INTO v_existing FROM public.ca_daily_bonus_claims
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_existing.result || jsonb_build_object('idempotent', true);
  END IF;

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  SELECT t INTO v_tile FROM jsonb_array_elements(v_day.tiles) t WHERE (t->>'slot')::int = p_slot;
  IF v_tile IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_such_tile');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_daily_bonus_claims
              WHERE user_id = v_uid AND bonus_date = v_today AND slot = p_slot) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_claimed');
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;
  IF (v_tile->>'vip_only')::boolean AND NOT v_is_vip THEN
    RETURN jsonb_build_object('success', false, 'reason', 'vip_only');
  END IF;

  -- Resolve what the tile pays. A mystery tile pays what was rolled when the
  -- day opened.
  v_kind     := v_tile->>'kind';
  v_qty      := COALESCE((v_tile->>'quantity')::int, 0);
  v_diamonds := COALESCE((v_tile->>'diamonds')::int, 0);
  IF v_kind = 'mystery' THEN
    v_kind     := v_tile->'mystery'->>'kind';
    v_qty      := COALESCE((v_tile->'mystery'->>'quantity')::int, 0);
    v_diamonds := COALESCE((v_tile->'mystery'->>'diamonds')::int, 0);
  END IF;

  v_ref := 'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text;

  IF v_kind = 'diamonds' THEN
    IF v_diamonds <= 0 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'nothing_to_pay');
    END IF;
    v_award := public.award_diamonds_v2(
      v_uid, 'daily_bonus', v_ref, NULL,
      jsonb_build_object(
        '_source', 'fn_ca_daily_bonus_claim',
        'bonus_diamonds', v_diamonds,
        'streak', v_day.streak,
        'cycle_day', v_day.cycle_day,
        'slot', p_slot,
        'vip_tile', (v_tile->>'vip_only')::boolean,
        'mystery', v_tile->>'kind' = 'mystery'
      ));
    IF NOT COALESCE((v_award->>'success')::boolean, false) THEN
      -- award_diamonds_v2 writes nothing on refusal, so the tile stays
      -- claimable and the player sees the ledger's own reason.
      RETURN jsonb_build_object('success', false, 'reason', COALESCE(v_award->>'reason', 'award_refused'),
                                'detail', v_award);
    END IF;
    SELECT t.id INTO v_journal_id FROM public.diamond_transactions t
     WHERE t.user_id = v_uid AND t.reference_id = v_ref
     ORDER BY t.created_at DESC LIMIT 1;
    v_balance := (v_award->>'balance_after')::integer;
    v_granted := jsonb_build_object('kind', 'diamonds', 'diamonds', (v_award->>'awarded')::integer,
                                    'quantity', 0, 'diamond_transaction_id', v_journal_id,
                                    'balance_after', v_balance);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank') THEN
    IF v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'nothing_to_pay');
    END IF;
    v_feature := CASE v_kind WHEN 'throwables' THEN 'throwable'
                             WHEN 'rabbit_hunts' THEN 'rabbit_hunt'
                             ELSE 'time_bank_seconds' END;
    INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)
    VALUES (v_uid, v_feature, 0, 'per_use', v_qty, now() + interval '7 days', 'daily_bonus')
    RETURNING id INTO v_credit_id;
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', v_kind, 'feature', v_feature, 'quantity', v_qty, 'diamonds', 0,
                                    'feature_purchase_id', v_credit_id,
                                    'expires_at', now() + interval '7 days',
                                    'balance_after', v_balance);
  ELSE
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim: unsupported tile kind %', v_kind USING ERRCODE = '22023';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'idempotent', false,
    'slot', p_slot,
    'tile', v_tile - 'mystery',
    'revealed', CASE WHEN v_tile->>'kind' = 'mystery' THEN v_tile->'mystery' ELSE NULL END,
    'granted', v_granted,
    'streak', v_day.streak,
    'first_claim_of_day', v_day.first_claimed_at IS NULL
  );

  INSERT INTO public.ca_daily_bonus_claims (user_id, bonus_date, slot, request_id, tile, granted, result)
  VALUES (v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result);

  UPDATE public.ca_daily_bonus_days
     SET first_claimed_at = COALESCE(first_claimed_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid) IS
  'Claims one daily-bonus tile. p_user_id is the horse''s input device (CLAUDE.md 10.5): only the engine may name a player, a browser speaks for its own session and passing another id is refused. Eligibility already counted horses as players; the browser-only door was what kept them out - zero horses had ever held a bonus day.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_body text;
BEGIN
  -- exactly one body, so the two cannot drift
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_daily_bonus_claim';
  IF v_n <> 1 THEN RAISE EXCEPTION '% overloads of the daily bonus claim exist; two bodies drift', v_n; END IF;

  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_daily_bonus_claim';

  -- the engine may act for a horse
  IF v_body NOT LIKE '%IF v_uid IS NULL AND public.fn_caller_is_engine() THEN%' THEN
    RAISE EXCEPTION 'the engine still cannot claim on a horse''s behalf';
  END IF;
  -- and a browser may not act for anybody else
  IF v_body NOT LIKE '%Cannot claim a daily bonus for another player%' THEN
    RAISE EXCEPTION 'a browser could name another player';
  END IF;
  -- and an unauthenticated caller with no engine is still refused
  IF v_body NOT LIKE '%requires an authenticated caller%' THEN
    RAISE EXCEPTION 'the door is open to nobody in particular';
  END IF;

  -- every other rule of the bonus is untouched
  IF v_body NOT LIKE '%already_claimed%' OR v_body NOT LIKE '%vip_only%'
     OR v_body NOT LIKE '%fn_ca_daily_bonus_eligibility%' OR v_body NOT LIKE '%idempotent%'
     OR v_body NOT LIKE '%award_diamonds_v2%' THEN
    RAISE EXCEPTION 'a rule of the daily bonus was lost in the rewrite';
  END IF;

  -- the browser call shape still resolves
  IF to_regprocedure('public.fn_ca_daily_bonus_claim(integer, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'the new signature does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.proname = 'fn_ca_daily_bonus_claim' AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'players can no longer claim their own daily bonus';
  END IF;

  -- eligibility still says a horse is a player, which is the whole premise
  IF (SELECT public.fn_ca_daily_bonus_eligibility(id) FROM public.profiles WHERE is_horse LIMIT 1) <> 'ok' THEN
    RAISE EXCEPTION 'a horse is no longer eligible for the daily bonus';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
