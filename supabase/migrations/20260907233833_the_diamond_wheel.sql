-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260907233833; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260907233833   (the stamp IS the apply time, UTC: 2026-09-07 23:38:33)
--   name        the_diamond_wheel
--   created_by  (not recorded)
--   statements  1 statement(s), 61532 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260907233833 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     TRIGGER        trg_wheel_spins_append_only, trg_wheel_config_history_append_only, trg_wheel_config_history
--     FUNCTION       public.fn_wheel_append_only, public.fn_wheel_config_history, public.fn_wheel_segments_audit, public.fn_wheel_host, public.fn_wheel_can_operate, public.fn_wheel_commit, public.fn_wheel_purchased_available, public.fn_wheel_state
--     TABLE          public.wheel_segment_versions, public.wheel_segments, public.wheel_configs, public.wheel_config_history, public.wheel_pools, public.wheel_seed_commits, public.wheel_spins
--     INDEX          wheel_seed_commits_user_open_idx, wheel_spins_user_time_idx, wheel_spins_host_time_idx
--     DROP           TRIGGER trg_wheel_spins_append_only, TRIGGER trg_wheel_config_history_append_only, TRIGGER trg_wheel_config_history
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

-- 20260907233833_the_diamond_wheel.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE DIAMOND WHEEL (Dan, 2026-09-07). A paid prize wheel inside Club Arena: a
-- player spends diamonds on a spin and the wheel pays chips, diamonds, or
-- nothing, at exactly 80 percent return to player and a 20 percent house edge,
-- with a hard rule that the wheel can never pay out more than it takes in.
-- Rates are Dan's ruling of the same day: 1 diamond = $0.01, 1 chip = $1.00,
-- read from ca_bridge_rate (the previous migration), never typed here.
--
-- HOW ONE SPIN MOVES MONEY, in one transaction, under one row lock:
--
--   1. The player's diamonds leave through deduct_diamonds - the sanctioned
--      debit - journaled as type 'wheel_spin' with reference 'wheel:<spin>' (the
--      journal's UNIQUE index is the idempotency), class spend, counterparty
--      revenue:wheel_spin. The register retires them, as it retires every
--      spend. When the host runs purchased-only (the default), the spend is
--      taken FIFO from the player's purchase lots and refused past them: a
--      promotional diamond cannot become a chip here (Diamond Standard D5,
--      decision 4 of the wheel plan).
--   2. The chip share of the spin (the expected chip payout of the active
--      segment table, 0.743 chips on a 100-diamond spin under version 1) is
--      MINTED into the host's bank - the union bank for a union club, the club
--      treasury for a standalone club - declared 'mint' from issuance_reserve
--      with key 'wheel-mint:<spin>'. The issuance trigger on chip_ledger
--      registers it in ca_mint_ledger and holds it to ca_mint_policy, exactly
--      as the owner bridge is registered. The host is the issuer of record and
--      is paid its share whether the spin wins or loses; fractions below a
--      cent carry to the next spin (mint_carry), so nothing rounds away.
--   3. The diamond share (0.057 of the spin, the two diamond tiers) accrues to
--      a diamond float on the pool row. It is a memo of retired diamonds the
--      house has set aside for diamond prizes; a diamond prize is minted to
--      the winner through add_diamonds_to_balance under reference
--      'wheel:<spin>:prize', engine 'wheel', budgeted (DR7), and the float is
--      drawn down by the same amount. A diamond tier is in the draw only when
--      the float covers it.
--   4. The remaining 20 percent is the house: retired diamonds, revenue
--      recognised at consumption (Diamond Standard D1), held nowhere.
--   5. The draw. A tier is ELIGIBLE only if the host can pay it now: a chip
--      tier needs (chips_paid + prize) <= (chips_minted + this spin's mint +
--      the host's exposure allowance) AND the host bank to hold the prize; a
--      diamond tier needs the diamond float to cover it. Locked tiers are
--      returned to the player with the figure that unlocks them. The roll is
--      HMAC-SHA256(server_seed, client_seed || ':' || nonce), the first six
--      bytes over 2^48, mapped onto the eligible weights - the same mapping
--      fn_spin_draw_multiplier uses, with the server seed committed by hash
--      before the player pressed Spin (fn_wheel_commit) and revealed after, so
--      anyone can recompute it.
--   6. A chip prize moves host bank -> club_members.chip_balance in ONE journal
--      row, category 'wheel_prize', counterparty union_bank / club_treasury,
--      the host side autoskipped because union_wallet_transactions (or the
--      chip_transactions receipt) records it - the shape of
--      fn_union_send_to_member_zd3core.
--
-- THE GUARANTEE. Payouts come only from the host bank and only within
-- (chips_minted + allowance); chips_minted is 0.743 of intake by construction;
-- diamond prizes come only from a float that accrues 0.057 of intake. So
-- cumulative value paid <= 0.80 x cumulative intake + allowance, by
-- arithmetic, whatever the RNG does. fn_wheel_metrics re-derives the
-- inequality from the counters and files a CRITICAL drift incident if it ever
-- fails, which the arithmetic says it cannot: the alarm is for a bypass.
--
-- WHO MAY CALL WHAT. fn_wheel_commit, fn_wheel_spin, fn_wheel_state and
-- fn_wheel_history are the player's, behind the host's enabled flag, and every
-- one reads auth.uid(). fn_wheel_set_config is the host owner's (union owner,
-- co-owner or admin via fn_union_can_manage_wallets; club owner, co_owner or
-- admin for a standalone club) or platform management's. fn_wheel_activate_
-- segments is management only: a segment version may be activated only when
-- its weights sum to 100,000 and its return is exactly 0.800000. The tables are
-- closed to the browser; the RPCs are the only doors.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── tables ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wheel_segment_versions (
  version              integer PRIMARY KEY CHECK (version > 0),
  note                 text NOT NULL CHECK (length(btrim(note)) >= 10),
  spin_price_diamonds  integer NOT NULL CHECK (spin_price_diamonds > 0),
  spec_rtp             numeric(8,6),
  chip_share           numeric(8,6),
  diamond_share        numeric(8,6),
  house_share          numeric(8,6),
  sd_chips             numeric(14,6),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  activated_at         timestamptz
);
COMMENT ON TABLE public.wheel_segment_versions IS
  'Diamond Wheel prize tables, versioned. A version is activatable only when fn_wheel_segments_audit says weights = 100000 and spec_rtp = 0.800000. Every spin records the version it was drawn under.';

CREATE TABLE IF NOT EXISTS public.wheel_segments (
  version  integer NOT NULL REFERENCES public.wheel_segment_versions(version) ON DELETE RESTRICT,
  ord      smallint NOT NULL CHECK (ord > 0),
  label    text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('nothing', 'chips', 'diamonds')),
  amount   numeric(14,2) NOT NULL CHECK (amount >= 0 AND amount = round(amount, 2)),
  weight   integer NOT NULL CHECK (weight > 0),
  PRIMARY KEY (version, ord),
  CHECK ((kind = 'nothing') = (amount = 0)),
  CHECK (kind <> 'diamonds' OR amount = round(amount, 0))
);
COMMENT ON TABLE public.wheel_segments IS
  'Segments of a Diamond Wheel prize table version. amount is chips for kind chips, whole diamonds for kind diamonds, 0 for nothing. weight is out of the version total (100000).';

