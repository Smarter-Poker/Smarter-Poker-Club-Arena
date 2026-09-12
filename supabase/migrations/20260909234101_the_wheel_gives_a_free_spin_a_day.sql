-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260909234101; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260909234101   (the stamp IS the apply time, UTC: 2026-09-09 23:41:01)
--   name        the_wheel_gives_a_free_spin_a_day
--   created_by  (not recorded)
--   statements  1 statement(s), 20967 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260909234101 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_wheel_free_spins_append_only
--     FUNCTION       public.fn_wheel_free_spin_result, public.fn_wheel_free_state, pg_temp.fs_patch, public.fn_wheel_free_spin, public.fn_wheel_set_free_spin
--     TABLE          public.wheel_free_segments, public.wheel_free_spins
--     INDEX          wheel_free_spins_host_day_idx
--     DROP           TRIGGER trg_wheel_free_spins_append_only, FUNCTION pg_temp.fs_patch
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
--  THE WHEEL GIVES A FREE SPIN A DAY
--
--  Dan 2026-09-09: "PROCEED TO THE NEXT PHASE OF THIS COMPLEX BUILD AND
--  UPGRADE / ENHANCEMENT OF THE DIAMON TO CHIPS GAMES." Asked, earlier, what to
--  build and what a free spin should pay: "YOU CAN DECIDE, IM OK WITH IT."
--
--  WHY. 1,172 players hold diamonds and, until today, had no reason to open
--  the wheel. A free spin a day is the reason: the same wheel, the same
--  provably fair commit-and-reveal, one spin on the house every day.
--
--  WHAT IT PAYS, AND WHY ONLY THAT. Diamonds. Never chips. A free spin takes
--  nothing in, and the games' law is that they never pay out more than they
--  take in - a chip minted against nothing is exactly the faucet that law
--  exists to close. Diamonds are the platform's promotional currency and are
--  granted every day already (the Daily Bonus, the missions, the challenges);
--  a free spin is the same class of grant, dealt from a wheel. The diamonds
--  it grants then go into the paid games at the 20 percent edge. That is the
--  loop, and it is the only loop that keeps the invariant.
--
--  THE TABLE. Six prizes, every one pays (a free spin that lands on Nothing is
--  a small insult, and the point of this is goodwill): 5 diamonds 70 percent,
--  10 at 20, 25 at 7, 50 at 2.5, 250 at 0.5. Expected value 9.75 diamonds,
--  about ten cents. Weights out of 1,000.
--
--  ITS OWN MACHINE. Free spins live in their own table (wheel_free_spins),
--  not in wheel_spins: a spin with no intake would put realised return over
--  100 percent and poison the z-score the operator console reads. Nothing in
--  fn_wheel_spin, fn_wheel_metrics or the paid law changes. The commit is the
--  same commit (fn_wheel_commit), the derivation is the same derivation (the
--  first 48 bits of HMAC-SHA256(server_seed, client:nonce) over the table's
--  weights), so the player's own verifier checks a free spin exactly as it
--  checks a paid one.
--
--  THE PROFILE GUARD. fn_guard_profile_privileged_columns refuses any write to
--  profiles.diamonds outside a service context or a named money door, by call
--  stack. The free spin is a new door: it credits a prize through
--  add_diamonds_to_balance from a player's own call, exactly as fn_wheel_spin
--  does, so it joins the allowlist the way fn_wheel_spin did (20260908001349)
--  and the arena doors did (20260908034530): the live body patched in place,
--  one line added after fn_wheel_spin's, nothing else touched.
--
--  THE GUARDS. One per player per host per day (America/Chicago, like every
--  other daily count on this platform). A per-host daily pot
--  (free_spin_daily_budget_diamonds, 2,000 by default, editable from the
--  operator console) after which the day's free spins are simply not offered:
--  that is a product rule announced before the player commits, not a refusal
--  of an earned reward, so ruling 21 is respected. The grant itself goes
--  through add_diamonds_to_balance with reference wheel:<id>:free, so the
--  diamond earn ledger attributes it to the wheel engine and the per-user
--  daily cap applies as it applies to every promotional grant.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. the switch and the pot, on the config the operator already runs ────
ALTER TABLE public.wheel_configs
  ADD COLUMN IF NOT EXISTS free_spin_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS free_spin_daily_budget_diamonds integer NOT NULL DEFAULT 2000
    CHECK (free_spin_daily_budget_diamonds >= 0);

-- ── 2. the free table: diamonds only, every segment pays ──────────────────
CREATE TABLE IF NOT EXISTS public.wheel_free_segments (
  ord      smallint PRIMARY KEY,
  label    text NOT NULL,
  amount   integer NOT NULL CHECK (amount > 0),
  weight   integer NOT NULL CHECK (weight > 0)
);
ALTER TABLE public.wheel_free_segments ENABLE ROW LEVEL SECURITY;
INSERT INTO public.wheel_free_segments (ord, label, amount, weight) VALUES
  (1, '5 Diamonds',   5,   700),
  (2, '10 Diamonds',  10,  200),
  (3, '25 Diamonds',  25,   70),
  (4, '50 Diamonds',  50,   25),
  (5, '250 Diamonds', 250,   5)
