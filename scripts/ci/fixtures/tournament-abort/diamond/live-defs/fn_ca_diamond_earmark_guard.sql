-- live_md5 706844d861f90e21e9c8602d239c1a8f
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmark_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open_key  bigint;
  v_avail     bigint;
  v_month     bigint;
  v_n         bigint;
BEGIN
  -- Every entry locks the house row, as R1 and R4 require of anything that
  -- changes what the house is holding against. An earmark is not per-hand
  -- money, so one lock per promise is the right cost.
  PERFORM 1 FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;

  v_open_key := public.fn_ca_diamond_earmark_open(NEW.earmark_key);

  IF NEW.entry IN ('pay','release') THEN
    -- RULING 21 LIVES HERE. A promise being KEPT is never refused by a cap,
    -- by the house balance, or by anything else. The only thing checked is
    -- that the house does not pay out more than it promised, which is not a
    -- cap on a player but arithmetic on its own books.
    IF v_open_key <= 0 THEN
      RAISE EXCEPTION 'diamond_earmark_not_open:%', NEW.earmark_key USING ERRCODE = '23514';
    END IF;
    IF NEW.amount > v_open_key THEN
      RAISE EXCEPTION 'diamond_earmark_over_release:% promises % and this entry is %',
        NEW.earmark_key, v_open_key, NEW.amount USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- From here down: NEW.entry = 'open'.
  IF v_open_key > 0 THEN
    RAISE EXCEPTION 'diamond_earmark_already_open:% already promises %',
      NEW.earmark_key, v_open_key USING ERRCODE = '23514';
  END IF;

  -- A7, "set aside at creation": a promise the house cannot cover is not a
  -- promise. This is the check that replaces the chip club-treasury fallback,
  -- which has no Diamond counterpart.
  v_avail := public.fn_ca_diamond_house_available();
  IF NEW.amount > v_avail THEN
    RAISE EXCEPTION 'diamond_house_cannot_set_aside:% available, % asked for %',
      v_avail, NEW.purpose, NEW.amount USING ERRCODE = '23514';
  END IF;

  IF NEW.purpose = 'guarantee' THEN
    -- A4: the largest guarantee one event may advertise.
    IF NEW.amount > public.fn_ca_diamond_economic('guarantee_max_per_event') THEN
      RAISE EXCEPTION 'diamond_guarantee_over_per_event_cap:% exceeds %',
        NEW.amount, public.fn_ca_diamond_economic('guarantee_max_per_event')
        USING ERRCODE = '23514';
    END IF;
    -- A5: the most overlay the platform may owe at one time.
    IF public.fn_ca_diamond_earmarks_open('guarantee') + NEW.amount
         > public.fn_ca_diamond_economic('guarantee_max_outstanding') THEN
      RAISE EXCEPTION 'diamond_guarantee_over_outstanding_cap:% already promised, % asked, cap %',
        public.fn_ca_diamond_earmarks_open('guarantee'), NEW.amount,
        public.fn_ca_diamond_economic('guarantee_max_outstanding')
        USING ERRCODE = '23514';
    END IF;

  ELSIF NEW.purpose = 'promotional_entry' THEN
    -- A12: the product has to be open at all.
    IF NOT public.fn_ca_diamond_economic_on('promo_entry_allowed') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_not_open' USING ERRCODE = '55000';
    END IF;
    -- A17: an entry carries its shelf life, and the ledger sets it rather
    -- than trusting a caller to.
    IF NEW.expires_at IS NULL THEN
      NEW.expires_at := NEW.at
        + (public.fn_ca_diamond_economic('promo_entry_expiry_days') || ' days')::interval;
    END IF;
    -- A13: entries one holder may be given in one calendar day. 10.5: a horse
    -- is counted here exactly as a human is, and no line below branches on
    -- horse status at all.
    SELECT count(*) INTO v_n FROM public.ca_diamond_house_earmarks e
     WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
       AND e.holder_id = NEW.holder_id
       AND e.at >= date_trunc('day', NEW.at) AND e.at < date_trunc('day', NEW.at) + interval '1 day';
    IF v_n + 1 > public.fn_ca_diamond_economic('promo_entry_per_player_per_day') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_over_player_day_cap:% already today, cap %',
        v_n, public.fn_ca_diamond_economic('promo_entry_per_player_per_day')
        USING ERRCODE = '23514';
    END IF;
    -- A14: entries one event may admit.
    IF NEW.tournament_id IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM public.ca_diamond_house_earmarks e
       WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
         AND e.tournament_id = NEW.tournament_id;
      IF v_n + 1 > public.fn_ca_diamond_economic('promo_entry_per_event') THEN
        RAISE EXCEPTION 'diamond_promotional_entry_over_event_cap:% already in this event, cap %',
          v_n, public.fn_ca_diamond_economic('promo_entry_per_event')
          USING ERRCODE = '23514';
      END IF;
    END IF;
    -- A15: what promotional entries may be worth in one calendar month.
    SELECT COALESCE(SUM(e.amount), 0) INTO v_month FROM public.ca_diamond_house_earmarks e
     WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
       AND e.at >= date_trunc('month', NEW.at)
       AND e.at <  date_trunc('month', NEW.at) + interval '1 month';
    IF v_month + NEW.amount > public.fn_ca_diamond_economic('promo_entry_monthly_diamonds') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_over_monthly_cap:% issued this month, % asked, cap %',
        v_month, NEW.amount, public.fn_ca_diamond_economic('promo_entry_monthly_diamonds')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $function$

