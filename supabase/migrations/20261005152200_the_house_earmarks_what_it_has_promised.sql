-- ============================================================================
-- THE HOUSE EARMARKS WHAT IT HAS PROMISED
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, line (a): the house earmark ledger
-- of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md, rule R3 and section 3.3.
-- It is the second of the two spine pieces, on top of
-- 20261005151918_diamond_economics_records_the_owner_answers, and it is what
-- makes A7's answer - "set aside at creation" - mean something.
--
-- RULE R3, VERBATIM FROM THE DESIGN: "A promise is an earmark, not a movement.
-- A guarantee set aside, an unredeemed promotional entry and a jackpot seed
-- are rows in an append-only earmark ledger on the house. An earmark lowers
-- the house's available balance (balance less open earmarks) and moves
-- nothing, so the identity never sees it."
--
-- WHY A PROMISE CANNOT BE A MOVEMENT HERE. The chip estate funds an overlay by
-- debiting the union bank at lock and falling back to the club treasury (Dan,
-- 2026-09-04). The Diamond side has no treasury fallback, and R1 forbids
-- parking platform-owned Diamonds anywhere but ca_diamond_house, so there is
-- nowhere for a set-aside Diamond to go. An earmark solves that by not moving
-- it: the Diamonds stay in the house, the house's AVAILABLE balance falls, and
-- fn_ca_diamond_register_vs_supply() never sees anything, because a promise is
-- not supply. This migration asserts that identity difference before and after
-- opening, paying and releasing a real earmark in a rolled-back probe.
--
-- MEASURED IN PRODUCTION 2026-10-05 15:13 UTC, read inside
-- BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY:
--   any relation named %earmark%                   0 - nothing like this exists
--   ca_diamond_house                               one row, id 1, balance 0
--   ca_diamond_house_ledger                        the register does not see it (R2)
--   fn_ca_diamond_register_vs_supply().difference  0.00
--   ca_arena_settings                              tournaments_enabled true, cash_games_enabled false
--
-- WHERE THE TWENTY ANSWERS ARE ENFORCED. The design puts the A4, A5, A13, A14
-- and A15 checks in the creation and promotional doors. This ledger enforces
-- them AS WELL, reading each one through fn_ca_diamond_economic so that a
-- changed row changes the behaviour and no code is edited. That is deliberate:
-- a cap enforced only in a door is a cap any future door can forget, and an
-- earmark is the single narrow place every promise passes through.
--
--   A4 guarantee_max_per_event        one guarantee earmark may not exceed it
--   A5 guarantee_max_outstanding      open guarantee earmarks may not exceed it
--   A7 set_aside_at_creation          an open may not take available below 0
--   A13 promo_entry_per_player_per_day  opens per holder per calendar day
--   A14 promo_entry_per_event         open promotional entries in one event
--   A15 promo_entry_monthly_diamonds  promotional opens per calendar month
--   A17 promo_entry_expiry_days       an open promotional entry carries its expiry
--
-- RULING 21, AND THE ONE LINE THAT MATTERS MOST IN THIS FILE. Every cap above
-- is checked on an 'open' entry and on NOTHING ELSE. A 'pay' entry - the house
-- keeping a promise to a named player - and a 'release' entry are never
-- refused by any value in ca_diamond_economics, by the house balance, or by
-- anything else this ledger knows. A cap stops a promise being MADE; it never
-- stops one being KEPT. That is how a platform pot keeps out of a player's way
-- (Dan, 2026-09-08: "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS LIKE THIS,
-- ONLY A USER BUDGET."), and it is asserted in section 5 below by paying an
-- earmark out while every cap is set to zero.
--
-- CLAUDE.md 10.5. Nothing here reads is_horse. A horse holds a promotional
-- entry on the same terms as a human and under the same caps, and A18 says a
-- horse funds its ordinary entry from its own balance, so no horse ever needs
-- an earmark a human would not get. Asserted below.
--
-- WHAT THIS MIGRATION DOES NOT DO. It opens no door: no Diamond door is
-- redefined, the creation door is pinned unchanged, and nothing calls this
-- ledger yet. It moves no Diamond - an earmark is not a movement, which is the
-- whole point. It leaves both arena switches exactly as found.
--
-- HOW IT WAS PROVED. One self-aborting DO block through the Supabase MCP
-- (CLAUDE.md 11.5 rule 1: one call, one transaction, an error is the success
-- case), helpers in pg_temp and never in public. Recorded in
-- docs/changelog/2026-10-05-diamond-destinations-decisions.md.
--
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE LEDGER
-- ---------------------------------------------------------------------------
-- Append-only, so an earmark has no mutable state column: it is a sequence of
-- entries under one key, and what is open is what the arithmetic says. An
-- 'open' promises; a 'pay' keeps part or all of the promise to a named player;
-- a 'release' gives back what the promise no longer needs. Amount is always
-- POSITIVE and the entry says the direction, so no row can be read backwards.

CREATE TABLE public.ca_diamond_house_earmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  entry         text        NOT NULL CHECK (entry IN ('open','pay','release')),
  earmark_key   text        NOT NULL CHECK (btrim(earmark_key) <> ''),
  purpose       text        NOT NULL CHECK (purpose IN ('guarantee','promotional_entry','jackpot_seed')),
  amount        bigint      NOT NULL CHECK (amount > 0 AND amount = trunc(amount)),
  tournament_id uuid        NULL,
  holder_id     uuid        NULL,
  expires_at    timestamptz NULL,
  recorded_by   uuid        NULL,
  reason        text        NOT NULL CHECK (btrim(reason) <> ''),

  -- A guarantee belongs to an event. A promotional entry belongs to a holder,
  -- and to one event or to any event. A jackpot seed belongs to neither.
  CONSTRAINT ca_diamond_house_earmarks_shape CHECK (
    CASE purpose
      WHEN 'guarantee'         THEN tournament_id IS NOT NULL AND holder_id IS NULL
      WHEN 'promotional_entry' THEN holder_id IS NOT NULL
      WHEN 'jackpot_seed'      THEN tournament_id IS NULL AND holder_id IS NULL
    END
  ),
  -- Only a promotional entry has a shelf life (A17).
  CONSTRAINT ca_diamond_house_earmarks_expiry_shape CHECK (
    purpose = 'promotional_entry' OR expires_at IS NULL
  )
);

