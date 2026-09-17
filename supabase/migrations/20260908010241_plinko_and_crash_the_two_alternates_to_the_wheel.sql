-- 20260908010241_plinko_and_crash_the_two_alternates_to_the_wheel.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-09-08: "ALSO WANT TO HAVE TWO ALTERNATES TO THE DIAMOND TO CHIP
-- SPINNING WHEEL. 1ST, A PLINKO VERSION, 50X CAN BE HIGHER ON THIS, BUT CRASH
-- OUT PAYS NOTHING, AND YOU STILL NEED TO MAINTAIN THE 20% EDGE. 2ND, A CRASH /
-- AVIATOR-STYLE: MULTIPLIER CLIMBS UNTIL IT CRASHES; CASH OUT FIRST. 50X CAN BE
-- HIGHER, CRASH OUT PAYS NOTHING, AND YOU STILL NEED TO MAINTAIN THE 20% EDGE."
--
-- Both games stand on the wheel's foundation (20260907233833) and share one
-- money shape with it:
--
--   * a round is paid for in diamonds through deduct_diamonds (purchased lots
--     only by default, Diamond Standard D5);
--   * 80 percent of the intake is minted, in chips, to the host bank through
--     the issuance door (declared 'mint' from issuance_reserve; the chip_ledger
--     trigger registers it in ca_mint_ledger under ca_mint_policy). A bet is a
--     whole number of chips, so the mint is exact cents and needs no carry;
--   * 20 percent is retired diamonds: the house, recognised at consumption;
--   * a payout comes ONLY from the host bank and ONLY inside
--         chips_paid + payout <= chips_minted + exposure_allowance_chips
--     so, by arithmetic and whatever the RNG does,
--         cumulative chips paid <= 0.80 x cumulative intake + allowance.
--
-- Where the wheel LOCKS a tier it cannot afford, these two games CAP the
-- multiplier: before a round the pool computes the largest multiplier it can
-- pay on that bet - cap_fraction (0.95) of its headroom, and never more than
-- the host bank holds beyond what open rounds already reserve - and the round
-- is played against min(table, cap). The cap is shown before the bet is
-- placed; a capped round is counted as constrained. The 0.95 is what keeps the
-- pool alive: a full-cap hit leaves five percent of the headroom plus the
-- round's own mint, so the next round always has a cap above 1.00 and the pool
-- rebuilds from play. (A cap of 100 percent could leave a pool exactly at its
-- ceiling with nothing playable and no intake to rebuild it - a deadlock, not
-- a repair job; seen in simulation before this was written.)
--
-- PLINKO: 16 rows, 17 slots. Slot k has probability C(16,k)/65536 - the ball's
-- path is the first sixteen bits of the round's HMAC, one per row, left or
-- right, and the slot is the number of rights. Three tables, each auditing to
-- EXACTLY 0.800000 on the binomial weights (sum C(16,k) * m_k = 5,242,880
-- cents-weight), the centre slot paying nothing on every one:
--   1 Steady   20x 10x 5x 2.5x 1.6x 1.3x 1x 0.65x | 0 | ...   sd 0.62 hit 80.4%
--   2 Bold    130x 40x 9.95x 4.1x 2x 1.05x 1x 0.5x | 0 | ...  sd 1.42 hit 80.4%
--   3 Moonshot 1000x 100.5x 20.25x 5.25x 2.5x 1.3x 1x 0 | 0 | ... sd 6.13 hit 45.5%
-- The edge slot is 1 in 32,768 either side. fn_plinko_table_audit derives the
-- return from the weights and fn_diamond_game_set_config refuses to enable a
-- host against a table that does not audit; a table is activated only when it
-- does.
--
-- CRASH: the crash point is X = floor(80 * 2^48 / (r + 1)) cents, r the 48-bit
-- roll, floored at 1.00. For any cash-out target x >= 1.01, P(X >= x) = 0.8 / x
-- exactly (to the 48-bit grain), so cashing out at ANY target returns 80
-- percent in expectation - including 1.01x, and including the cap. About 20.8
-- percent of rounds crash instantly at 1.00 and pay nothing. The multiplier
-- climbs as e^(k t), k = 0.12 per second (2x at 5.8s, 50x at 32.6s, 1000x at
-- 57.6s), measured on the server's clock from the row's started_at; the client
-- only draws it. Cashing out is a server call: the multiplier is what the
-- server's clock says when the call is processed, never what the screen showed.
-- An auto cash-out target chosen before the round is honoured by the server
-- the moment the curve passes it, whatever the connection does afterwards. A
-- round nobody touches is settled by time: once the curve has passed the cap
-- the outcome is already decided (cashed at the auto target, cashed at the cap
-- if it never crashed, or crashed), and the next call on that host settles it.
-- That is the live path finishing its own work, not a sweep (CLAUDE.md 10.12).
-- The largest payout an open round can produce (bet x cap) is reserved in the
-- pool until it settles, so two open rounds can never both be promised the
-- same headroom or the same bank.
--
-- Fairness on both: HMAC-SHA256(server_seed, client_seed || ':' || nonce), the
-- server seed committed by hash before the bet and revealed after settlement.
-- The browser recomputes the path, the slot and the crash point from the same
-- bytes (src/utils/wheelFairness.ts).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ── 0. the kill switch learns two scopes ─────────────────────────────────────
ALTER TABLE public.ca_payout_freeze DROP CONSTRAINT IF EXISTS ca_payout_freeze_scope_check;
ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_scope_check
  CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text, 'wheel'::text, 'plinko'::text, 'crash'::text])));

-- ── 1. tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diamond_game_configs (
  host_id                        uuid NOT NULL,
  game                           text NOT NULL CHECK (game IN ('plinko', 'crash')),
  host_kind                      text NOT NULL CHECK (host_kind IN ('union', 'club')),
  enabled                        boolean NOT NULL DEFAULT false,
  min_bet_diamonds               integer NOT NULL DEFAULT 100 CHECK (min_bet_diamonds > 0),
  max_bet_diamonds               integer NOT NULL DEFAULT 1000 CHECK (max_bet_diamonds >= min_bet_diamonds),
  bet_options                    integer[] NOT NULL DEFAULT ARRAY[100, 200, 500, 1000],
  exposure_allowance_chips       numeric(14,2) NOT NULL DEFAULT 1250 CHECK (exposure_allowance_chips >= 0),
  cap_fraction                   numeric(4,3) NOT NULL DEFAULT 0.950 CHECK (cap_fraction > 0 AND cap_fraction < 1),
  max_multiplier_cents           integer NOT NULL DEFAULT 100000 CHECK (max_multiplier_cents >= 101),
  growth_k                       numeric(6,4) NOT NULL DEFAULT 0.1200 CHECK (growth_k > 0),
  purchased_only                 boolean NOT NULL DEFAULT true,
  allow_fixture_accounts         boolean NOT NULL DEFAULT false,
  max_rounds_per_player_per_day  integer NOT NULL DEFAULT 500 CHECK (max_rounds_per_player_per_day > 0),
  min_seconds_between_rounds     integer NOT NULL DEFAULT 2 CHECK (min_seconds_between_rounds >= 0),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by                     uuid,
  PRIMARY KEY (host_id, game)
);
COMMENT ON TABLE public.diamond_game_configs IS
  'One row per host per game (plinko, crash). exposure_allowance_chips is the working capital the host accepts as its maximum exposure: cumulative chips paid may exceed cumulative chips minted by at most this much. cap_fraction is the share of the pool''s headroom a single round may be promised. max_multiplier_cents is the ceiling (crash; plinko tables carry their own). growth_k is the crash curve e^(k t).';

CREATE TABLE IF NOT EXISTS public.diamond_game_config_history (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  host_id     uuid NOT NULL,
  game        text NOT NULL,
  changed_by  uuid,
  db_role     text NOT NULL DEFAULT current_user,
  before      jsonb,
  after       jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.diamond_game_pools (
  host_id             uuid NOT NULL,
  game                text NOT NULL,
  rounds              bigint NOT NULL DEFAULT 0,
  intake_diamonds     numeric(18,0) NOT NULL DEFAULT 0,
  chips_minted        numeric(16,2) NOT NULL DEFAULT 0,
  chips_paid          numeric(16,2) NOT NULL DEFAULT 0,
  reserved_chips      numeric(16,2) NOT NULL DEFAULT 0 CHECK (reserved_chips >= 0),
  constrained_rounds  bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, game),
  FOREIGN KEY (host_id, game) REFERENCES public.diamond_game_configs (host_id, game) ON DELETE RESTRICT
);
COMMENT ON TABLE public.diamond_game_pools IS
  'Plinko and Crash economics per host per game. Invariant, checked on every round and by fn_diamond_game_metrics: chips_paid + reserved_chips <= chips_minted + exposure_allowance_chips. chips_minted is 0.80 of intake; reserved_chips is the largest payout every OPEN crash round could still produce.';