CREATE TABLE IF NOT EXISTS public.wheel_configs (
  host_id                       uuid PRIMARY KEY,
  host_kind                     text NOT NULL CHECK (host_kind IN ('union', 'club')),
  enabled                       boolean NOT NULL DEFAULT false,
  spin_price_diamonds           integer NOT NULL DEFAULT 100 CHECK (spin_price_diamonds > 0),
  segment_version               integer NOT NULL REFERENCES public.wheel_segment_versions(version),
  exposure_allowance_chips      numeric(14,2) NOT NULL DEFAULT 500 CHECK (exposure_allowance_chips >= 0),
  purchased_only                boolean NOT NULL DEFAULT true,
  allow_fixture_accounts        boolean NOT NULL DEFAULT false,
  max_spins_per_player_per_day  integer NOT NULL DEFAULT 200 CHECK (max_spins_per_player_per_day > 0),
  min_seconds_between_spins     integer NOT NULL DEFAULT 3 CHECK (min_seconds_between_spins >= 0),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid
);
COMMENT ON TABLE public.wheel_configs IS
  'One Diamond Wheel per host (a union, or a standalone club). exposure_allowance_chips is the working capital the host accepts as its maximum exposure: cumulative chips paid may exceed cumulative chips minted by at most this much. purchased_only limits spins to purchased diamond lots (Diamond Standard D5).';