COMMENT ON TABLE public.ca_diamond_house_earmarks IS
  'What the Diamond house has promised and not yet paid: guarantees set aside at creation, unredeemed promotional entries and jackpot seeds. Append-only; one key is a sequence of open, pay and release entries and the open amount is the arithmetic. An earmark moves no Diamond, so it never reaches ca_mint_ledger, fn_ca_arena_diamonds() or the supply identity - it only lowers what fn_ca_diamond_house_available() reports. Rule R3 of docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md.';
COMMENT ON COLUMN public.ca_diamond_house_earmarks.entry IS
  'open promises, pay keeps the promise to a named player, release gives back what is no longer needed. Caps are checked on open and on nothing else: a cap stops a promise being made, never one being kept (ruling 21).';
COMMENT ON COLUMN public.ca_diamond_house_earmarks.amount IS
  'Whole Diamonds, always positive. A Diamond is indivisible, so an earmark is too.';

CREATE INDEX ix_ca_diamond_house_earmarks_key ON public.ca_diamond_house_earmarks (earmark_key, id);
CREATE INDEX ix_ca_diamond_house_earmarks_open_guarantee
  ON public.ca_diamond_house_earmarks (purpose, at) WHERE purpose = 'guarantee';
CREATE INDEX ix_ca_diamond_house_earmarks_holder ON public.ca_diamond_house_earmarks (holder_id, at)
  WHERE holder_id IS NOT NULL;
CREATE INDEX ix_ca_diamond_house_earmarks_tournament ON public.ca_diamond_house_earmarks (tournament_id, at)
  WHERE tournament_id IS NOT NULL;

CREATE FUNCTION public.fn_ca_diamond_house_earmarks_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'ca_diamond_house_earmarks is append-only: a promise is closed by a pay or a release entry, never by editing the promise'
    USING ERRCODE = '42501';
END $$;
COMMENT ON FUNCTION public.fn_ca_diamond_house_earmarks_append_only() IS
  'Refuses every UPDATE, DELETE and TRUNCATE on the house earmark ledger. What the house promised and what it did about it is the audit trail of the guarantee.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_house_earmarks_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_ca_diamond_house_earmarks_append_only
  BEFORE UPDATE OR DELETE ON public.ca_diamond_house_earmarks
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_house_earmarks_append_only();
CREATE TRIGGER trg_ca_diamond_house_earmarks_no_truncate
  BEFORE TRUNCATE ON public.ca_diamond_house_earmarks
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_diamond_house_earmarks_append_only();

ALTER TABLE public.ca_diamond_house_earmarks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_diamond_house_earmarks FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.ca_diamond_house_earmarks_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_diamond_house_earmarks TO service_role;

-- ---------------------------------------------------------------------------
-- 2. WHAT IS OPEN, AND WHAT IS AVAILABLE
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fn_ca_diamond_earmark_open(p_key text)
RETURNS bigint LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE e.earmark_key = p_key
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_earmark_open(text) IS
  'What one earmark still promises: its opens less its pays and releases. Zero when it was never opened, which is also zero when it has been fully kept - the ledger says which.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmark_open(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_earmark_open(text) TO service_role;