ON CONFLICT (ord) DO NOTHING;

-- ── 3. the record: append-only, like the paid spins ───────────────────────
CREATE TABLE IF NOT EXISTS public.wheel_free_spins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           uuid NOT NULL,
  host_kind         text NOT NULL,
  club_id           uuid NOT NULL,
  user_id           uuid NOT NULL,
  day               date NOT NULL,
  commit_id         uuid NOT NULL UNIQUE,
  server_seed_hash  text NOT NULL,
  server_seed       text NOT NULL,
  client_seed       text NOT NULL,
  nonce             bigint NOT NULL,
  roll              numeric NOT NULL,
  weight_total      integer NOT NULL,
  outcome_ord       smallint NOT NULL REFERENCES public.wheel_free_segments (ord),
  outcome_amount    integer NOT NULL,
  diamonds_after    numeric,
  is_fixture        boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS wheel_free_spins_host_day_idx ON public.wheel_free_spins (host_id, day);
ALTER TABLE public.wheel_free_spins ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_wheel_free_spins_append_only ON public.wheel_free_spins;
CREATE TRIGGER trg_wheel_free_spins_append_only
  BEFORE UPDATE OR DELETE ON public.wheel_free_spins
  FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_append_only();

-- ── 4. what a free spin looks like when it is handed back ─────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_spin_result(s public.wheel_free_spins)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'free', true, 'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', 0, 'spin_price_diamonds', 0, 'diamonds_per_chip', public.fn_ca_bridge_rate(),
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', 'diamonds', 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_free_segments g WHERE g.ord = s.outcome_ord),
                                  'value_chips', round(s.outcome_amount::numeric / public.fn_ca_bridge_rate(), 4)),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', (SELECT to_jsonb(array_agg(g.ord ORDER BY g.ord)) FROM public.wheel_free_segments g),
                                   'locked', '[]'::jsonb),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', NULL),
    'created_at', s.created_at);
$function$;

-- ── 5. is there a free spin for this player today? ────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_state(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_used boolean := false;
  v_paid_today integer := 0;
  v_segments jsonb;
  v_reason text := NULL;
  v_member boolean := false;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('ord', g.ord, 'label', g.label, 'kind', 'diamonds',
                                               'amount', g.amount, 'weight', g.weight,
                                               'value_chips', round(g.amount::numeric / public.fn_ca_bridge_rate(), 4),
                                               'probability', round(g.weight::numeric / t.total, 6),
                                               'locked', false)
                            ORDER BY g.ord), '[]'::jsonb)
    INTO v_segments
    FROM public.wheel_free_segments g, (SELECT sum(weight) AS total FROM public.wheel_free_segments) t;

  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
    v_reason := 'closed';
  END IF;
  IF v_user IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.wheel_free_spins f
                    WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day) INTO v_used;
    SELECT EXISTS (SELECT 1 FROM public.club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = v_user
                      AND COALESCE(m.status, 'active') IN ('active', 'approved')) INTO v_member;
  END IF;
  SELECT COALESCE(sum(f.outcome_amount), 0)::integer INTO v_paid_today
    FROM public.wheel_free_spins f WHERE f.host_id = v_host AND f.day = v_day AND NOT f.is_fixture;
  IF v_reason IS NULL AND v_used THEN v_reason := 'used'; END IF;
  IF v_reason IS NULL AND v_paid_today >= COALESCE(cfg.free_spin_daily_budget_diamonds, 0) THEN v_reason := 'pot_empty'; END IF;
  IF v_reason IS NULL AND v_user IS NOT NULL AND NOT v_member THEN v_reason := 'not_member'; END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled', COALESCE(cfg.free_spin_enabled, false) AND COALESCE(cfg.enabled, false),
    'available', v_user IS NOT NULL AND v_reason IS NULL,
    'reason', v_reason,
    'used_today', v_used,
    'pot_diamonds', COALESCE(cfg.free_spin_daily_budget_diamonds, 0),
    'pot_paid_today', v_paid_today,
    'segments', v_segments,
    'day', v_day);
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_free_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_state(uuid) TO authenticated, service_role;