CREATE TABLE IF NOT EXISTS public.wheel_config_history (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  host_id     uuid NOT NULL,
  changed_by  uuid,
  db_role     text NOT NULL DEFAULT current_user,
  before      jsonb,
  after       jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.wheel_pools (
  host_id             uuid PRIMARY KEY REFERENCES public.wheel_configs(host_id) ON DELETE RESTRICT,
  spins               bigint NOT NULL DEFAULT 0,
  intake_diamonds     numeric(18,0) NOT NULL DEFAULT 0,
  chips_minted        numeric(16,2) NOT NULL DEFAULT 0,
  mint_carry          numeric(10,6) NOT NULL DEFAULT 0 CHECK (mint_carry >= 0 AND mint_carry < 0.01),
  chips_paid          numeric(16,2) NOT NULL DEFAULT 0,
  diamond_float       numeric(16,4) NOT NULL DEFAULT 0 CHECK (diamond_float >= 0),
  diamonds_paid       numeric(18,0) NOT NULL DEFAULT 0,
  constrained_spins   bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.wheel_pools IS
  'Diamond Wheel economics per host. Invariant, checked on every spin and by fn_wheel_metrics: chips_paid <= chips_minted + exposure_allowance_chips, and diamond_float >= 0. chips_minted is the chip share of intake; diamond_float is the diamond share less diamond prizes; the rest is the house.';

CREATE TABLE IF NOT EXISTS public.wheel_seed_commits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  server_seed       text NOT NULL,
  server_seed_hash  text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_by       uuid
);
CREATE INDEX IF NOT EXISTS wheel_seed_commits_user_open_idx
  ON public.wheel_seed_commits (user_id) WHERE consumed_by IS NULL;

CREATE TABLE IF NOT EXISTS public.wheel_spins (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id                   uuid NOT NULL,
  host_kind                 text NOT NULL,
  club_id                   uuid NOT NULL,
  user_id                   uuid NOT NULL,
  segment_version           integer NOT NULL,
  spin_price_diamonds       integer NOT NULL,
  multiplier                integer NOT NULL,
  diamonds_per_chip         integer NOT NULL,
  commit_id                 uuid NOT NULL UNIQUE,
  server_seed_hash          text NOT NULL,
  server_seed               text NOT NULL,
  client_seed               text NOT NULL,
  nonce                     bigint NOT NULL,
  roll                      numeric(20,0) NOT NULL,
  weight_total              integer NOT NULL,
  eligible_ords             smallint[] NOT NULL,
  locked                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome_ord               smallint NOT NULL,
  outcome_kind              text NOT NULL,
  outcome_amount            numeric(14,2) NOT NULL,
  prize_value_chips         numeric(14,4) NOT NULL,
  chips_minted              numeric(14,2) NOT NULL,
  diamond_accrual           numeric(14,4) NOT NULL,
  pool_chips_minted_after   numeric(16,2) NOT NULL,
  pool_chips_paid_after     numeric(16,2) NOT NULL,
  pool_diamond_float_after  numeric(16,4) NOT NULL,
  diamonds_after            numeric NOT NULL,
  member_chips_after        numeric(14,2),
  is_fixture                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wheel_spins_user_time_idx ON public.wheel_spins (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wheel_spins_host_time_idx ON public.wheel_spins (host_id, created_at DESC);
COMMENT ON TABLE public.wheel_spins IS
  'Every Diamond Wheel spin: the committed and revealed seeds, the roll, which tiers were eligible, the outcome, and the pool counters after. Append-only. What the fairness view, the player history and the audit all read.';

CREATE OR REPLACE FUNCTION public.fn_wheel_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only: a spin is a fact and is never edited or deleted', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_wheel_spins_append_only ON public.wheel_spins;
CREATE TRIGGER trg_wheel_spins_append_only
  BEFORE UPDATE OR DELETE ON public.wheel_spins
  FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_append_only();
DROP TRIGGER IF EXISTS trg_wheel_config_history_append_only ON public.wheel_config_history;
CREATE TRIGGER trg_wheel_config_history_append_only
  BEFORE UPDATE OR DELETE ON public.wheel_config_history
  FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_append_only();

CREATE OR REPLACE FUNCTION public.fn_wheel_config_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.wheel_config_history (host_id, changed_by, before, after)
  VALUES (NEW.host_id, COALESCE(NEW.updated_by, auth.uid()),
          CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_config_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_wheel_config_history ON public.wheel_configs;
CREATE TRIGGER trg_wheel_config_history
  AFTER INSERT OR UPDATE ON public.wheel_configs
  FOR EACH ROW EXECUTE FUNCTION public.fn_wheel_config_history();

-- ── the prize table, version 1 ───────────────────────────────────────────────
-- Weights out of 100,000 on a 100-diamond spin. Values in the plan's dollars:
-- a chip is $1.00, a diamond $0.01. Expected value exactly $0.80.
INSERT INTO public.wheel_segment_versions (version, note, spin_price_diamonds, created_by)
VALUES (1, 'Launch table (game plan rev 2, 2026-09-07): 76.5 percent hit rate, break-even tier 1 in 6, top prize 50 chips at 1 in 667, two diamond tiers, expected value exactly 0.80 of the spin.', 100, NULL)
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.wheel_segments (version, ord, label, kind, amount, weight) VALUES
  (1,  1, 'Nothing',        'nothing',  0,     23470),
  (1,  2, '0.20 Chips',     'chips',    0.20,  24000),
  (1,  3, '0.50 Chips',     'chips',    0.50,  18000),
  (1,  4, '1 Chip',         'chips',    1.00,  16000),
  (1,  5, '50 Diamonds',    'diamonds', 50,     6000),
  (1,  6, '2 Chips',        'chips',    2.00,   5000),
  (1,  7, '25 Diamonds',    'diamonds', 25,     3000),
  (1,  8, '5 Chips',        'chips',    5.00,   3000),
  (1,  9, '20 Chips',       'chips',    20.00,   600),
  (1, 10, '250 Diamonds',   'diamonds', 250,     780),
  (1, 11, '50 Chips',       'chips',    50.00,   150)
ON CONFLICT (version, ord) DO NOTHING;

-- ── audit of a prize table: weights, shares, return, standard deviation ──────
CREATE OR REPLACE FUNCTION public.fn_wheel_segments_audit(p_version integer)
RETURNS TABLE (weight_total bigint, spec_rtp numeric, chip_share numeric, diamond_share numeric,
               house_share numeric, sd_chips numeric, hit_rate numeric, segments integer)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer;
  v_intake numeric;
BEGIN
  SELECT v.spin_price_diamonds INTO v_price FROM public.wheel_segment_versions v WHERE v.version = p_version;
  IF v_price IS NULL OR v_rate IS NULL THEN RETURN; END IF;
  v_intake := v_price::numeric / v_rate;   -- the spin in chips
  RETURN QUERY
  WITH s AS (
    SELECT g.weight,
           CASE g.kind WHEN 'chips' THEN g.amount WHEN 'diamonds' THEN g.amount / v_rate ELSE 0 END AS value_chips,
           g.kind
      FROM public.wheel_segments g WHERE g.version = p_version
  ), t AS (
    SELECT SUM(weight)::bigint AS w,
           SUM(value_chips * weight) / NULLIF(SUM(weight), 0) AS ev,
           SUM(CASE WHEN kind = 'chips' THEN value_chips * weight ELSE 0 END) / NULLIF(SUM(weight), 0) AS ev_chips,
           SUM(CASE WHEN kind = 'diamonds' THEN value_chips * weight ELSE 0 END) / NULLIF(SUM(weight), 0) AS ev_dia,
           SUM(CASE WHEN kind <> 'nothing' THEN weight ELSE 0 END)::numeric / NULLIF(SUM(weight), 0) AS hit,
           count(*)::integer AS n
      FROM s
  )
  SELECT t.w,
         round(t.ev / v_intake, 6),
         round(t.ev_chips / v_intake, 6),
         round(t.ev_dia / v_intake, 6),
         round(1 - t.ev / v_intake, 6),
         round(sqrt((SELECT SUM(power(s.value_chips - t.ev, 2) * s.weight) FROM s) / t.w), 6),
         round(t.hit, 6),
         t.n
    FROM t;
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_segments_audit(integer) TO authenticated, service_role;

-- ── host resolution: a club in a union plays the union's wheel ───────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_host(p_club_id uuid, OUT host_id uuid, OUT host_kind text)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(c.union_id, c.id),
         CASE WHEN c.union_id IS NULL THEN 'club' ELSE 'union' END
    FROM public.clubs c WHERE c.id = p_club_id;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_host(uuid) TO authenticated, service_role;

-- ── who may operate a host's wheel ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_can_operate(p_host_id uuid, p_host_kind text, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_user IS NULL THEN RETURN false; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN true; END IF;
  IF public.fn_ca_caller_is_management() THEN RETURN true; END IF;
  IF p_host_kind = 'union' THEN
    RETURN public.fn_union_can_manage_wallets(p_host_id, p_user);
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_host_id AND c.owner_id = p_user)
      OR EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.club_id = p_host_id AND cm.user_id = p_user
                    AND cm.role IN ('owner', 'co_owner', 'admin')
                    AND COALESCE(cm.status, 'active') IN ('active', 'approved'));
END $function$;
REVOKE ALL ON FUNCTION public.fn_wheel_can_operate(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ── the commit: the server picks its seed before the player presses Spin ─────
CREATE OR REPLACE FUNCTION public.fn_wheel_commit()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_seed text;
  v_hash text;
  v_id uuid;
  v_exp timestamptz;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  -- One open commit per player: a fresh one replaces any unspent older ones,
  -- so a stale hash on a stale tab can never be spun.
  DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL;
  v_seed := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_seed, 'sha256'), 'hex');
  INSERT INTO public.wheel_seed_commits (user_id, server_seed, server_seed_hash)
  VALUES (v_user, v_seed, v_hash) RETURNING id, expires_at INTO v_id, v_exp;
  RETURN jsonb_build_object('ok', true, 'commit_id', v_id, 'server_seed_hash', v_hash, 'expires_at', v_exp);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_commit() TO authenticated, service_role;

-- ── purchased diamonds available to a player (FIFO lots, unfrozen) ──────────
CREATE OR REPLACE FUNCTION public.fn_wheel_purchased_available(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(l.issued - l.consumed - l.refunded), 0)::integer
    FROM public.diamond_purchase_lots l
   WHERE l.user_id = p_user AND l.frozen_at IS NULL
     AND (l.issued - l.consumed - l.refunded) > 0;
$function$;
REVOKE ALL ON FUNCTION public.fn_wheel_purchased_available(uuid) FROM PUBLIC, anon, authenticated;

-- ── what the player sees: the table, the odds, the locks, their own limits ───
CREATE OR REPLACE FUNCTION public.fn_wheel_state(p_club_id uuid)
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
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_mult integer;
  v_bank numeric := 0;
  v_intake numeric; v_mint_now numeric; v_dia_now numeric;
  v_segments jsonb;
  v_diamonds numeric := 0; v_purchased integer := 0; v_spendable integer := 0;
  v_today integer := 0; v_last timestamptz; v_wait integer := 0;
  v_member boolean := false; v_member_chips numeric;
  v_frozen boolean;
  a record;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'available', false, 'reason', 'not_configured',
                              'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_intake   := cfg.spin_price_diamonds::numeric / v_rate;
  v_mint_now := round(v_intake * a.chip_share, 6);
  v_dia_now  := round(cfg.spin_price_diamonds * a.diamond_share, 4);

  IF v_kind = 'union' THEN
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host;
  END IF;
  v_bank := COALESCE(v_bank, 0);

  SELECT jsonb_agg(jsonb_build_object(
           'ord', g.ord, 'label', g.label, 'kind', g.kind,
           'amount', g.amount * v_mult,
           'value_chips', CASE g.kind WHEN 'chips' THEN g.amount * v_mult
                                      WHEN 'diamonds' THEN round(g.amount * v_mult / v_rate, 4) ELSE 0 END,
           'weight', g.weight,
           'probability', round(g.weight::numeric / a.weight_total, 6),
           'locked', CASE
              WHEN g.kind = 'chips' AND (
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult
                       > COALESCE(pool.chips_minted, 0) + v_mint_now + cfg.exposure_allowance_chips
                  OR v_bank < g.amount * v_mult) THEN true
              WHEN g.kind = 'diamonds' AND COALESCE(pool.diamond_float, 0) + v_dia_now < g.amount * v_mult THEN true
              ELSE false END,
           'unlocks_at', CASE
              WHEN g.kind = 'chips' THEN round(GREATEST(
                     COALESCE(pool.chips_paid, 0) + g.amount * v_mult - v_mint_now - cfg.exposure_allowance_chips,
                     COALESCE(pool.chips_minted, 0)), 2)
              WHEN g.kind = 'diamonds' THEN round(g.amount * v_mult - v_dia_now, 0)
              ELSE NULL END
         ) ORDER BY g.ord)
    INTO v_segments
    FROM public.wheel_segments g WHERE g.version = cfg.segment_version;

  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;

  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_last IS NOT NULL THEN
    v_wait := GREATEST(0, cfg.min_seconds_between_spins - floor(extract(epoch FROM (now() - v_last)))::integer);
  END IF;
  SELECT true, COALESCE(cm.chip_balance, 0) INTO v_member, v_member_chips
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id AND cm.user_id = v_user
     AND COALESCE(cm.status, 'active') IN ('active', 'approved') LIMIT 1;
  v_frozen := public.fn_platform_frozen()
           OR EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL);

  RETURN jsonb_build_object(
    'ok', true, 'available', cfg.enabled, 'host_id', v_host, 'host_kind', v_kind, 'club_id', p_club_id,
    'config', jsonb_build_object(
      'spin_price_diamonds', cfg.spin_price_diamonds, 'diamonds_per_chip', v_rate,
      'spin_price_chips', v_intake, 'segment_version', cfg.segment_version, 'multiplier', v_mult,
      'purchased_only', cfg.purchased_only, 'max_spins_per_player_per_day', cfg.max_spins_per_player_per_day,
      'min_seconds_between_spins', cfg.min_seconds_between_spins,
      'spec_rtp', a.spec_rtp, 'chip_share', a.chip_share, 'diamond_share', a.diamond_share,
      'house_share', a.house_share, 'hit_rate', a.hit_rate),
    'segments', COALESCE(v_segments, '[]'::jsonb),
    'pool', jsonb_build_object(
      'spins', COALESCE(pool.spins, 0), 'intake_diamonds', COALESCE(pool.intake_diamonds, 0),
      'chips_minted', COALESCE(pool.chips_minted, 0), 'chips_paid', COALESCE(pool.chips_paid, 0),
      'diamond_float', COALESCE(pool.diamond_float, 0), 'diamonds_paid', COALESCE(pool.diamonds_paid, 0),
      'realized_rtp', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
                           THEN round((COALESCE(pool.chips_paid, 0) + COALESCE(pool.diamonds_paid, 0)::numeric / v_rate)
                                      / (pool.intake_diamonds::numeric / v_rate), 4) END),
    'player', jsonb_build_object(
      'diamonds', v_diamonds, 'purchased_available', v_purchased, 'spendable', v_spendable,
      'spins_today', v_today, 'seconds_until_next', v_wait,
      'is_member', COALESCE(v_member, false), 'member_chips', v_member_chips),
    'frozen', v_frozen);
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state(uuid) TO authenticated, service_role;