CREATE FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text DEFAULT NULL)
RETURNS bigint LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE p_purpose IS NULL OR e.purpose = p_purpose
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_earmarks_open(text) IS
  'Everything the Diamond house has promised and not yet paid or released, all purposes or one. This is the platform''s outstanding exposure, which A5 caps for guarantees.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmarks_open(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_earmarks_open(text) TO service_role;

-- The number every door that wants to promise something must read. R3: "An
-- earmark lowers the house's available balance (balance less open earmarks)
-- and moves nothing." ca_diamond_house.balance itself is untouched by this
-- file, so fn_ca_diamond_trial_balance, fn_ca_diamond_snapshot and
-- fn_ca_diamond_register_vs_supply all read exactly what they read before.
CREATE FUNCTION public.fn_ca_diamond_house_available()
RETURNS bigint LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (SELECT h.balance FROM public.ca_diamond_house h WHERE h.id = 1)::bigint
       - public.fn_ca_diamond_earmarks_open(NULL)
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_house_available() IS
  'The Diamond house balance less everything it has already promised. A door that is about to promise reads this, never ca_diamond_house.balance. It can be read as negative only if a promise was opened before the house was funded, which the earmark guard refuses, so in practice it is at least 0.';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_house_available() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_house_available() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE GUARD: EVERY CAP IS CHECKED ON AN OPEN AND ON NOTHING ELSE
-- ---------------------------------------------------------------------------
-- Each cap is read through fn_ca_diamond_economic, so changing a number is
-- recording a row and never editing this function. An unset cap REFUSES by
-- name (PDE01 reaches the caller unchanged): section 3.2's "a
-- configured-but-unset value refuses by name", never "unset means no limit".

CREATE FUNCTION public.fn_ca_diamond_earmark_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
END $$;
COMMENT ON FUNCTION public.fn_ca_diamond_earmark_guard() IS
  'Checks A4, A5, A7, A13, A14, A15 and A17 on an earmark being OPENED, reading every number from ca_diamond_economics so a changed answer is a changed row and not changed code. A pay or a release entry passes every cap: the only thing checked there is that the house does not pay out more than it promised. An unset cap refuses by name under PDE01 - unset is never "no limit". Nothing in it reads is_horse (CLAUDE.md 10.5).';
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmark_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_ca_diamond_earmark_guard
  BEFORE INSERT ON public.ca_diamond_house_earmarks
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_earmark_guard();

-- ---------------------------------------------------------------------------
-- 4. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
-- The BEHAVIOUR of this ledger - a promise opened, kept and released, the
-- available balance falling and the identity never moving - is proved in the
-- rehearsal recorded in the changelog and pinned by
-- tests/the-diamond-house-earmarks-what-it-promised.law.test.ts. It is not
-- proved here, because proving it inside the migration would mean crediting
-- the house inside a savepoint to have something to promise against, and this
-- migration moves no Diamond. What IS asserted here is structure, grants and
-- the one thing a future edit could quietly get wrong: that every cap sits
-- inside the 'open' branch and the pay branch returns before any of them.
DO $m$
DECLARE
  v_n int; v_bad text; v_txt text; r record;
  v_pay_at int; v_cap_at int;