CREATE TABLE IF NOT EXISTS public.diamond_game_commits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  game              text NOT NULL CHECK (game IN ('plinko', 'crash')),
  server_seed       text NOT NULL,
  server_seed_hash  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_by       uuid
);
CREATE INDEX IF NOT EXISTS diamond_game_commits_user_open_idx
  ON public.diamond_game_commits (user_id, game) WHERE consumed_by IS NULL;

CREATE TABLE IF NOT EXISTS public.plinko_tables (
  version               integer PRIMARY KEY,
  name                  text NOT NULL,
  board_rows            smallint NOT NULL DEFAULT 16 CHECK (board_rows = 16),
  multipliers_cents     integer[] NOT NULL CHECK (array_length(multipliers_cents, 1) = 17),
  max_multiplier_cents  integer NOT NULL,
  spec_rtp              numeric(8,6),
  sd_chips              numeric(10,6),
  hit_rate              numeric(8,6),
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz
);
COMMENT ON TABLE public.plinko_tables IS
  'Diamond Plinko multiplier tables, 17 slots for 16 rows, in cents of a chip per chip bet. Slot k has probability C(16,k)/65536. Activated only when fn_plinko_table_audit returns exactly 0.800000.';

CREATE TABLE IF NOT EXISTS public.plinko_drops (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id                   uuid NOT NULL,
  host_kind                 text NOT NULL,
  club_id                   uuid NOT NULL,
  user_id                   uuid NOT NULL,
  table_version             integer NOT NULL,
  bet_diamonds              integer NOT NULL,
  bet_chips                 numeric(14,2) NOT NULL,
  diamonds_per_chip         integer NOT NULL,
  commit_id                 uuid NOT NULL UNIQUE,
  server_seed_hash          text NOT NULL,
  server_seed               text NOT NULL,
  client_seed               text NOT NULL,
  nonce                     bigint NOT NULL,
  hmac_hex                  text NOT NULL,
  path_bits                 integer NOT NULL,
  slot                      smallint NOT NULL CHECK (slot BETWEEN 0 AND 16),
  table_multiplier_cents    integer NOT NULL,
  cap_multiplier_cents      integer NOT NULL,
  multiplier_cents          integer NOT NULL,
  capped                    boolean NOT NULL DEFAULT false,
  payout_chips              numeric(14,2) NOT NULL,
  chips_minted              numeric(14,2) NOT NULL,
  pool_chips_minted_after   numeric(16,2) NOT NULL,
  pool_chips_paid_after     numeric(16,2) NOT NULL,
  diamonds_after            numeric NOT NULL,
  member_chips_after        numeric(14,2),
  is_fixture                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plinko_drops_user_time_idx ON public.plinko_drops (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plinko_drops_host_time_idx ON public.plinko_drops (host_id, created_at DESC);
COMMENT ON TABLE public.plinko_drops IS
  'Every Diamond Plinko drop: seeds, the HMAC, the ball''s path (bit i = row i, 1 = right), the slot, the table and capped multipliers, the payout and the pool after. Append-only.';

CREATE TABLE IF NOT EXISTS public.crash_rounds (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id                   uuid NOT NULL,
  host_kind                 text NOT NULL,
  club_id                   uuid NOT NULL,
  user_id                   uuid NOT NULL,
  bet_diamonds              integer NOT NULL,
  bet_chips                 numeric(14,2) NOT NULL,
  diamonds_per_chip         integer NOT NULL,
  commit_id                 uuid NOT NULL UNIQUE,
  server_seed_hash          text NOT NULL,
  server_seed               text NOT NULL,
  client_seed               text NOT NULL,
  nonce                     bigint NOT NULL,
  roll                      numeric(20,0) NOT NULL,
  crash_cents               bigint NOT NULL CHECK (crash_cents >= 100),
  cap_cents                 integer NOT NULL CHECK (cap_cents >= 101),
  growth_k                  numeric(6,4) NOT NULL,
  auto_cashout_cents        integer,
  reserved_chips            numeric(14,2) NOT NULL,
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cashed', 'crashed')),
  started_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at                timestamptz,
  settled_by                text,
  elapsed_ms                integer,
  cashout_cents             integer,
  payout_chips              numeric(14,2) NOT NULL DEFAULT 0,
  chips_minted              numeric(14,2) NOT NULL,
  pool_chips_minted_after   numeric(16,2),
  pool_chips_paid_after     numeric(16,2),
  diamonds_after            numeric NOT NULL,
  member_chips_after        numeric(14,2),
  is_fixture                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crash_rounds_user_time_idx ON public.crash_rounds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_rounds_host_time_idx ON public.crash_rounds (host_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_rounds_open_idx ON public.crash_rounds (host_id, user_id) WHERE status = 'open';
COMMENT ON TABLE public.crash_rounds IS
  'Every Diamond Crash round: the seeds, the roll, the crash point (secret until settled), the cap, the auto cash-out, and the settlement. A row is written once at start and settled once; after that it is a fact.';

CREATE OR REPLACE FUNCTION public.fn_diamond_game_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'crash_rounds' AND TG_OP = 'UPDATE' AND OLD.status = 'open' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: a settled round is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_plinko_drops_append_only ON public.plinko_drops;
CREATE TRIGGER trg_plinko_drops_append_only
  BEFORE UPDATE OR DELETE ON public.plinko_drops
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_append_only();
DROP TRIGGER IF EXISTS trg_crash_rounds_append_only ON public.crash_rounds;
CREATE TRIGGER trg_crash_rounds_append_only
  BEFORE UPDATE OR DELETE ON public.crash_rounds
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_append_only();
DROP TRIGGER IF EXISTS trg_diamond_game_config_history_append_only ON public.diamond_game_config_history;
CREATE TRIGGER trg_diamond_game_config_history_append_only
  BEFORE UPDATE OR DELETE ON public.diamond_game_config_history
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_append_only();

CREATE OR REPLACE FUNCTION public.fn_diamond_game_config_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.diamond_game_config_history (host_id, game, changed_by, before, after)
  VALUES (NEW.host_id, NEW.game, COALESCE(NEW.updated_by, auth.uid()),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_config_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_diamond_game_config_history ON public.diamond_game_configs;
CREATE TRIGGER trg_diamond_game_config_history
  AFTER INSERT OR UPDATE ON public.diamond_game_configs
  FOR EACH ROW EXECUTE FUNCTION public.fn_diamond_game_config_history();

-- ── 2. the plinko tables, audited ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_plinko_table_audit(p_version integer,
  OUT spec_rtp numeric, OUT sd_chips numeric, OUT hit_rate numeric, OUT max_multiplier_cents integer, OUT slots integer)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  c constant integer[] := ARRAY[1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1];
  m integer[];
  v_ev numeric := 0; v_e2 numeric := 0; v_hit numeric := 0; i integer;
BEGIN
  SELECT t.multipliers_cents INTO m FROM public.plinko_tables t WHERE t.version = p_version;
  IF m IS NULL THEN RETURN; END IF;
  FOR i IN 1..17 LOOP
    v_ev  := v_ev  + c[i] * m[i];
    v_e2  := v_e2  + c[i] * (m[i]::numeric * m[i]);
    v_hit := v_hit + CASE WHEN m[i] > 0 THEN c[i] ELSE 0 END;
  END LOOP;
  spec_rtp := round(v_ev / (65536 * 100), 6);
  sd_chips := round(sqrt(v_e2 / (65536 * 10000) - power(v_ev / (65536 * 100), 2)), 6);
  hit_rate := round(v_hit / 65536, 6);
  max_multiplier_cents := (SELECT max(x) FROM unnest(m) x);
  slots := 17;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_plinko_table_audit(integer) TO authenticated, service_role;

INSERT INTO public.plinko_tables (version, name, multipliers_cents, max_multiplier_cents, note) VALUES
  (1, 'Steady',   ARRAY[2000,1000,500,250,160,130,100,65,0,65,100,130,160,250,500,1000,2000], 2000,
      'Launch table: 80.4 percent of balls pay, the centre pays nothing, 20x at the edge (1 in 32,768). Expected value exactly 0.80 of the bet.'),
  (2, 'Bold',     ARRAY[13000,4000,995,410,200,105,100,50,0,50,100,105,200,410,995,4000,13000], 13000,
      'Launch table: 80.4 percent of balls pay, 130x at the edge (1 in 32,768), 40x beside it. Expected value exactly 0.80 of the bet.'),
  (3, 'Moonshot', ARRAY[100000,10050,2025,525,250,130,100,0,0,0,100,130,250,525,2025,10050,100000], 100000,
      'Launch table: the three centre slots pay nothing (45.5 percent of balls pay), 1000x at the edge (1 in 32,768), 100.5x beside it. Expected value exactly 0.80 of the bet.')
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_plinko_activate_table(p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE a record;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only Platform Management Activates A Plinko Table');
  END IF;
  SELECT x.* INTO a FROM public.fn_plinko_table_audit(p_version) x;
  IF a.spec_rtp IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Table Does Not Exist');
  END IF;
  IF a.spec_rtp <> 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Return To Player Must Be Exactly 80 Percent, Not %s', a.spec_rtp), 'audit', to_jsonb(a));
  END IF;
  UPDATE public.plinko_tables
     SET spec_rtp = a.spec_rtp, sd_chips = a.sd_chips, hit_rate = a.hit_rate,
         max_multiplier_cents = a.max_multiplier_cents, activated_at = COALESCE(activated_at, now())
   WHERE version = p_version;
  RETURN jsonb_build_object('ok', true, 'version', p_version, 'audit', to_jsonb(a));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_plinko_activate_table(integer) TO authenticated, service_role;

-- Activate the three launch tables from inside the migration (service context).
DO $$
DECLARE v integer; a record;
BEGIN
  FOR v IN 1..3 LOOP
    SELECT x.* INTO a FROM public.fn_plinko_table_audit(v) x;
    IF a.spec_rtp <> 0.800000 THEN
      RAISE EXCEPTION 'plinko table % audits to %, not 0.800000', v, a.spec_rtp;
    END IF;
    UPDATE public.plinko_tables
       SET spec_rtp = a.spec_rtp, sd_chips = a.sd_chips, hit_rate = a.hit_rate,
           max_multiplier_cents = a.max_multiplier_cents, activated_at = COALESCE(activated_at, now())
     WHERE version = v;
  END LOOP;
END $$;

-- ── 3. the commit ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_commit(p_game text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text; v_hash text; v_id uuid; v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.diamond_game_commits (user_id, game, server_seed, server_seed_hash)
  VALUES (v_user, p_game, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_commit(text) TO authenticated, service_role;

-- ── 4. the cap: the largest multiplier the pool can promise on a bet ─────────
-- Headroom is what the pool may still pay: minted + this round's mint +
-- allowance - paid - reserved. The cap is cap_fraction of it per chip bet,
-- never above the ceiling, never above what the host bank actually holds
-- beyond the open reservations. Returns cents; below 101 means unplayable.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_cap_cents(
  p_cfg public.diamond_game_configs, p_pool public.diamond_game_pools,
  p_bank numeric, p_bet_chips numeric, p_ceiling_cents integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_mint numeric := round(p_bet_chips * 0.8, 2);
  v_headroom numeric; v_bank_room numeric; v_cap numeric;
BEGIN
  v_headroom  := COALESCE(p_pool.chips_minted, 0) + v_mint + p_cfg.exposure_allowance_chips
               - COALESCE(p_pool.chips_paid, 0) - COALESCE(p_pool.reserved_chips, 0);
  v_bank_room := COALESCE(p_bank, 0) + v_mint - COALESCE(p_pool.reserved_chips, 0);
  v_cap := LEAST(p_ceiling_cents::numeric,
                 floor(p_cfg.cap_fraction * v_headroom / p_bet_chips * 100),
                 floor(v_bank_room / p_bet_chips * 100));
  RETURN GREATEST(0, v_cap)::integer;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_cap_cents(public.diamond_game_configs, public.diamond_game_pools, numeric, numeric, integer) FROM PUBLIC, anon, authenticated;

-- ── 5. crash arithmetic ──────────────────────────────────────────────────────
-- The crash point from the 48-bit roll: floor(80 * 2^48 / (r + 1)) cents,
-- floored at 1.00. P(X >= x) = 0.8 / x for any x >= 1.
CREATE OR REPLACE FUNCTION public.fn_crash_point_cents(p_roll numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(100::bigint, floor(22517998136852480::numeric / (p_roll + 1))::bigint);
$function$;
GRANT EXECUTE ON FUNCTION public.fn_crash_point_cents(numeric) TO authenticated, service_role;

-- The multiplier the curve shows after t seconds, in cents, floored.
CREATE OR REPLACE FUNCTION public.fn_crash_multiplier_cents(p_k numeric, p_elapsed_ms bigint, p_cap_cents integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT LEAST(p_cap_cents::numeric,
               floor(exp(LEAST(p_k * GREATEST(p_elapsed_ms, 0)::numeric / 1000, 12::numeric)) * 100))::integer;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_crash_multiplier_cents(numeric, bigint, integer) TO authenticated, service_role;

-- ── 6. the money legs, shared by both games ──────────────────────────────────
-- Mint the round's chip share to the host bank (an issuance, registered by the
-- chip_ledger trigger). Returns the bank after.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_mint_leg(p_host uuid, p_kind text, p_amount numeric, p_key text)
RETURNS numeric
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_after numeric;
BEGIN
  IF p_amount <= 0 THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, p_key, NULL);
  IF p_kind = 'union' THEN
    UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
     WHERE union_id = p_host RETURNING chip_balance INTO v_after;
  ELSE
    UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount, updated_at = now()
     WHERE id = p_host RETURNING chip_treasury INTO v_after;
  END IF;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = p_key) THEN
    RAISE EXCEPTION 'diamond games: the host bank moved but no mint leg was journaled for %', p_key;
  END IF;
  RETURN v_after;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_mint_leg(uuid, text, numeric, text) FROM PUBLIC, anon, authenticated;

-- Pay a prize from the host bank into the member wallet: one journal row,
-- host side autoskipped because union_wallet_transactions / chip_transactions
-- record it (the wheel's shape). Returns (bank_after, member_after).
CREATE OR REPLACE FUNCTION public.fn_diamond_game_prize_leg(
  p_game text, p_host uuid, p_kind text, p_club uuid, p_user uuid, p_amount numeric, p_key text, p_note text, p_meta jsonb,
  OUT bank_after numeric, OUT member_after numeric)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_category text := p_game || '_prize';
BEGIN
  IF p_amount <= 0 THEN
    RETURN;
  END IF;
  PERFORM public.fn_ca_declare_ledger(v_category,
            CASE WHEN p_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
            p_host, NULL, p_key,
            CASE WHEN p_kind = 'union' THEN ARRAY['union_wallets'] ELSE ARRAY['clubs'] END);
  IF p_kind = 'union' THEN
    UPDATE public.union_wallets SET chip_balance = chip_balance - p_amount, updated_at = now()
     WHERE union_id = p_host AND COALESCE(chip_balance, 0) >= p_amount
     RETURNING chip_balance INTO bank_after;
  ELSE
    UPDATE public.clubs SET chip_treasury = chip_treasury - p_amount, updated_at = now()
     WHERE id = p_host AND COALESCE(chip_treasury, 0) >= p_amount
     RETURNING chip_treasury INTO bank_after;
  END IF;
  IF bank_after IS NULL THEN
    RAISE EXCEPTION 'diamond games: the host bank refused the % payout of %', p_game, p_amount;
  END IF;
  UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE club_id = p_club AND user_id = p_user
     AND COALESCE(status, 'active') IN ('active', 'approved')
   RETURNING chip_balance INTO member_after;
  IF member_after IS NULL THEN
    RAISE EXCEPTION 'diamond games: the % payout landed nowhere for % in club %', p_game, p_user, p_club;
  END IF;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  PERFORM set_config('app.ledger_idempotency_key', '', true);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  PERFORM set_config('app.ledger_autoskip_clubs', '', true);
  IF p_kind = 'union' THEN
    INSERT INTO public.union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    VALUES (p_host, p_club, 'chip_balance', 'debit', p_amount, bank_after, v_category, p_note, p_user);
  END IF;
  INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES (p_club, NULL, p_user, p_amount, v_category, p_note, p_meta, member_after);
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_prize_leg(text, uuid, text, uuid, uuid, numeric, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Take the bet in diamonds, purchased lots first when the host says so.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_take_bet(
  p_user uuid, p_bet integer, p_purchased_only boolean, p_type text, p_description text, p_reference text, p_meta jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_deduct jsonb; v_remaining integer; v_take integer; v_lot record;
BEGIN
  v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, p_type, p_meta, p_reference, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN v_deduct;
  END IF;
  IF p_purchased_only THEN
    v_remaining := p_bet;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = p_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'diamond games: purchased lots could not cover the bet (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;
  RETURN v_deduct;
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_take_bet(uuid, integer, boolean, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ── 7. the crash settlement engine ───────────────────────────────────────────
-- Decides an open round from the server clock. p_cashout asks to cash out now.
-- Returns the row after (settled or still open). Requires the caller to hold
-- the config row lock for the host (every entry point takes it).
CREATE OR REPLACE FUNCTION public.fn_crash_decide(p_round public.crash_rounds, p_cashout boolean, p_by text)
RETURNS public.crash_rounds
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  r public.crash_rounds := p_round;
  v_elapsed_ms bigint;
  v_now_cents integer;
  v_result text;          -- 'cashed' | 'crashed' | NULL (still open)
  v_at_cents integer;
  v_payout numeric := 0;
  v_bank_after numeric; v_member_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  cfg public.diamond_game_configs%ROWTYPE;
BEGIN
  IF r.status <> 'open' THEN
    RETURN r;
  END IF;
  v_elapsed_ms := floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint;
  v_now_cents := public.fn_crash_multiplier_cents(r.growth_k, v_elapsed_ms, r.cap_cents);

  -- An auto target below the crash point is honoured the moment the curve
  -- passes it, whatever else happened since.
  IF r.auto_cashout_cents IS NOT NULL AND r.auto_cashout_cents < r.crash_cents AND v_now_cents >= r.auto_cashout_cents THEN
    v_result := 'cashed'; v_at_cents := r.auto_cashout_cents;
  -- The curve reached the cap before the crash point: cashed at the cap.
  ELSIF r.crash_cents >= r.cap_cents AND v_now_cents >= r.cap_cents THEN
    v_result := 'cashed'; v_at_cents := r.cap_cents;
  -- The curve reached the crash point: nothing.
  ELSIF v_now_cents >= r.crash_cents THEN
    v_result := 'crashed'; v_at_cents := NULL;
  ELSIF p_cashout THEN
    v_result := 'cashed'; v_at_cents := v_now_cents;
  ELSE
    RETURN r;
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = r.host_id AND game = 'crash';
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = r.host_id AND game = 'crash' FOR UPDATE;

  IF v_result = 'cashed' THEN
    v_payout := round(r.bet_chips * v_at_cents / 100, 2);
    IF v_payout > r.reserved_chips THEN
      RAISE EXCEPTION 'fn_crash_decide: payout % exceeds the round''s reservation % (cap %)', v_payout, r.reserved_chips, r.cap_cents;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('crash', r.host_id, r.host_kind, r.club_id, r.user_id, v_payout,
             'crash-prize:' || r.id::text,
             format('Diamond Crash: cashed out at %s.%sx', v_at_cents / 100, lpad((v_at_cents % 100)::text, 2, '0')),
             jsonb_build_object('round_id', r.id, 'host_id', r.host_id, 'host_kind', r.host_kind,
                                'cashout_cents', v_at_cents, 'crash_cents', r.crash_cents, 'auto', r.auto_cashout_cents IS NOT NULL AND v_at_cents = r.auto_cashout_cents)) x;
  END IF;

  UPDATE public.diamond_game_pools
     SET chips_paid = chips_paid + v_payout,
         reserved_chips = reserved_chips - r.reserved_chips,
         updated_at = now()
   WHERE host_id = r.host_id AND game = 'crash'
   RETURNING * INTO pool;
  IF pool.chips_paid + pool.reserved_chips > pool.chips_minted + cfg.exposure_allowance_chips + 0.000001 THEN
    RAISE EXCEPTION 'fn_crash_decide: chips_paid % + reserved % would exceed chips_minted % + allowance % - the cap was bypassed',
      pool.chips_paid, pool.reserved_chips, pool.chips_minted, cfg.exposure_allowance_chips;
  END IF;

  UPDATE public.crash_rounds
     SET status = v_result, settled_at = clock_timestamp(), settled_by = p_by,
         elapsed_ms = LEAST(v_elapsed_ms, 2147483647)::integer, cashout_cents = v_at_cents, payout_chips = v_payout,
         pool_chips_minted_after = pool.chips_minted, pool_chips_paid_after = pool.chips_paid,
         member_chips_after = COALESCE(v_member_after, member_chips_after)
   WHERE id = r.id
   RETURNING * INTO r;
  RETURN r;
END $function$;
REVOKE ALL ON FUNCTION public.fn_crash_decide(public.crash_rounds, boolean, text) FROM PUBLIC, anon, authenticated;

-- Settle every open round on a host that time has already decided (the curve
-- is past its cap). Called on the way into every money path on the host, so a
-- reservation never outlives the round that holds it.
CREATE OR REPLACE FUNCTION public.fn_crash_settle_decided(p_host uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE r public.crash_rounds; v_n integer := 0; v_after public.crash_rounds;
BEGIN
  FOR r IN SELECT * FROM public.crash_rounds c
            WHERE c.host_id = p_host AND c.status = 'open'
              AND clock_timestamp() >= c.started_at + make_interval(secs => (ln(c.cap_cents::numeric / 100) / c.growth_k)::double precision + 0.05)
            ORDER BY c.started_at FOR UPDATE LOOP
    v_after := public.fn_crash_decide(r, false, 'time');
    IF v_after.status <> 'open' THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $function$;
REVOKE ALL ON FUNCTION public.fn_crash_settle_decided(uuid) FROM PUBLIC, anon, authenticated;

-- ── 8. results as the player receives them ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_plinko_drop_result(d public.plinko_drops)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'game', 'plinko', 'drop_id', d.id, 'club_id', d.club_id, 'host_id', d.host_id,
    'table_version', d.table_version, 'bet_diamonds', d.bet_diamonds, 'bet_chips', d.bet_chips,
    'diamonds_per_chip', d.diamonds_per_chip,
    'outcome', jsonb_build_object(
      'slot', d.slot, 'path_bits', d.path_bits,
      'path', (SELECT jsonb_agg(((d.path_bits >> i) & 1) ORDER BY i) FROM generate_series(0, 15) i),
      'table_multiplier_cents', d.table_multiplier_cents, 'cap_multiplier_cents', d.cap_multiplier_cents,
      'multiplier_cents', d.multiplier_cents, 'capped', d.capped, 'payout_chips', d.payout_chips),
    'fairness', jsonb_build_object('commit_id', d.commit_id, 'server_seed_hash', d.server_seed_hash,
                                   'server_seed', d.server_seed, 'client_seed', d.client_seed,
                                   'nonce', d.nonce, 'hmac_hex', d.hmac_hex),
    'balances', jsonb_build_object('diamonds', d.diamonds_after, 'member_chips', d.member_chips_after),
    'pool', jsonb_build_object('chips_minted', d.pool_chips_minted_after, 'chips_paid', d.pool_chips_paid_after),
    'created_at', d.created_at);
$function$;
REVOKE ALL ON FUNCTION public.fn_plinko_drop_result(public.plinko_drops) FROM PUBLIC, anon, authenticated;

-- An open round reveals nothing that would give the crash point away.
CREATE OR REPLACE FUNCTION public.fn_crash_round_result(r public.crash_rounds)
RETURNS jsonb
LANGUAGE sql
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'game', 'crash', 'round_id', r.id, 'club_id', r.club_id, 'host_id', r.host_id,
    'status', r.status, 'bet_diamonds', r.bet_diamonds, 'bet_chips', r.bet_chips,
    'diamonds_per_chip', r.diamonds_per_chip,
    'cap_cents', r.cap_cents, 'growth_k', r.growth_k, 'auto_cashout_cents', r.auto_cashout_cents,
    'started_at', r.started_at, 'server_now', clock_timestamp(),
    'elapsed_ms', CASE WHEN r.status = 'open'
                       THEN floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint
                       ELSE r.elapsed_ms END,
    'multiplier_now_cents', CASE WHEN r.status = 'open'
                       THEN public.fn_crash_multiplier_cents(r.growth_k,
                              floor(extract(epoch FROM (clock_timestamp() - r.started_at)) * 1000)::bigint, r.cap_cents) END,
    'outcome', CASE WHEN r.status = 'open' THEN NULL ELSE jsonb_build_object(
      'status', r.status, 'cashout_cents', r.cashout_cents, 'crash_cents', r.crash_cents,
      'payout_chips', r.payout_chips, 'settled_by', r.settled_by, 'settled_at', r.settled_at) END,
    'fairness', jsonb_build_object('commit_id', r.commit_id, 'server_seed_hash', r.server_seed_hash,
                                   'client_seed', r.client_seed, 'nonce', r.nonce)
                || CASE WHEN r.status = 'open' THEN '{}'::jsonb
                        ELSE jsonb_build_object('server_seed', r.server_seed, 'roll', r.roll, 'crash_cents', r.crash_cents) END,
    'balances', jsonb_build_object('diamonds', r.diamonds_after, 'member_chips', r.member_chips_after),
    'pool', jsonb_build_object('chips_minted', r.pool_chips_minted_after, 'chips_paid', r.pool_chips_paid_after),
    'created_at', r.created_at);
$function$;
REVOKE ALL ON FUNCTION public.fn_crash_round_result(public.crash_rounds) FROM PUBLIC, anon, authenticated;

-- ── 9. what the player sees ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_state(p_club_id uuid, p_game text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bank numeric := 0;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  v_bets jsonb; v_tables jsonb; v_open jsonb;
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;

  -- Time settles what it has decided before anybody reads the headroom.
  IF p_game = 'crash' THEN
    PERFORM 1 FROM public.diamond_game_configs WHERE host_id = v_host AND game = 'crash' FOR UPDATE;
    PERFORM public.fn_crash_settle_decided(v_host);
    SELECT * INTO r FROM public.crash_rounds c WHERE c.host_id = v_host AND c.user_id = v_user AND c.status = 'open'
     ORDER BY c.started_at DESC LIMIT 1;
    IF r.id IS NOT NULL THEN
      v_open := public.fn_crash_round_result(r);
    END IF;
  END IF;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;

  IF v_kind = 'union' THEN
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host;
  END IF;
  v_bank := COALESCE(v_bank, 0);

  -- Every bet option with the cap the pool can promise on it right now.
  SELECT jsonb_agg(jsonb_build_object(
           'bet_diamonds', b, 'bet_chips', round(b::numeric / v_rate, 2),
           'cap_cents', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents),
           'playable', public.fn_diamond_game_cap_cents(cfg, pool, v_bank, b::numeric / v_rate, cfg.max_multiplier_cents) >= 101)
         ORDER BY b)
    INTO v_bets
    FROM unnest(cfg.bet_options) b
   WHERE b BETWEEN cfg.min_bet_diamonds AND cfg.max_bet_diamonds AND b % v_rate = 0;

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(jsonb_build_object(
             'version', t.version, 'name', t.name, 'rows', t.board_rows,
             'multipliers_cents', to_jsonb(t.multipliers_cents),
             'max_multiplier_cents', t.max_multiplier_cents,
             'spec_rtp', t.spec_rtp, 'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'note', t.note)
           ORDER BY t.version)
      INTO v_tables
      FROM public.plinko_tables t WHERE t.activated_at IS NOT NULL;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  IF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = v_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = v_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  END IF;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_rounds - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'diamonds_per_chip', v_rate, 'min_bet_diamonds', cfg.min_bet_diamonds, 'max_bet_diamonds', cfg.max_bet_diamonds,
      'exposure_allowance_chips', cfg.exposure_allowance_chips, 'cap_fraction', cfg.cap_fraction,
      'max_multiplier_cents', cfg.max_multiplier_cents, 'growth_k', cfg.growth_k,
      'purchased_only', cfg.purchased_only, 'max_rounds_per_player_per_day', cfg.max_rounds_per_player_per_day,
      'min_seconds_between_rounds', cfg.min_seconds_between_rounds, 'spec_rtp', 0.800000, 'house_share', 0.200000),
    'bets', COALESCE(v_bets, '[]'::jsonb),
    'tables', COALESCE(v_tables, '[]'::jsonb),
    'open_round', v_open,
    'pool', jsonb_build_object(
      'rounds', COALESCE(pool.rounds, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_minted', COALESCE(pool.chips_minted, 0), 'chips_paid', COALESCE(pool.chips_paid, 0),
      'reserved_chips', COALESCE(pool.reserved_chips, 0),
      'headroom_chips', COALESCE(pool.chips_minted, 0) + cfg.exposure_allowance_chips - COALESCE(pool.chips_paid, 0) - COALESCE(pool.reserved_chips, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round(COALESCE(pool.chips_paid, 0) / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'rounds_today', v_today, 'seconds_until_next', v_wait,
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_state(uuid, text) TO authenticated, service_role;

-- ── 10. the shared preamble: who, where, may they, can they pay ──────────────
-- Everything a round checks before money moves, in one place. Locks the config
-- row (one lock serialises every round on the host) and the host bank. Returns
-- an error jsonb, or NULL when the round may proceed with the OUT values set.
CREATE OR REPLACE FUNCTION public.fn_diamond_game_admit(
  p_game text, p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet integer,
  OUT err jsonb, OUT o_host uuid, OUT o_kind text, OUT o_cfg public.diamond_game_configs, OUT o_pool public.diamond_game_pools,
  OUT o_bank numeric, OUT o_rate integer, OUT o_bet_chips numeric, OUT o_mint numeric, OUT o_nonce bigint,
  OUT o_commit public.diamond_game_commits, OUT o_diamonds numeric, OUT o_fixture boolean)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_today integer; v_last timestamptz;
  v_purchased integer; v_spendable integer;
  v_label text := CASE p_game WHEN 'plinko' THEN 'Diamond Plinko' ELSE 'Diamond Crash' END;
BEGIN
  err := NULL;
  IF v_user IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'Sign In To Play'); RETURN;
  END IF;
  SELECT h.host_id, h.host_kind INTO o_host, o_kind FROM public.fn_wheel_host(p_club_id) h;
  IF o_host IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); RETURN;
  END IF;
  o_rate := public.fn_ca_bridge_rate();
  IF o_rate IS NULL OR o_rate <= 0 THEN
    err := jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set'); RETURN;
  END IF;
  IF length(COALESCE(p_client_seed, '')) < 1 THEN
    err := jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required'); RETURN;
  END IF;
  IF public.fn_platform_frozen() THEN
    err := jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Play Again In A Few Minutes'); RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = p_game AND f.cleared_at IS NULL) THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Paused'); RETURN;
  END IF;

  SELECT * INTO o_cfg FROM public.diamond_game_configs c WHERE c.host_id = o_host AND c.game = p_game FOR UPDATE;
  IF o_cfg.host_id IS NULL OR NOT o_cfg.enabled THEN
    err := jsonb_build_object('ok', false, 'error', v_label || ' Is Not Open Here'); RETURN;
  END IF;
  INSERT INTO public.diamond_game_pools (host_id, game) VALUES (o_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  IF p_game = 'crash' THEN
    PERFORM public.fn_crash_settle_decided(o_host);
  END IF;
  SELECT * INTO o_pool FROM public.diamond_game_pools p WHERE p.host_id = o_host AND p.game = p_game FOR UPDATE;

  IF p_bet IS NULL OR p_bet < o_cfg.min_bet_diamonds OR p_bet > o_cfg.max_bet_diamonds OR p_bet % o_rate <> 0 THEN
    err := jsonb_build_object('ok', false, 'error',
      format('Bets Are Whole Chips Between %s And %s Diamonds', o_cfg.min_bet_diamonds, o_cfg.max_bet_diamonds)); RETURN;
  END IF;
  o_bet_chips := round(p_bet::numeric / o_rate, 2);
  o_mint := round(o_bet_chips * 0.8, 2);

  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    err := jsonb_build_object('ok', false, 'error', 'Join The Club Before You Play'); RETURN;
  END IF;
  o_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF o_fixture AND NOT o_cfg.allow_fixture_accounts THEN
    err := jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Play This Game'); RETURN;
  END IF;
  SELECT * INTO o_commit FROM public.diamond_game_commits c
   WHERE c.id = p_commit_id AND c.user_id = v_user AND c.game = p_game AND c.consumed_by IS NULL FOR UPDATE;
  IF o_commit.id IS NULL THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Is Not Yours Or Was Already Used. Open The Game Again'); RETURN;
  END IF;
  IF o_commit.expires_at < now() THEN
    err := jsonb_build_object('ok', false, 'error', 'That Ticket Expired. Open The Game Again'); RETURN;
  END IF;

  IF p_game = 'plinko' THEN
    SELECT count(*)::integer, max(d.created_at) INTO v_today, v_last
      FROM public.plinko_drops d
     WHERE d.user_id = v_user AND d.host_id = o_host
       AND (d.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.plinko_drops d WHERE d.user_id = v_user;
  ELSE
    SELECT count(*)::integer, max(c.created_at) INTO v_today, v_last
      FROM public.crash_rounds c
     WHERE c.user_id = v_user AND c.host_id = o_host
       AND (c.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
    SELECT count(*) + 1 INTO o_nonce FROM public.crash_rounds c WHERE c.user_id = v_user;
  END IF;
  IF v_today >= o_cfg.max_rounds_per_player_per_day THEN
    err := jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Rounds', o_cfg.max_rounds_per_player_per_day)); RETURN;
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => o_cfg.min_seconds_between_rounds) THEN
    err := jsonb_build_object('ok', false, 'error', 'One Moment Between Rounds'); RETURN;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO o_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN o_cfg.purchased_only THEN LEAST(o_diamonds, v_purchased)::integer ELSE o_diamonds::integer END;
  IF v_spendable < p_bet THEN
    err := jsonb_build_object('ok', false,
      'error', CASE WHEN o_cfg.purchased_only AND o_diamonds >= p_bet
                    THEN 'This Game Takes Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For That Bet' END,
      'diamonds', o_diamonds, 'spendable', v_spendable, 'bet_diamonds', p_bet); RETURN;
  END IF;

  IF o_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (o_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.chip_balance, 0) INTO o_bank FROM public.union_wallets w WHERE w.union_id = o_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO o_bank FROM public.clubs c WHERE c.id = o_host FOR UPDATE;
  END IF;
  o_bank := COALESCE(o_bank, 0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_diamond_game_admit(text, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;

-- ── 11. THE DROP ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_plinko_drop(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_table_version integer, p_bet_diamonds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.plinko_drops;
  adm record;
  t public.plinko_tables%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_path integer := 0; v_slot integer := 0; i integer;
  v_cap integer; v_table_mult integer; v_mult integer; v_payout numeric;
  v_deduct jsonb; v_bank numeric; v_member_after numeric; v_bank_after numeric;
  v_dia_after numeric;
  pool public.diamond_game_pools%ROWTYPE;
  d public.plinko_drops;
BEGIN
  SELECT * INTO prior FROM public.plinko_drops WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id <> v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Drop Belongs To Another Player');
    END IF;
    RETURN public.fn_plinko_drop_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('plinko', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  SELECT * INTO t FROM public.plinko_tables WHERE version = p_table_version AND activated_at IS NOT NULL;
  IF t.version IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Plinko Table Is Not Active');
  END IF;

  -- ── the cap, before the ball drops ─────────────────────────────────────────
  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents));
  IF v_cap < 101 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;

  -- ── the roll: sixteen bits, one per row ────────────────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  FOR i IN 0..15 LOOP
    IF get_bit(v_hmac, i) = 1 THEN
      v_path := v_path | (1 << i);
      v_slot := v_slot + 1;
    END IF;
  END LOOP;
  v_table_mult := t.multipliers_cents[v_slot + 1];
  v_mult := LEAST(v_table_mult, v_cap);
  v_payout := round(adm.o_bet_chips * v_mult / 100, 2);

  -- ── 1. the bet is paid for ─────────────────────────────────────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'plinko_drop',
                format('Diamond Plinko Drop (%s Diamonds, %s)', p_bet_diamonds, t.name),
                'plinko:' || v_id::text,
                jsonb_build_object('drop_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host,
                                   'commit_id', p_commit_id, 'table_version', t.version));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. the host is paid its chip share ─────────────────────────────────────
  v_bank := COALESCE(public.fn_diamond_game_mint_leg(adm.o_host, adm.o_kind, adm.o_mint, 'plinko-mint:' || v_id::text), adm.o_bank);

  -- ── 3. the payout ──────────────────────────────────────────────────────────
  IF v_payout > 0 THEN
    IF v_bank < v_payout THEN
      RAISE EXCEPTION 'fn_plinko_drop: host bank % below the payout % after the cap passed', v_bank, v_payout;
    END IF;
    SELECT x.bank_after, x.member_after INTO v_bank_after, v_member_after
      FROM public.fn_diamond_game_prize_leg('plinko', adm.o_host, adm.o_kind, p_club_id, v_user, v_payout,
             'plinko-prize:' || v_id::text,
             format('Diamond Plinko: %s.%sx on %s', v_mult / 100, lpad((v_mult % 100)::text, 2, '0'), t.name),
             jsonb_build_object('drop_id', v_id, 'host_id', adm.o_host, 'host_kind', adm.o_kind,
                                'table_version', t.version, 'slot', v_slot, 'multiplier_cents', v_mult, 'capped', v_mult < v_table_mult)) x;
  ELSE
    SELECT COALESCE(cm.chip_balance, 0) INTO v_member_after FROM public.club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         chips_minted = chips_minted + adm.o_mint,
         chips_paid = chips_paid + v_payout,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < LEAST(t.max_multiplier_cents, (adm.o_cfg).max_multiplier_cents) THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'plinko'
   RETURNING * INTO pool;
  IF pool.chips_paid + pool.reserved_chips > pool.chips_minted + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_plinko_drop: chips_paid % would exceed chips_minted % + allowance % - the cap was bypassed',
      pool.chips_paid, pool.chips_minted, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.plinko_drops
    (id, host_id, host_kind, club_id, user_id, table_version, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, hmac_hex, path_bits, slot,
     table_multiplier_cents, cap_multiplier_cents, multiplier_cents, capped, payout_chips, chips_minted,
     pool_chips_minted_after, pool_chips_paid_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, t.version, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, encode(v_hmac, 'hex'), v_path, v_slot,
     v_table_mult, v_cap, v_mult, v_mult < v_table_mult, v_payout, adm.o_mint,
     pool.chips_minted, pool.chips_paid, v_dia_after, v_member_after, adm.o_fixture)
  RETURNING * INTO d;
  RETURN public.fn_plinko_drop_result(d);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_plinko_drop(uuid, uuid, text, integer, integer) TO authenticated, service_role;

-- ── 12. THE ROUND: start ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_crash_start(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_bet_diamonds integer, p_auto_cashout_cents integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  prior public.crash_rounds;
  adm record;
  v_id uuid := gen_random_uuid();
  v_hmac bytea; v_roll numeric; v_crash bigint; v_cap integer;
  v_reserve numeric; v_deduct jsonb; v_dia_after numeric; v_member_chips numeric;
  pool public.diamond_game_pools%ROWTYPE;
  r public.crash_rounds;
BEGIN
  SELECT * INTO prior FROM public.crash_rounds WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id <> v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Round Belongs To Another Player');
    END IF;
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO adm FROM public.fn_diamond_game_admit('crash', p_club_id, p_commit_id, p_client_seed, p_bet_diamonds);
  IF adm.err IS NOT NULL THEN RETURN adm.err; END IF;

  -- One open round per player per host: finish it first (a refresh resumes it).
  SELECT * INTO prior FROM public.crash_rounds c WHERE c.host_id = adm.o_host AND c.user_id = v_user AND c.status = 'open'
   ORDER BY c.started_at DESC LIMIT 1;
  IF prior.id IS NOT NULL THEN
    RETURN public.fn_crash_round_result(prior) || jsonb_build_object('resumed', true);
  END IF;

  v_cap := public.fn_diamond_game_cap_cents(adm.o_cfg, adm.o_pool, adm.o_bank, adm.o_bet_chips, (adm.o_cfg).max_multiplier_cents);
  IF v_cap < 101 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bank Cannot Cover A Win At That Bet Right Now. Try A Smaller Bet',
                              'cap_cents', v_cap);
  END IF;
  IF p_auto_cashout_cents IS NOT NULL AND (p_auto_cashout_cents < 101 OR p_auto_cashout_cents > v_cap) THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Auto Cash Out Must Be Between 1.01x And %s.%sx', v_cap / 100, lpad((v_cap % 100)::text, 2, '0')),
                              'cap_cents', v_cap);
  END IF;
  v_reserve := round(adm.o_bet_chips * v_cap / 100, 2);

  -- ── the roll: the crash point, sealed in the row ───────────────────────────
  v_hmac := extensions.hmac(convert_to(p_client_seed || ':' || adm.o_nonce::text, 'UTF8'),
                            convert_to((adm.o_commit).server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_crash := public.fn_crash_point_cents(v_roll);

  -- ── 1. the bet is paid for ─────────────────────────────────────────────────
  v_deduct := public.fn_diamond_game_take_bet(v_user, p_bet_diamonds, (adm.o_cfg).purchased_only, 'crash_bet',
                format('Diamond Crash Bet (%s Diamonds)', p_bet_diamonds),
                'crash:' || v_id::text,
                jsonb_build_object('round_id', v_id, 'club_id', p_club_id, 'host_id', adm.o_host, 'commit_id', p_commit_id));
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For That Bet', 'detail', v_deduct->>'error');
  END IF;

  -- ── 2. the host is paid its chip share, the payout is reserved ─────────────
  PERFORM public.fn_diamond_game_mint_leg(adm.o_host, adm.o_kind, adm.o_mint, 'crash-mint:' || v_id::text);
  UPDATE public.diamond_game_pools
     SET rounds = rounds + 1,
         intake_diamonds = intake_diamonds + p_bet_diamonds,
         chips_minted = chips_minted + adm.o_mint,
         reserved_chips = reserved_chips + v_reserve,
         constrained_rounds = constrained_rounds + CASE WHEN v_cap < (adm.o_cfg).max_multiplier_cents THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = adm.o_host AND game = 'crash'
   RETURNING * INTO pool;
  IF pool.chips_paid + pool.reserved_chips > pool.chips_minted + (adm.o_cfg).exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_crash_start: reserved % + paid % would exceed chips_minted % + allowance % - the cap was bypassed',
      pool.reserved_chips, pool.chips_paid, pool.chips_minted, (adm.o_cfg).exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  SELECT COALESCE(cm.chip_balance, 0) INTO v_member_chips FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user LIMIT 1;
  UPDATE public.diamond_game_commits SET consumed_by = v_id WHERE id = p_commit_id;

  INSERT INTO public.crash_rounds
    (id, host_id, host_kind, club_id, user_id, bet_diamonds, bet_chips, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, crash_cents, cap_cents, growth_k,
     auto_cashout_cents, reserved_chips, chips_minted, diamonds_after, member_chips_after, is_fixture, started_at)
  VALUES
    (v_id, adm.o_host, adm.o_kind, p_club_id, v_user, p_bet_diamonds, adm.o_bet_chips, adm.o_rate,
     p_commit_id, (adm.o_commit).server_seed_hash, (adm.o_commit).server_seed, p_client_seed, adm.o_nonce, v_roll, v_crash, v_cap, (adm.o_cfg).growth_k,
     p_auto_cashout_cents, v_reserve, adm.o_mint, v_dia_after, v_member_chips, adm.o_fixture, clock_timestamp())
  RETURNING * INTO r;
  RETURN public.fn_crash_round_result(r);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_crash_start(uuid, uuid, text, integer, integer) TO authenticated, service_role;

-- ── 13. THE ROUND: tick and cash out ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_crash_settle(p_round_id uuid, p_cashout boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  r public.crash_rounds;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Play');
  END IF;
  SELECT * INTO r FROM public.crash_rounds WHERE id = p_round_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Round Could Not Be Found');
  END IF;
  IF r.user_id <> v_user AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Round Belongs To Another Player');
  END IF;
  IF r.status <> 'open' THEN
    RETURN public.fn_crash_round_result(r);
  END IF;
  IF public.fn_platform_frozen() THEN
    -- The clock is frozen with the platform: the round waits, nothing is decided.
    RETURN public.fn_crash_round_result(r) || jsonb_build_object('frozen', true);
  END IF;
  -- The host lock serialises settlement with new rounds on the same pool.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id = r.host_id AND game = 'crash' FOR UPDATE;
  SELECT * INTO r FROM public.crash_rounds WHERE id = p_round_id FOR UPDATE;
  r := public.fn_crash_decide(r, COALESCE(p_cashout, false), CASE WHEN COALESCE(p_cashout, false) THEN 'player' ELSE 'tick' END);
  RETURN public.fn_crash_round_result(r);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_crash_settle(uuid, boolean) TO authenticated, service_role;

-- ── 14. history ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_history(p_club_id uuid, p_game text, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_host uuid; v_out jsonb;
BEGIN
  SELECT h.host_id INTO v_host FROM public.fn_wheel_host(p_club_id) h;
  IF p_game = 'plinko' THEN
    SELECT COALESCE(jsonb_agg(public.fn_plinko_drop_result(d) ORDER BY d.created_at DESC), '[]'::jsonb) INTO v_out
      FROM (SELECT * FROM public.plinko_drops x WHERE x.user_id = auth.uid() AND x.host_id = v_host
             ORDER BY x.created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) d;
  ELSIF p_game = 'crash' THEN
    SELECT COALESCE(jsonb_agg(public.fn_crash_round_result(c) ORDER BY c.created_at DESC), '[]'::jsonb) INTO v_out
      FROM (SELECT * FROM public.crash_rounds x WHERE x.user_id = auth.uid() AND x.host_id = v_host AND x.status <> 'open'
             ORDER BY x.created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) c;
  ELSE
    v_out := '[]'::jsonb;
  END IF;
  RETURN v_out;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_history(uuid, text, integer) TO authenticated, service_role;

-- ── 15. the operator's controls ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_set_config(p_club_id uuid, p_game text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_bad integer;
BEGIN
  IF v_user IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Change This Game');
  END IF;

  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game FOR UPDATE;
  IF cfg.host_id IS NULL THEN
    INSERT INTO public.diamond_game_configs (host_id, game, host_kind, updated_by)
    VALUES (v_host, p_game, v_kind, v_user) RETURNING * INTO cfg;
    INSERT INTO public.diamond_game_pools (host_id, game) VALUES (v_host, p_game) ON CONFLICT (host_id, game) DO NOTHING;
  END IF;

  IF p_patch ? 'min_bet_diamonds' THEN cfg.min_bet_diamonds := (p_patch->>'min_bet_diamonds')::integer; END IF;
  IF p_patch ? 'max_bet_diamonds' THEN cfg.max_bet_diamonds := (p_patch->>'max_bet_diamonds')::integer; END IF;
  IF p_patch ? 'bet_options' THEN
    SELECT array_agg(x::integer ORDER BY x::integer) INTO cfg.bet_options FROM jsonb_array_elements_text(p_patch->'bet_options') x;
  END IF;
  IF p_patch ? 'exposure_allowance_chips' THEN cfg.exposure_allowance_chips := round((p_patch->>'exposure_allowance_chips')::numeric, 2); END IF;
  IF p_patch ? 'cap_fraction' THEN cfg.cap_fraction := round((p_patch->>'cap_fraction')::numeric, 3); END IF;
  IF p_patch ? 'max_multiplier_cents' THEN cfg.max_multiplier_cents := (p_patch->>'max_multiplier_cents')::integer; END IF;
  IF p_patch ? 'growth_k' THEN cfg.growth_k := round((p_patch->>'growth_k')::numeric, 4); END IF;
  IF p_patch ? 'purchased_only' THEN cfg.purchased_only := (p_patch->>'purchased_only')::boolean; END IF;
  IF p_patch ? 'allow_fixture_accounts' THEN cfg.allow_fixture_accounts := (p_patch->>'allow_fixture_accounts')::boolean; END IF;
  IF p_patch ? 'max_rounds_per_player_per_day' THEN cfg.max_rounds_per_player_per_day := (p_patch->>'max_rounds_per_player_per_day')::integer; END IF;
  IF p_patch ? 'min_seconds_between_rounds' THEN cfg.min_seconds_between_rounds := (p_patch->>'min_seconds_between_rounds')::integer; END IF;
  IF p_patch ? 'enabled' THEN cfg.enabled := (p_patch->>'enabled')::boolean; END IF;

  IF cfg.bet_options IS NULL OR array_length(cfg.bet_options, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'At Least One Bet Size Is Required');
  END IF;
  SELECT count(*) INTO v_bad FROM unnest(cfg.bet_options) b
   WHERE b % v_rate <> 0 OR b < cfg.min_bet_diamonds OR b > cfg.max_bet_diamonds;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Every Bet Size Must Be A Whole Number Of Chips (%s Diamonds Each) Inside The Limits', v_rate));
  END IF;
  IF cfg.enabled AND p_game = 'plinko' AND NOT EXISTS (
       SELECT 1 FROM public.plinko_tables t, public.fn_plinko_table_audit(t.version) a
        WHERE t.activated_at IS NOT NULL AND a.spec_rtp = 0.800000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Plinko Table Audits To 80 Percent. The Game Cannot Be Enabled');
  END IF;

  UPDATE public.diamond_game_configs
     SET enabled = cfg.enabled, min_bet_diamonds = cfg.min_bet_diamonds, max_bet_diamonds = cfg.max_bet_diamonds,
         bet_options = cfg.bet_options, exposure_allowance_chips = cfg.exposure_allowance_chips,
         cap_fraction = cfg.cap_fraction, max_multiplier_cents = cfg.max_multiplier_cents, growth_k = cfg.growth_k,
         purchased_only = cfg.purchased_only, allow_fixture_accounts = cfg.allow_fixture_accounts,
         max_rounds_per_player_per_day = cfg.max_rounds_per_player_per_day,
         min_seconds_between_rounds = cfg.min_seconds_between_rounds,
         updated_at = now(), updated_by = v_user
   WHERE host_id = v_host AND game = p_game
   RETURNING * INTO cfg;
  RETURN jsonb_build_object('ok', true, 'config', to_jsonb(cfg));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_set_config(uuid, text, jsonb) TO authenticated, service_role;

-- ── 16. the house side ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_diamond_game_metrics(p_club_id uuid, p_game text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.diamond_game_configs%ROWTYPE;
  pool public.diamond_game_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_windows jsonb; v_bank numeric; v_open integer := 0;
  v_invariant_ok boolean;
BEGIN
  IF p_game NOT IN ('plinko', 'crash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Game Does Not Exist');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read These Metrics');
  END IF;
  SELECT * INTO cfg FROM public.diamond_game_configs WHERE host_id = v_host AND game = p_game;
  SELECT * INTO pool FROM public.diamond_game_pools WHERE host_id = v_host AND game = p_game;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  IF v_kind = 'union' THEN
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host;
  END IF;

  IF p_game = 'plinko' THEN
    SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
      FROM (
        SELECT jsonb_build_object(
                 'window', lbl, 'rounds', n,
                 'intake_chips', round(intake, 2), 'paid_chips', round(paid, 2),
                 'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
                 'z', CASE WHEN n >= 30 AND var > 0 THEN round((paid - 0.80 * intake) / sqrt(var), 2) END,
                 'constrained', constrained,
                 'drift', CASE WHEN n >= 2000 AND var > 0 THEN abs((paid - 0.80 * intake) / sqrt(var)) >= 4 ELSE false END) AS w
          FROM (
            SELECT lbl, count(d.id) AS n,
                   COALESCE(SUM(d.bet_chips), 0) AS intake,
                   COALESCE(SUM(d.payout_chips), 0) AS paid,
                   COALESCE(SUM(power(d.bet_chips * COALESCE(t.sd_chips, 0), 2)), 0) AS var,
                   COALESCE(SUM(CASE WHEN d.capped THEN 1 ELSE 0 END), 0) AS constrained
              FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
              LEFT JOIN public.plinko_drops d ON d.host_id = v_host AND NOT d.is_fixture AND d.created_at >= now() - win.span
              LEFT JOIN public.plinko_tables t ON t.version = d.table_version
             GROUP BY lbl) x) y;
  ELSE
    SELECT count(*) INTO v_open FROM public.crash_rounds c WHERE c.host_id = v_host AND c.status = 'open';
    SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
      FROM (
        SELECT jsonb_build_object(
                 'window', lbl, 'rounds', n,
                 'intake_chips', round(intake, 2), 'paid_chips', round(paid, 2),
                 'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
                 'z', CASE WHEN n >= 30 AND var > 0 THEN round((paid - 0.80 * intake) / sqrt(var), 2) END,
                 'constrained', constrained,
                 'instant_crashes', instant,
                 'drift', CASE WHEN n >= 2000 AND var > 0 THEN abs((paid - 0.80 * intake) / sqrt(var)) >= 4 ELSE false END) AS w
          FROM (
            -- Variance per round at the target the player actually took: a
            -- payout of bet*x with probability 0.8/x has variance
            -- bet^2 * (0.8 x - 0.64). A crashed round's target is unknown; it
            -- is scored at its own crash point, the most it could have asked.
            SELECT lbl, count(c.id) AS n,
                   COALESCE(SUM(c.bet_chips), 0) AS intake,
                   COALESCE(SUM(c.payout_chips), 0) AS paid,
                   COALESCE(SUM(power(c.bet_chips, 2) * (0.8 * LEAST(COALESCE(c.cashout_cents, c.crash_cents), c.cap_cents)::numeric / 100 - 0.64)), 0) AS var,
                   COALESCE(SUM(CASE WHEN c.cap_cents < cfg.max_multiplier_cents THEN 1 ELSE 0 END), 0) AS constrained,
                   COALESCE(SUM(CASE WHEN c.crash_cents = 100 THEN 1 ELSE 0 END), 0) AS instant
              FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
              LEFT JOIN public.crash_rounds c ON c.host_id = v_host AND NOT c.is_fixture AND c.status <> 'open' AND c.created_at >= now() - win.span
             GROUP BY lbl) x) y;
  END IF;

  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid + pool.reserved_chips <= pool.chips_minted + cfg.exposure_allowance_chips);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => p_game || '_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => p_game || ':invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid + pool.reserved_chips - pool.chips_minted - cfg.exposure_allowance_chips,
        p_expected => pool.chips_minted + cfg.exposure_allowance_chips, p_actual => pool.chips_paid + pool.reserved_chips,
        p_layer => 'settlement', p_entity_type => 'diamond_game_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond ' || p_game || ' paid or reserved more than it minted plus the allowance; the per-round cap was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'configured', true, 'game', p_game, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'bank_chips', COALESCE(v_bank, 0),
    'open_rounds', v_open,
    'exposure_chips', COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - COALESCE(pool.chips_minted, 0),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) + COALESCE(pool.reserved_chips, 0) - COALESCE(pool.chips_minted, 0)),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round(pool.chips_paid / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_minted, 2) END,
    'constrained_rate', CASE WHEN COALESCE(pool.rounds, 0) > 0 THEN round(pool.constrained_rounds::numeric / pool.rounds, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'tables', CASE WHEN p_game = 'plinko' THEN
        (SELECT jsonb_agg(jsonb_build_object('version', t.version, 'name', t.name, 'spec_rtp', t.spec_rtp,
                                             'sd_chips', t.sd_chips, 'hit_rate', t.hit_rate, 'max_multiplier_cents', t.max_multiplier_cents,
                                             'activated_at', t.activated_at) ORDER BY t.version)
           FROM public.plinko_tables t) END);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_metrics(uuid, text) TO authenticated, service_role;

-- ── 17. doors, locks, the registry ───────────────────────────────────────────
REVOKE ALL ON TABLE public.diamond_game_configs, public.diamond_game_config_history, public.diamond_game_pools,
               public.diamond_game_commits, public.plinko_tables, public.plinko_drops, public.crash_rounds
  FROM PUBLIC, anon, authenticated;
ALTER TABLE public.diamond_game_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_game_config_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_game_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_game_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plinko_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plinko_drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crash_rounds ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_plinko_drop', 'approved', 'Diamond Plinko (20260908010241): takes a diamond bet through deduct_diamonds, mints 0.80 of it to the host bank through the issuance door, pays min(table, cap) from the host bank into the member wallet. Cap = 0.95 x pool headroom per chip bet. Invariant chips_paid <= chips_minted + allowance.'),
  ('fn_crash_start', 'approved', 'Diamond Crash (20260908010241): takes a diamond bet, mints 0.80 of it to the host bank, seals the crash point and reserves bet x cap in the pool until the round settles.'),
  ('fn_crash_settle', 'approved', 'Diamond Crash (20260908010241): decides an open round from the server clock (auto target, cap, crash, or a manual cash-out) and pays the host bank into the member wallet. Also runs by time from every other entry on the host once the curve is past the cap.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ── 18. the hosts open, at the plan's settings ───────────────────────────────
-- Same two hosts as the wheel (20260908004858), both games, purchased-only.
INSERT INTO public.diamond_game_configs (host_id, game, host_kind, enabled, updated_by)
SELECT h.host_id, g.game, h.host_kind, true, NULL
  FROM (SELECT DISTINCT COALESCE(c.union_id, c.id) AS host_id,
               CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END AS host_kind
          FROM public.clubs c
         WHERE COALESCE(c.status, 'active') NOT IN ('deleted', 'archived', 'disbanded')) h
  CROSS JOIN (VALUES ('plinko'), ('crash')) AS g(game)
 WHERE NOT EXISTS (SELECT 1 FROM public.diamond_game_configs w WHERE w.host_id = h.host_id AND w.game = g.game);
INSERT INTO public.diamond_game_pools (host_id, game)
SELECT w.host_id, w.game FROM public.diamond_game_configs w
 WHERE NOT EXISTS (SELECT 1 FROM public.diamond_game_pools p WHERE p.host_id = w.host_id AND p.game = w.game);

-- ── post-apply assertions ────────────────────────────────────────────────────
DO $$
DECLARE v_n integer; v_rtp numeric; v_x bigint; v_m integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.plinko_tables WHERE activated_at IS NOT NULL AND spec_rtp = 0.800000;
  IF v_n <> 3 THEN RAISE EXCEPTION 'POST-APPLY: expected 3 activated plinko tables at 0.800000, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.diamond_game_configs WHERE enabled;
  IF v_n < 4 THEN RAISE EXCEPTION 'POST-APPLY: expected both games on both hosts, found %', v_n; END IF;
  -- The crash point: the vector the browser test pins (roll 111921121211850).
  v_x := public.fn_crash_point_cents(111921121211850);
  IF v_x <> 201 THEN RAISE EXCEPTION 'POST-APPLY: crash point for the pinned roll is %, expected 201', v_x; END IF;
  IF public.fn_crash_point_cents(281474976710655) <> 100 THEN RAISE EXCEPTION 'POST-APPLY: the largest roll must crash at 1.00'; END IF;
  IF public.fn_crash_point_cents(0) <> 22517998136852480 THEN RAISE EXCEPTION 'POST-APPLY: roll 0 must give 80 * 2^48 cents'; END IF;
  v_m := public.fn_crash_multiplier_cents(0.12, 5776, 100000);
  IF v_m NOT BETWEEN 199 AND 200 THEN RAISE EXCEPTION 'POST-APPLY: the curve should read about 2.00x at 5.776s, read %', v_m; END IF;
  IF public.fn_crash_multiplier_cents(0.12, 600000, 100000) <> 100000 THEN RAISE EXCEPTION 'POST-APPLY: the curve must clamp at the cap'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname IN ('fn_plinko_drop', 'fn_crash_start', 'fn_crash_settle')) THEN
    RAISE EXCEPTION 'POST-APPLY: registry rows missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ca_payout_freeze'::regclass
                   AND conname = 'ca_payout_freeze_scope_check' AND pg_get_constraintdef(oid) LIKE '%''crash''%') THEN
    RAISE EXCEPTION 'POST-APPLY: ca_payout_freeze scope check lacks crash';
  END IF;
END $$;

COMMIT;