-- The shape of a spin as the player receives it, built from the row so a
-- replay is byte-identical to the first answer.
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_result(s public.wheel_spins)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'ok', true, 'spin_id', s.id, 'club_id', s.club_id, 'host_id', s.host_id,
    'segment_version', s.segment_version, 'spin_price_diamonds', s.spin_price_diamonds,
    'diamonds_per_chip', s.diamonds_per_chip,
    'outcome', jsonb_build_object('ord', s.outcome_ord, 'kind', s.outcome_kind, 'amount', s.outcome_amount,
                                  'label', (SELECT g.label FROM public.wheel_segments g
                                             WHERE g.version = s.segment_version AND g.ord = s.outcome_ord),
                                  'value_chips', s.prize_value_chips),
    'fairness', jsonb_build_object('commit_id', s.commit_id, 'server_seed_hash', s.server_seed_hash,
                                   'server_seed', s.server_seed, 'client_seed', s.client_seed,
                                   'nonce', s.nonce, 'roll', s.roll, 'weight_total', s.weight_total,
                                   'eligible_ords', to_jsonb(s.eligible_ords), 'locked', s.locked),
    'balances', jsonb_build_object('diamonds', s.diamonds_after, 'member_chips', s.member_chips_after),
    'pool', jsonb_build_object('chips_minted', s.pool_chips_minted_after, 'chips_paid', s.pool_chips_paid_after,
                               'diamond_float', s.pool_diamond_float_after),
    'created_at', s.created_at);
