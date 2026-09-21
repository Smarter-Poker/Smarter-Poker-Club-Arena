-- RABBIT HUNT: 100 free per month for VIP, 1 diamond thereafter, for everyone.
--
-- Dan 2026-08-23: "add rabbit hunt to all cash game, MTT, spins and heads up
-- tables. VIP users get 100 rabbit hunts free, then each hunt after that =
-- 1 diamond." Non-VIP pay the same 1 diamond (confirmed), and the 100 resets
-- monthly, matching how the 120 VIP time-bank seconds already work.
--
-- TABLE COVERAGE was already correct and needed no change: the engine gates on
-- `allow_rabbit_hunt !== false`, and all 117 live tables (42 cash, 75
-- tournament, which is where MTT, spins and heads-up live) carry
-- allow_rabbit_hunt = true. Verified before touching anything.
--
-- THE DEFECT THIS FIXES, which is why the price could not simply be edited:
-- ServerTableEngineSettlement broadcasts the five remaining deck cards to EVERY
-- client at the table the moment a hand ends before the river. TablePage stores
-- them in serverRabbitCardsRef and RabbitHunt then "charges" diamonds to display
-- cards the browser already holds. Anyone with devtools reads them free, and
-- because it is a table-wide broadcast, so do the opponents. Charging 1 diamond
-- for that would be theatre.
--
-- So the cards move server-side and payment gates the reveal:
--   1. rabbit_hunt_offers holds them, written by the engine, readable by nobody
--      through PostgREST (RLS on, no policies - definer function only).
--   2. fn_reveal_rabbit_hunt() is the only way out. It proves the caller played
--      the hand, consumes a free monthly hunt if they have one, otherwise
--      charges 1 diamond, and only then returns the cards.
--
-- The engine change (persist instead of broadcast) ships alongside. Until it
-- deploys, fn_reveal_rabbit_hunt finds no offer row and returns a clean
-- "unavailable", so this is safe to land first.

UPDATE public.feature_pricing SET diamond_cost = 1 WHERE feature = 'rabbit_hunt';

CREATE TABLE IF NOT EXISTS public.rabbit_hunt_offers (
  table_id    uuid        NOT NULL,
  hand_number bigint      NOT NULL,
  cards       jsonb       NOT NULL,
  board_len   integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rabbit_hunt_offers_pkey PRIMARY KEY (table_id, hand_number)
);

COMMENT ON TABLE public.rabbit_hunt_offers IS
  'Remaining-deck cards for a finished hand, held server-side so the rabbit-hunt reveal can be paid for. Written by the engine; readable ONLY through fn_reveal_rabbit_hunt, which charges first. RLS on with no policies by design. Pruned after 1 day.';

ALTER TABLE public.rabbit_hunt_offers ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: the cards must never be readable directly.

CREATE INDEX IF NOT EXISTS idx_rabbit_hunt_offers_created
  ON public.rabbit_hunt_offers (created_at);

-- Per-hand ledger: charge at most once, and re-opening the same hand is free.
-- Created BEFORE the function that writes it.
CREATE TABLE IF NOT EXISTS public.rabbit_hunt_reveals (
  user_id     uuid        NOT NULL,
  table_id    uuid        NOT NULL,
  hand_number bigint      NOT NULL,
  charged     integer     NOT NULL DEFAULT 0,
  revealed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rabbit_hunt_reveals_pkey PRIMARY KEY (user_id, table_id, hand_number)
);