-- ── 6. the profile guard admits the free spin ─────────────────────────────
CREATE FUNCTION pg_temp.fs_patch(p_fn text, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $fs$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'fs_patch: marker in % found % times', p_fn, v_n; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $fs$;
SELECT pg_temp.fs_patch('fn_guard_profile_privileged_columns',
$fs_from$     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'$fs_from$,
$fs_to$     OR v_stack ~ 'function (public[.])?fn_wheel_spin[(]'
     OR v_stack ~ 'function (public[.])?fn_wheel_free_spin[(]'$fs_to$);
DROP FUNCTION pg_temp.fs_patch(text, text, text);

-- ── 7. the free spin itself ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_free_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_free_spins%ROWTYPE;
  seg record; v_pick record; v_found boolean := false;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_day date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer; v_acc integer := 0;
  v_paid_today integer;
  v_credit jsonb; v_dia_after numeric;
  v_is_fixture boolean := false;
  v_spin_id uuid := gen_random_uuid();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- replay: a commit is spent once; the second call returns the first spin
  SELECT * INTO prior FROM public.wheel_free_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    RETURN public.fn_wheel_free_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- the host, locked: the day's pot is counted under this lock, so two spins
  -- cannot both squeeze through the last of it
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL OR NOT cfg.enabled OR NOT cfg.free_spin_enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'There Is No Free Spin Here Today');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;
  IF EXISTS (SELECT 1 FROM public.wheel_free_spins f
              WHERE f.host_id = v_host AND f.user_id = v_user AND f.day = v_day) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'You Have Had Today''s Free Spin. Another Comes Tomorrow');
  END IF;
  SELECT COALESCE(sum(f.outcome_amount), 0)::integer INTO v_paid_today
    FROM public.wheel_free_spins f WHERE f.host_id = v_host AND f.day = v_day AND NOT f.is_fixture;
  IF v_paid_today >= cfg.free_spin_daily_budget_diamonds THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Today''s Free Spins Are Gone. They Return Tomorrow');
  END IF;

  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;

  -- the roll: the same derivation as a paid spin, over the free table's weights
  SELECT sum(g.weight)::integer INTO v_total FROM public.wheel_free_segments g;
  IF COALESCE(v_total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Free Table Is Empty');
  END IF;
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_free_spins f WHERE f.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  FOR seg IN SELECT * FROM public.wheel_free_segments g ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_free_segments g ORDER BY g.ord DESC LIMIT 1;
  END IF;

  -- the grant: the same door every promotional diamond goes through
  v_credit := public.add_diamonds_to_balance(v_user, v_pick.amount, 'wheel_prize',
                format('Diamond Wheel: free spin, %s', v_pick.label), 'wheel:' || v_spin_id::text || ':free');
  IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'fn_wheel_free_spin: the free spin prize could not be credited: %', v_credit->>'error';
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;

  INSERT INTO public.wheel_free_spins
    (id, host_id, host_kind, club_id, user_id, day, commit_id, server_seed_hash, server_seed, client_seed,
     nonce, roll, weight_total, outcome_ord, outcome_amount, diamonds_after, is_fixture)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, v_day, cm.id, cm.server_seed_hash, cm.server_seed, v_client,
     v_nonce, v_roll, v_total, v_pick.ord, v_pick.amount, v_dia_after, v_is_fixture)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_free_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) TO authenticated, service_role;

-- ── 8. the operator's switch and pot ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_set_free_spin(p_club_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  v_enabled boolean; v_pot integer;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host''s Owners And Admins Run The Wheel');
  END IF;
  v_enabled := CASE WHEN p_patch ? 'free_spin_enabled' THEN (p_patch->>'free_spin_enabled')::boolean END;
  v_pot     := CASE WHEN p_patch ? 'free_spin_daily_budget_diamonds' THEN (p_patch->>'free_spin_daily_budget_diamonds')::integer END;
  IF v_pot IS NOT NULL AND v_pot < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Daily Pot Must Be Zero Or More Diamonds');
  END IF;
  UPDATE public.wheel_configs
     SET free_spin_enabled = COALESCE(v_enabled, free_spin_enabled),
         free_spin_daily_budget_diamonds = COALESCE(v_pot, free_spin_daily_budget_diamonds),
         updated_by = v_user, updated_at = now()
   WHERE host_id = v_host;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Wheel Is Not Configured Here');
  END IF;
  RETURN jsonb_build_object('ok', true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_set_free_spin(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_free_spin(uuid, jsonb) TO authenticated, service_role;

-- ── 9. the table audits, and the doors refuse a caller with no account ────
DO $$
DECLARE v_total integer; v_ev numeric; v_res jsonb;
BEGIN
  SELECT sum(weight), round(sum(weight * amount)::numeric / sum(weight), 4) INTO v_total, v_ev
    FROM public.wheel_free_segments;
  IF v_total <> 1000 THEN
    RAISE EXCEPTION 'free spin: the table weighs % not 1000', v_total;
  END IF;
  IF v_ev <> 9.75 THEN
    RAISE EXCEPTION 'free spin: the table pays % diamonds a spin, not 9.75', v_ev;
  END IF;
  IF EXISTS (SELECT 1 FROM public.wheel_free_segments WHERE amount <= 0) THEN
    RAISE EXCEPTION 'free spin: every segment pays';
  END IF;
  IF pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure)
     NOT LIKE '%fn_wheel_free_spin[(]%' THEN
    RAISE EXCEPTION 'free spin: the profile guard does not name the door';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_res := public.fn_wheel_free_spin('00000000-0000-0000-0000-000000000000'::uuid, gen_random_uuid(), 'x');
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'free spin: answered a caller with no account: %', v_res;
  END IF;
  v_res := public.fn_wheel_set_free_spin('00000000-0000-0000-0000-000000000000'::uuid, '{}'::jsonb);
  IF (v_res->>'ok')::boolean THEN
    RAISE EXCEPTION 'free spin: the switch answered a caller with no account: %', v_res;
  END IF;
END $$;

COMMIT;