$function$;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_result(public.wheel_spins) FROM PUBLIC, anon, authenticated;

-- ── THE SPIN ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
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
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_mint_exact numeric; v_mint_now numeric; v_carry numeric; v_dia_now numeric;
  v_bank numeric; v_bank_after numeric;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
BEGIN
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id <> v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT cfg.spin_price_diamonds / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  v_price  := cfg.spin_price_diamonds;
  v_intake := v_price::numeric / v_rate;
  v_mint_exact := round(v_intake * a.chip_share, 6) + pool.mint_carry;
  v_mint_now   := floor(v_mint_exact * 100) / 100;
  v_carry      := round(v_mint_exact - v_mint_now, 6);
  v_dia_now    := round(v_price * a.diamond_share, 4);

  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host bank, locked ──────────────────────────────────────────────────
  IF v_kind = 'union' THEN
    INSERT INTO public.union_wallets (union_id, created_at, updated_at) VALUES (v_host, now(), now())
    ON CONFLICT (union_id) DO NOTHING;
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host FOR UPDATE;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host FOR UPDATE;
  END IF;
  v_bank := COALESCE(v_bank, 0);

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      IF pool.chips_paid + seg.amount * v_mult > pool.chips_minted + v_mint_now + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - v_mint_now - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank + v_mint_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'bank', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      IF pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for ────────────────────────────────────────────────
  v_deduct := public.deduct_diamonds(
    v_user, v_price,
    format('Diamond Wheel Spin (%s Diamonds)', v_price),
    'wheel_spin', 'wheel_spin',
    jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                       'commit_id', p_commit_id, 'segment_version', cfg.segment_version),
    'wheel:' || v_spin_id::text, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                              'detail', v_deduct->>'error');
  END IF;
  IF cfg.purchased_only THEN
    v_remaining := v_price;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = v_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'fn_wheel_spin: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;

  -- ── 2. the host is paid its chip share: an issuance, registered ────────────
  IF v_mint_now > 0 THEN
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve', NULL, NULL, 'wheel-mint:' || v_spin_id::text, NULL);
    IF v_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = COALESCE(chip_balance, 0) + v_mint_now, updated_at = now()
       WHERE union_id = v_host RETURNING chip_balance INTO v_bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_mint_now, updated_at = now()
       WHERE id = v_host RETURNING chip_treasury INTO v_bank_after;
    END IF;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key = 'wheel-mint:' || v_spin_id::text) THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host bank moved but no mint leg was journaled for spin %', v_spin_id;
    END IF;
    v_bank := v_bank_after;
  END IF;

  -- ── 3. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin: host bank % below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    PERFORM public.fn_ca_declare_ledger('wheel_prize',
              CASE WHEN v_kind = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
              v_host, NULL, 'wheel-prize:' || v_spin_id::text,
              CASE WHEN v_kind = 'union' THEN ARRAY['union_wallets'] ELSE ARRAY['clubs'] END);
    IF v_kind = 'union' THEN
      UPDATE public.union_wallets SET chip_balance = chip_balance - v_prize_chips, updated_at = now()
       WHERE union_id = v_host AND COALESCE(chip_balance, 0) >= v_prize_chips
       RETURNING chip_balance INTO v_bank_after;
    ELSE
      UPDATE public.clubs SET chip_treasury = chip_treasury - v_prize_chips, updated_at = now()
       WHERE id = v_host AND COALESCE(chip_treasury, 0) >= v_prize_chips
       RETURNING chip_treasury INTO v_bank_after;
    END IF;
    IF v_bank_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the host bank refused the prize debit of %', v_prize_chips;
    END IF;
    UPDATE public.club_members SET chip_balance = COALESCE(chip_balance, 0) + v_prize_chips, updated_at = now()
     WHERE club_id = p_club_id AND user_id = v_user
       AND COALESCE(status, 'active') IN ('active', 'approved')
     RETURNING chip_balance INTO v_member_after;
    IF v_member_after IS NULL THEN
      RAISE EXCEPTION 'fn_wheel_spin: the prize landed nowhere for % in club %', v_user, p_club_id;
    END IF;
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    IF v_kind = 'union' THEN
      INSERT INTO public.union_wallet_transactions
        (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
      VALUES (v_host, p_club_id, 'chip_balance', 'debit', v_prize_chips, v_bank_after, 'wheel_prize',
              format('Diamond Wheel prize, spin %s', v_spin_id), v_user);
    END IF;
    INSERT INTO public.chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    VALUES (p_club_id, NULL, v_user, v_prize_chips, 'wheel_prize',
            format('Diamond Wheel: %s', v_pick.label),
            jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                               'segment_version', cfg.segment_version, 'ord', v_pick.ord),
            v_member_after);
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    v_credit := public.add_diamonds_to_balance(v_user, v_prize_dia, 'wheel_prize',
                  format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin: the diamond prize could not be credited: %', v_credit->>'error';
    END IF;
  END IF;

  -- ── 4. the pool remembers ──────────────────────────────────────────────────
  UPDATE public.wheel_pools
     SET spins = spins + 1,
         intake_diamonds = intake_diamonds + v_price,
         chips_minted = chips_minted + v_mint_now,
         mint_carry = v_carry,
         chips_paid = chips_paid + v_prize_chips,
         diamond_float = diamond_float + v_dia_now - v_prize_dia,
         diamonds_paid = diamonds_paid + v_prize_dia,
         constrained_spins = constrained_spins + CASE WHEN jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > pool.chips_minted + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin: chips_paid % would exceed chips_minted % + allowance % - the gate was bypassed',
      pool.chips_paid, pool.chips_minted, cfg.exposure_allowance_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after, is_fixture)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version, v_price, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, v_mint_now, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after, v_is_fixture)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;