ALTER TABLE public.rabbit_hunt_reveals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rabbit_hunt_reveals_own ON public.rabbit_hunt_reveals;
CREATE POLICY rabbit_hunt_reveals_own ON public.rabbit_hunt_reveals
  FOR SELECT USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.sp_prune_rabbit_hunt_offers(p_batch integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_deleted int;
BEGIN
  WITH doomed AS (
    SELECT table_id, hand_number FROM public.rabbit_hunt_offers
     WHERE created_at < now() - interval '1 day'
     ORDER BY created_at LIMIT p_batch
  )
  DELETE FROM public.rabbit_hunt_offers o USING doomed d
   WHERE o.table_id = d.table_id AND o.hand_number = d.hand_number;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_reveal_rabbit_hunt(
  p_table_id    uuid,
  p_hand_number bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := (SELECT auth.uid());
  v_offer    record;
  v_played   boolean := false;
  v_is_vip   boolean := false;
  v_used     integer := 0;
  v_month    text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_free_cap constant integer := 100;
  v_price    integer;
  v_deduct   jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  SELECT * INTO v_offer FROM public.rabbit_hunt_offers
   WHERE table_id = p_table_id AND hand_number = p_hand_number;
  IF v_offer.table_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no rabbit hunt available for that hand');
  END IF;

  -- Already revealed this exact hand: free, and no second charge.
  IF EXISTS (SELECT 1 FROM public.rabbit_hunt_reveals r
              WHERE r.user_id = v_caller AND r.table_id = p_table_id
                AND r.hand_number = p_hand_number) THEN
    RETURN jsonb_build_object('success', true, 'charged', 0, 'already_revealed', true,
                              'cards', v_offer.cards, 'board_len', v_offer.board_len);
  END IF;

  -- You may only rabbit hunt a hand you were dealt into.
  SELECT EXISTS (
    SELECT 1 FROM public.hand_history h
     WHERE h.table_id = p_table_id AND h.hand_number = p_hand_number
       AND jsonb_typeof(h.players) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(h.players) pl
                    WHERE pl->>'userId' = v_caller::text)
  ) INTO v_played;

  IF NOT v_played THEN
    -- Settlement may not have written hand_history yet; a live seat counts.
    SELECT EXISTS (
      SELECT 1 FROM public.table_seats s
       WHERE s.table_id = p_table_id AND s.user_id = v_caller
         AND (s.left_at IS NULL OR s.left_at > now() - interval '5 minutes')
    ) INTO v_played;
  END IF;

  IF NOT v_played THEN
    RETURN jsonb_build_object('success', false, 'error', 'you did not play that hand');
  END IF;

  -- An expired VIP is not a VIP.
  SELECT COALESCE(is_vip, false) AND (vip_expires_at IS NULL OR vip_expires_at > now())
    INTO v_is_vip FROM public.profiles WHERE id = v_caller;
  v_is_vip := COALESCE(v_is_vip, false);

  SELECT COALESCE(usage_count, 0) INTO v_used
    FROM public.vip_feature_usage_monthly
   WHERE user_id = v_caller AND feature = 'rabbit_hunt' AND month = v_month;
  v_used := COALESCE(v_used, 0);

  IF v_is_vip AND v_used < v_free_cap THEN
    PERFORM public.fn_increment_vip_usage(v_caller, 'rabbit_hunt');
    INSERT INTO public.rabbit_hunt_reveals (user_id, table_id, hand_number, charged)
    VALUES (v_caller, p_table_id, p_hand_number, 0);
    RETURN jsonb_build_object('success', true, 'charged', 0,
                              'free_remaining', v_free_cap - v_used - 1,
                              'cards', v_offer.cards, 'board_len', v_offer.board_len);
  END IF;

  SELECT diamond_cost INTO v_price FROM public.feature_pricing WHERE feature = 'rabbit_hunt';
  v_price := COALESCE(v_price, 1);

  -- Deterministic reference_id makes the charge idempotent per (hand, user).
  -- Cooldown explicitly 0: consecutive hands are legitimate, rapid hunts.
  v_deduct := public.deduct_diamonds(
    p_user_id          := v_caller,
    p_amount           := v_price,
    p_description      := 'Rabbit hunt',
    p_transaction_type := 'feature_purchase',
    p_source           := 'rabbit_hunt',
    p_metadata         := jsonb_build_object('table_id', p_table_id, 'hand_number', p_hand_number),
    p_reference_id     := 'rabbit_' || p_table_id::text || '_' || p_hand_number::text || '_' || v_caller::text,
    p_cooldown_seconds := 0
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('success', false,
      'error', COALESCE(v_deduct->>'error', 'not enough diamonds'),
      'diamond_cost', v_price);
  END IF;

  PERFORM public.fn_increment_vip_usage(v_caller, 'rabbit_hunt');
  INSERT INTO public.rabbit_hunt_reveals (user_id, table_id, hand_number, charged)
  VALUES (v_caller, p_table_id, p_hand_number, v_price);

  RETURN jsonb_build_object('success', true, 'charged', v_price,
                            'cards', v_offer.cards, 'board_len', v_offer.board_len);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_reveal_rabbit_hunt(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_reveal_rabbit_hunt(uuid, bigint) TO authenticated;
REVOKE ALL ON FUNCTION public.sp_prune_rabbit_hunt_offers(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sp_prune_rabbit_hunt_offers(integer) FROM anon, authenticated;

COMMENT ON FUNCTION public.fn_reveal_rabbit_hunt(uuid, bigint) IS
  'Pays for and returns the rabbit-hunt cards for one hand. VIP: first 100 per calendar month free, then 1 diamond. Non-VIP: 1 diamond. Refuses if the caller did not play the hand. Charges at most once per (user, table, hand).';

DO $assert$
DECLARE v_cost int; v_res jsonb;
BEGIN
  SELECT diamond_cost INTO v_cost FROM public.feature_pricing WHERE feature='rabbit_hunt';
  IF v_cost <> 1 THEN RAISE EXCEPTION 'rabbit_hunt price is %, expected 1', v_cost; END IF;

  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.rabbit_hunt_offers'::regclass) THEN
    RAISE EXCEPTION 'rabbit_hunt_offers must have NO policies - cards may only leave via the reveal function';
  END IF;

  -- Service-role context has no auth.uid(), so this must refuse.
  v_res := public.fn_reveal_rabbit_hunt('00000000-0000-0000-0000-000000000000'::uuid, 1);
  IF COALESCE((v_res->>'success')::boolean, true) THEN
    RAISE EXCEPTION 'reveal succeeded without auth: %', v_res;
  END IF;
END $assert$;

-- ROLLBACK
--   UPDATE public.feature_pricing SET diamond_cost = 5 WHERE feature = 'rabbit_hunt';
--   DROP FUNCTION IF EXISTS public.fn_reveal_rabbit_hunt(uuid, bigint);
--   DROP FUNCTION IF EXISTS public.sp_prune_rabbit_hunt_offers(integer);
--   DROP TABLE IF EXISTS public.rabbit_hunt_reveals;
--   DROP TABLE IF EXISTS public.rabbit_hunt_offers;