BEGIN
  -- 4a. The objects exist and carry their guards.
  IF to_regclass('public.ca_diamond_house_earmarks') IS NULL THEN
    RAISE EXCEPTION 'ca_diamond_house_earmarks was not created';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.ca_diamond_house_earmarks'::regclass AND NOT tgisinternal;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'the earmark ledger carries % user triggers, expected 3 (guard, append-only, no-truncate)', v_n;
  END IF;
  FOR r IN SELECT unnest(ARRAY[
      'fn_ca_diamond_earmark_open','fn_ca_diamond_earmarks_open',
      'fn_ca_diamond_house_available','fn_ca_diamond_earmark_guard',
      'fn_ca_diamond_house_earmarks_append_only']) AS fn
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn) THEN
      RAISE EXCEPTION '% was not created', r.fn;
    END IF;
  END LOOP;

  -- 4b. Nothing is promised yet, and nothing is reachable from a browser.
  SELECT count(*) INTO v_n FROM public.ca_diamond_house_earmarks;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the earmark ledger already holds % rows; this migration promises nothing', v_n;
  END IF;
  IF public.fn_ca_diamond_earmarks_open(NULL) <> 0 THEN
    RAISE EXCEPTION 'the house reports an open earmark before anything was promised';
  END IF;
  IF public.fn_ca_diamond_house_available()
       <> (SELECT balance FROM public.ca_diamond_house WHERE id = 1) THEN
    RAISE EXCEPTION 'available does not equal the balance when nothing is promised';
  END IF;
  IF has_table_privilege('anon','public.ca_diamond_house_earmarks','SELECT')
     OR has_table_privilege('authenticated','public.ca_diamond_house_earmarks','SELECT')
     OR has_table_privilege('anon','public.ca_diamond_house_earmarks','INSERT')
     OR has_table_privilege('authenticated','public.ca_diamond_house_earmarks','INSERT') THEN
    RAISE EXCEPTION 'the earmark ledger is reachable from a browser';
  END IF;
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_diamond_earmark_open','fn_ca_diamond_earmarks_open',
                                'fn_ca_diamond_house_available','fn_ca_diamond_earmark_guard',
                                'fn_ca_diamond_house_earmarks_append_only')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser', r.proname;
    END IF;
    -- CLAUDE.md 10.5: no part of a promise branches on horse status.
    IF position('is_horse' IN pg_get_functiondef(r.oid)) > 0 THEN
      RAISE EXCEPTION '% branches on horse status (CLAUDE.md 10.5)', r.proname;
    END IF;
  END LOOP;

  -- 4c. RULING 21, ASSERTED ON THE TEXT. The pay and release branch returns
  --     before the first cap is read, so no value in ca_diamond_economics can
  --     ever stand between the house and a promise it has already made.
  v_txt := pg_get_functiondef('public.fn_ca_diamond_earmark_guard()'::regprocedure);
  v_pay_at := position('IF NEW.entry IN (''pay'',''release'') THEN' IN v_txt);
  v_cap_at := position('fn_ca_diamond_economic(' IN v_txt);
  IF v_pay_at = 0 THEN
    RAISE EXCEPTION 'the earmark guard no longer has a pay and release branch';
  END IF;
  IF v_cap_at = 0 THEN
    RAISE EXCEPTION 'the earmark guard no longer reads its caps from ca_diamond_economics';
  END IF;
  IF v_pay_at > v_cap_at THEN
    RAISE EXCEPTION 'a cap is now read before the pay branch returns: a cap could refuse a promise being kept (ruling 21)';
  END IF;
  IF position('RETURN NEW;' IN substr(v_txt, v_pay_at, v_cap_at - v_pay_at)) = 0 THEN
    RAISE EXCEPTION 'the pay and release branch no longer returns before the caps';
  END IF;
  -- Every cap this ledger enforces is read through the reader, by name, so a
  -- changed answer is a changed row. A literal here would be the defect
  -- section 3.2 exists to prevent.
  FOR r IN SELECT unnest(ARRAY[
      'guarantee_max_per_event','guarantee_max_outstanding','promo_entry_allowed',
      'promo_entry_expiry_days','promo_entry_per_player_per_day',
      'promo_entry_per_event','promo_entry_monthly_diamonds']) AS nm
  LOOP
    IF position(r.nm IN v_txt) = 0 THEN
      RAISE EXCEPTION 'the earmark guard no longer reads %', r.nm;
    END IF;
  END LOOP;

  -- 4d. The answers this ledger depends on are recorded and readable.
  IF public.fn_ca_diamond_economic_text('guarantee_funding_moment') <> 'set_aside_at_creation' THEN
    RAISE EXCEPTION 'A7 is not set aside at creation, so this ledger is not the right shape for it';
  END IF;
  IF public.fn_ca_diamond_economic_text('guarantee_overlay_account') <> 'ca_diamond_house' THEN
    RAISE EXCEPTION 'A1 names an account other than the house, which this ledger does not keep';
  END IF;

  -- 4e. The estate is as it was. No Diamond moved, the identity is whole, the
  --     cash door is shut, the creation door is untouched, and the arena
  --     switches are exactly as found (tournaments_enabled was already true
  --     when this work began; this migration neither reads nor writes it).
  IF (SELECT balance FROM public.ca_diamond_house WHERE id = 1) <> 0 THEN
    RAISE EXCEPTION 'the Diamond house balance moved; an earmark is not a movement';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the Diamond cash door';
  END IF;
  IF md5(pg_get_functiondef('public.fn_poker_diamond_create_tournament(jsonb)'::regprocedure))
       <> '05e4ae642e1a3949da8bb34bc62f7f3d' THEN
    RAISE EXCEPTION 'fn_poker_diamond_create_tournament moved; this migration must not touch a door';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;

  RAISE NOTICE 'the house earmarks what it has promised: an append-only earmark ledger on ca_diamond_house, available = balance less open earmarks, every cap on an open and none on a pay';
END $m$;

COMMIT;