-- ── the player's own history ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_history(p_club_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(public.fn_wheel_spin_result(s) ORDER BY s.created_at DESC), '[]'::jsonb)
    FROM (SELECT * FROM public.wheel_spins w
           WHERE w.user_id = auth.uid()
             AND w.host_id = (SELECT h.host_id FROM public.fn_wheel_host(p_club_id) h)
           ORDER BY w.created_at DESC
           LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)) s;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_history(uuid, integer) TO authenticated, service_role;

-- ── the operator's controls ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_wheel_set_config(p_club_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  v_version integer; v_vprice integer;
  a record;
BEGIN
  IF v_user IS NULL AND COALESCE(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In First');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Change The Wheel');
  END IF;

  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  IF cfg.host_id IS NULL THEN
    SELECT max(v.version) INTO v_version FROM public.wheel_segment_versions v WHERE v.activated_at IS NOT NULL;
    IF v_version IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'No Prize Table Has Been Activated Yet');
    END IF;
    INSERT INTO public.wheel_configs (host_id, host_kind, segment_version, updated_by)
    VALUES (v_host, v_kind, v_version, v_user) RETURNING * INTO cfg;
    INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  END IF;

  IF p_patch ? 'segment_version' THEN
    v_version := (p_patch->>'segment_version')::integer;
    IF NOT EXISTS (SELECT 1 FROM public.wheel_segment_versions v WHERE v.version = v_version AND v.activated_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Prize Table Is Not Activated');
    END IF;
    cfg.segment_version := v_version;
  END IF;
  IF p_patch ? 'spin_price_diamonds' THEN cfg.spin_price_diamonds := (p_patch->>'spin_price_diamonds')::integer; END IF;
  IF p_patch ? 'exposure_allowance_chips' THEN cfg.exposure_allowance_chips := round((p_patch->>'exposure_allowance_chips')::numeric, 2); END IF;
  IF p_patch ? 'purchased_only' THEN cfg.purchased_only := (p_patch->>'purchased_only')::boolean; END IF;
  IF p_patch ? 'allow_fixture_accounts' THEN cfg.allow_fixture_accounts := (p_patch->>'allow_fixture_accounts')::boolean; END IF;
  IF p_patch ? 'max_spins_per_player_per_day' THEN cfg.max_spins_per_player_per_day := (p_patch->>'max_spins_per_player_per_day')::integer; END IF;
  IF p_patch ? 'min_seconds_between_spins' THEN cfg.min_seconds_between_spins := (p_patch->>'min_seconds_between_spins')::integer; END IF;
  IF p_patch ? 'enabled' THEN cfg.enabled := (p_patch->>'enabled')::boolean; END IF;

  -- The spin price must be a whole multiple of the table's price so every prize
  -- scales by an integer and stays on whole cents; the table must still audit.
  SELECT v.spin_price_diamonds INTO v_vprice FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF cfg.spin_price_diamonds % v_vprice <> 0 THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('The Spin Price Must Be A Multiple Of %s Diamonds For This Prize Table', v_vprice));
  END IF;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF cfg.enabled AND (a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Fails Its Audit And Cannot Be Enabled');
  END IF;

  UPDATE public.wheel_configs
     SET enabled = cfg.enabled, spin_price_diamonds = cfg.spin_price_diamonds, segment_version = cfg.segment_version,
         exposure_allowance_chips = cfg.exposure_allowance_chips, purchased_only = cfg.purchased_only,
         allow_fixture_accounts = cfg.allow_fixture_accounts,
         max_spins_per_player_per_day = cfg.max_spins_per_player_per_day,
         min_seconds_between_spins = cfg.min_seconds_between_spins,
         updated_at = now(), updated_by = v_user
   WHERE host_id = v_host
   RETURNING * INTO cfg;
  RETURN jsonb_build_object('ok', true, 'config', to_jsonb(cfg), 'audit', to_jsonb(a));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_set_config(uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_wheel_activate_segments(p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE a record;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only Platform Management Activates A Prize Table');
  END IF;
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(p_version) x;
  IF a.weight_total IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Prize Table Does Not Exist');
  END IF;
  IF a.weight_total <> 100000 THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Weights Must Sum To 100,000, Not %s', a.weight_total), 'audit', to_jsonb(a));
  END IF;
  IF a.spec_rtp <> 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', format('Return To Player Must Be Exactly 80 Percent, Not %s', a.spec_rtp), 'audit', to_jsonb(a));
  END IF;
  UPDATE public.wheel_segment_versions
     SET spec_rtp = a.spec_rtp, chip_share = a.chip_share, diamond_share = a.diamond_share,
         house_share = a.house_share, sd_chips = a.sd_chips, activated_at = COALESCE(activated_at, now())
   WHERE version = p_version;
  RETURN jsonb_build_object('ok', true, 'version', p_version, 'audit', to_jsonb(a));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_activate_segments(integer) TO authenticated, service_role;

-- ── the house side: realised return, exposure, the invariant, as a z-score ───
CREATE OR REPLACE FUNCTION public.fn_wheel_metrics(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  v_rate integer := public.fn_ca_bridge_rate();
  v_sd numeric; v_windows jsonb; v_bank numeric;
  v_invariant_ok boolean;
BEGIN
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found'); END IF;
  IF NOT public.fn_wheel_can_operate(v_host, v_kind, v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only The Host Owner Or An Admin May Read The Wheel Metrics');
  END IF;
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host;
  IF cfg.host_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'configured', false, 'host_id', v_host, 'host_kind', v_kind);
  END IF;
  SELECT v.sd_chips INTO v_sd FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF v_kind = 'union' THEN
    SELECT COALESCE(w.chip_balance, 0) INTO v_bank FROM public.union_wallets w WHERE w.union_id = v_host;
  ELSE
    SELECT COALESCE(c.chip_treasury, 0) INTO v_bank FROM public.clubs c WHERE c.id = v_host;
  END IF;

  -- Realised return against the 80 percent spec, per window, as a z-score on
  -- the table's own standard deviation: the spin fairness view's method.
  SELECT jsonb_agg(w ORDER BY w->>'window') INTO v_windows
    FROM (
      SELECT jsonb_build_object(
               'window', lbl,
               'spins', n,
               'intake_chips', round(intake, 2),
               'paid_chips', round(paid, 4),
               'realized_rtp', CASE WHEN intake > 0 THEN round(paid / intake, 4) END,
               'z', CASE WHEN n >= 30 AND v_sd > 0
                         THEN round((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n)), 2) END,
               'constrained', constrained,
               'drift', CASE WHEN n >= 2000 AND v_sd > 0
                             THEN abs((paid / n - 0.80 * intake / n) / (v_sd / sqrt(n))) >= 4 ELSE false END)
             AS w
        FROM (
          SELECT lbl,
                 count(s.id) AS n,
                 COALESCE(SUM(s.spin_price_diamonds::numeric / s.diamonds_per_chip), 0) AS intake,
                 COALESCE(SUM(s.prize_value_chips), 0) AS paid,
                 COALESCE(SUM(CASE WHEN jsonb_array_length(s.locked) > 0 THEN 1 ELSE 0 END), 0) AS constrained
            FROM (VALUES ('1h', interval '1 hour'), ('24h', interval '24 hours'), ('7d', interval '7 days')) AS win(lbl, span)
            LEFT JOIN public.wheel_spins s
              ON s.host_id = v_host AND NOT s.is_fixture AND s.created_at >= now() - win.span
           GROUP BY lbl
        ) x
    ) y;

  v_invariant_ok := pool.host_id IS NULL
                 OR (pool.chips_paid <= pool.chips_minted + cfg.exposure_allowance_chips AND pool.diamond_float >= 0);
  IF NOT v_invariant_ok THEN
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        p_source => 'wheel_invariant', p_classification => 'unauthorized_adjustment', p_severity => 'critical',
        p_dedupe_key => 'wheel:invariant:' || v_host::text,
        p_discrepancy => pool.chips_paid - pool.chips_minted - cfg.exposure_allowance_chips,
        p_expected => pool.chips_minted + cfg.exposure_allowance_chips, p_actual => pool.chips_paid,
        p_layer => 'settlement', p_entity_type => 'wheel_pool', p_entity_id => v_host,
        p_union_id => CASE WHEN v_kind = 'union' THEN v_host END,
        p_club_id => CASE WHEN v_kind = 'club' THEN v_host END,
        p_suspected_cause => 'Diamond Wheel paid more than it minted plus the allowance; the per-spin gate was bypassed',
        p_metadata => to_jsonb(pool));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'configured', true, 'host_id', v_host, 'host_kind', v_kind,
    'config', to_jsonb(cfg),
    'pool', to_jsonb(pool),
    'bank_chips', COALESCE(v_bank, 0),
    'exposure_chips', COALESCE(pool.chips_paid, 0) - COALESCE(pool.chips_minted, 0),
    'exposure_headroom_chips', cfg.exposure_allowance_chips - (COALESCE(pool.chips_paid, 0) - COALESCE(pool.chips_minted, 0)),
    'realized_rtp_lifetime', CASE WHEN COALESCE(pool.intake_diamonds, 0) > 0
        THEN round((pool.chips_paid + pool.diamonds_paid::numeric / v_rate) / (pool.intake_diamonds::numeric / v_rate), 4) END,
    'house_take_lifetime_chips', CASE WHEN pool.host_id IS NOT NULL
        THEN round(pool.intake_diamonds::numeric / v_rate - pool.chips_minted - pool.diamond_float / v_rate - pool.diamonds_paid::numeric / v_rate, 4) END,
    'lock_rate', CASE WHEN COALESCE(pool.spins, 0) > 0 THEN round(pool.constrained_spins::numeric / pool.spins, 4) END,
    'invariant_ok', v_invariant_ok,
    'windows', COALESCE(v_windows, '[]'::jsonb),
    'audit', (SELECT to_jsonb(x) FROM public.fn_wheel_segments_audit(cfg.segment_version) x));
END $function$;
GRANT EXECUTE ON FUNCTION public.fn_wheel_metrics(uuid) TO authenticated, service_role;

-- ── the tables are closed to the browser; the RPCs are the doors ─────────────
REVOKE ALL ON public.wheel_segment_versions, public.wheel_segments, public.wheel_configs,
              public.wheel_config_history, public.wheel_pools, public.wheel_seed_commits, public.wheel_spins
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wheel_segment_versions, public.wheel_segments, public.wheel_configs,
                public.wheel_config_history, public.wheel_pools, public.wheel_spins TO service_role;
ALTER TABLE public.wheel_segment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_config_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_seed_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wheel_spins ENABLE ROW LEVEL SECURITY;

-- ── the money movers are on the register ─────────────────────────────────────
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_wheel_spin', 'approved', 'Diamond Wheel: debits the spin through deduct_diamonds, mints the host chip share (registered issuance), pays the prize host bank -> member (wheel_prize) or through add_diamonds_to_balance. 20260907233833.'),
  ('fn_wheel_set_config', 'approved', 'Diamond Wheel operator controls: enable, price, exposure allowance, caps. Moves no chips itself. 20260907233833.'),
  ('fn_wheel_activate_segments', 'approved', 'Diamond Wheel prize table activation; refuses any table whose return is not exactly 0.800000. 20260907233833.'),
  ('fn_mint_chips_from_diamonds', 'approved', 'Owner bridge; reads ca_bridge_rate since 20260907233813 (100 diamonds per chip).')
ON CONFLICT (proname) DO UPDATE SET notes = EXCLUDED.notes;

-- ── activate version 1 and prove the arithmetic ──────────────────────────────
DO $$
DECLARE a record; r jsonb;
BEGIN
  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(1) x;
  IF a.weight_total <> 100000 THEN
    RAISE EXCEPTION 'POST-APPLY: version 1 weights sum to %, not 100000', a.weight_total;
  END IF;
  IF a.spec_rtp <> 0.800000 THEN
    RAISE EXCEPTION 'POST-APPLY: version 1 return is %, not 0.800000', a.spec_rtp;
  END IF;
  IF a.chip_share <> 0.743000 OR a.diamond_share <> 0.057000 OR a.house_share <> 0.200000 THEN
    RAISE EXCEPTION 'POST-APPLY: version 1 shares are chips % diamonds % house %; expected 0.743 / 0.057 / 0.200',
      a.chip_share, a.diamond_share, a.house_share;
  END IF;
  UPDATE public.wheel_segment_versions
     SET spec_rtp = a.spec_rtp, chip_share = a.chip_share, diamond_share = a.diamond_share,
         house_share = a.house_share, sd_chips = a.sd_chips, activated_at = COALESCE(activated_at, now())
   WHERE version = 1;
  IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname = 'fn_wheel_spin') THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_spin is not on the money RPC register';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'fn_wheel_spin' AND pronamespace = 'public'::regnamespace) IS NOT TRUE THEN
    RAISE EXCEPTION 'POST-APPLY: fn_wheel_spin lost SECURITY DEFINER';
  END IF;
END $$;

COMMIT;
