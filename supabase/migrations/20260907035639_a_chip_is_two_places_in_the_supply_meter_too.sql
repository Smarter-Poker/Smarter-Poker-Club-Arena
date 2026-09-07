-- THE NINE COLUMNS PHASE 3 DID NOT LOOK AT, AND THE ONE ARTIFACT SITTING IN
-- THE SUPPLY BECAUSE OF THEM.
--
-- Phase 4, and it starts with a gap in my own phase 3. That phase audited "the
-- conservation set" - 28 columns - gave ten of them a scale and closed the
-- door they came through. The set was not the set the SUPPLY METER reads.
--
-- MEASURED, 2026-09-07 03:5x UTC, by taking every column
-- `fn_ca_supply_snapshot` sums and asking the catalogue for its scale. Nine
-- were still open:
--
--   UNCONSTRAINED numeric (no rounding on write at all)
--     clubs.chip_pool
--     club_wallets.insurance_balance
--     union_wallets.bbj_wallet
--     union_wallets.insurance_wallet
--     union_wallets.promo_wallet
--     union_wallets.spin_reserve_wallet
--   scale 4 (rounds, but at the fourth place, so a real sub-cent can live there)
--     club_wallets.chip_balance
--     agents.agent_wallet_balance
--     agents.promo_wallet_balance
--
-- AND ONE OF THEM IS ALREADY HOLDING ONE. `clubs.chip_pool` for Club JAQK
-- (`a0000000-...-0001`) reads **12459.070000000014**. That is 12,459.07 with a
-- JS double's binary expansion behind it, and it is the reason the hourly
-- supply total has read `193,120,444.190000000014` all night: the meter sums
-- the buckets, and one bucket carries fourteen femto-chips that no rounding
-- ever removes. It is the same artifact class as the `tournament_payouts`
-- 55.629999999999995 phase 3 found, in a column phase 3 never checked.
--
-- Every other one of the nine is clean today: 0 sub-cent rows, 0.00 residue.
-- So this migration changes exactly one stored value - the artifact rounds to
-- 12,459.07, a correction of 1.4e-11 - and shuts the door on the other eight
-- before they take one.
--
-- WHY ALTER TYPE AND NOT A CHECK, unchanged from phase 3: a CHECK refuses the
-- write, and refusing a treasury credit because a float ended in ...014 trades
-- a rounding error for an outage. A column with a scale ROUNDS. The bad value
-- becomes unrepresentable rather than detected, which is what CLAUDE.md 10.11
-- asks for.
--
-- THE TRIGGERS HAVE TO STAND ASIDE, AND COME BACK EXACTLY AS THEY WERE.
-- Postgres will not retype a column named in a trigger's `UPDATE OF` list, and
-- all four tables name these columns:
--
--   clubs         trg_ca_autoledger (chip_treasury, promo_balance,
--                 insurance_balance, chip_pool), trg_guard_clubs_chip_pool_upd
--   club_wallets  trg_ca_autoledger (chip_balance, insurance_balance)
--   union_wallets trg_ca_autoledger (six wallet columns)
--   agents        trg_ca_autoledger (agent_wallet_balance, promo_wallet_balance)
--
-- `trg_ca_autoledger` is the trigger that journals every one of these movements
-- into `chip_ledger`. It is the last thing on this platform that may be lost or
-- altered by a side effect, so it is not retyped by hand: each definition is
-- READ from the catalogue with `pg_get_triggerdef`, dropped, and re-issued
-- verbatim from that captured string - the recreation cannot drift from the
-- original because it IS the original - and the verify block compares every
-- restored definition against its captured text character for character. All
-- inside one transaction that already holds ACCESS EXCLUSIVE on all four
-- tables, so there is no instant at which a concurrent write could slip past an
-- absent trigger.
--
-- THE LOCKS ARE TAKEN FIRST, ALL FOUR, IN ONE FIXED ORDER. A transaction that
-- does its work and then reaches for a table lock can deadlock against the
-- writers it is about to interrupt - which is exactly what happened at 00:02:28
-- tonight on `tournament_payouts`. Taking them up front, alphabetically, means
-- this can only ever wait. The tables are small (agents 3.5 MB, clubs 624 kB,
-- club_wallets 184 kB, union_wallets 104 kB) so the rewrites are milliseconds;
-- a 4 second timeout aborts the whole thing cleanly if the platform is busy,
-- and nothing is half-applied.
--
-- One transaction for all of it, per the production DDL policy in section 2.

BEGIN;

SET LOCAL lock_timeout = '4s';

LOCK TABLE public.agents, public.club_wallets, public.clubs, public.union_wallets
  IN ACCESS EXCLUSIVE MODE;

DO $scale$
DECLARE
  r        record;
  v_names  text[] := '{}';
  v_tables text[] := '{}';
  v_defs   text[] := '{}';
  v_vnames text[] := '{}';
  v_vdefs  text[] := '{}';
  v_vopts  text[] := '{}';
  v_vcomm  text[] := '{}';
  v_vacls  text[] := '{}';
  v_back   text;
  i        int;
  g        record;
BEGIN
  -- ------------------------------------------------------------------
  -- CAPTURE every trigger whose UPDATE OF list names a column being retyped.
  -- ------------------------------------------------------------------
  /* THE DEFINITION TEXT, NOT JUST THE UPDATE OF LIST. The first run of this
     migration captured triggers by pg_trigger.tgattr and still died on
     `0A000 cannot alter type of a column used in a trigger definition`,
     because Postgres counts a WHEN clause too: agents.trg_ca_autoledger_insert
     and clubs.trg_guard_clubs_chip_pool_ins name these columns only in their
     WHEN, and carry no UPDATE OF list at all. Matching on the rendered
     definition catches both forms, and over-capturing costs nothing - a
     trigger dropped and re-issued from its own text is unchanged. */
  FOR r IN
    SELECT c.relname AS tbl, t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relnamespace = 'public'::regnamespace
       AND (
            (c.relname = 'clubs'         AND pg_get_triggerdef(t.oid) ~ '\ychip_pool\y')
         OR (c.relname = 'club_wallets'  AND pg_get_triggerdef(t.oid) ~ '\y(chip_balance|insurance_balance)\y')
         OR (c.relname = 'union_wallets' AND pg_get_triggerdef(t.oid) ~ '\y(bbj_wallet|insurance_wallet|promo_wallet|spin_reserve_wallet)\y')
         OR (c.relname = 'agents'        AND pg_get_triggerdef(t.oid) ~ '\y(agent_wallet_balance|promo_wallet_balance)\y'))
     ORDER BY c.relname, t.tgname
  LOOP
    v_tables := v_tables || r.tbl;
    v_names  := v_names  || r.name;
    v_defs   := v_defs   || r.def;
    EXECUTE format('DROP TRIGGER %I ON public.%I', r.name, r.tbl);
  END LOOP;

  IF array_length(v_defs, 1) IS NULL THEN
    RAISE EXCEPTION 'ABORT: no trigger names any of these columns - the catalogue does not look the way this migration was written against, read it before proceeding';
  END IF;

  -- ------------------------------------------------------------------
  -- AND THE VIEWS. A view owns a copy of the column type too, which the
  -- second run of this migration learned the same way the tournament-pools
  -- migration did: `0A000 cannot alter type of a column used by a view or
  -- rule`. Exactly one view reads these columns - `club_agents`, on the two
  -- agent wallets - and it is captured, dropped and re-issued from its own
  -- catalogue text, with its options, its comment and its grants, then
  -- compared character for character below.
  -- ------------------------------------------------------------------
  FOR r IN
    SELECT DISTINCT dep.relname AS name
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class dep ON dep.oid = rw.ev_class
      JOIN pg_class src ON src.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE dep.relkind = 'v'
       AND dep.relname <> src.relname
       AND (src.relname, a.attname) IN (
             ('clubs','chip_pool'),
             ('club_wallets','chip_balance'), ('club_wallets','insurance_balance'),
             ('union_wallets','bbj_wallet'), ('union_wallets','insurance_wallet'),
             ('union_wallets','promo_wallet'), ('union_wallets','spin_reserve_wallet'),
             ('agents','agent_wallet_balance'), ('agents','promo_wallet_balance'))
     ORDER BY dep.relname
  LOOP
    IF EXISTS (SELECT 1 FROM pg_depend d2
                 JOIN pg_rewrite r2 ON r2.oid = d2.objid
                 JOIN pg_class c2 ON c2.oid = r2.ev_class
                WHERE d2.refobjid = ('public.' || r.name)::regclass
                  AND c2.oid <> ('public.' || r.name)::regclass) THEN
      RAISE EXCEPTION 'ABORT: something depends on view % - this migration only knows how to restore the view itself', r.name;
    END IF;

    v_vnames := v_vnames || r.name;
    v_vdefs  := v_vdefs  || pg_get_viewdef(('public.' || r.name)::regclass, true);
    v_vopts  := v_vopts  || COALESCE((SELECT array_to_string(reloptions, ', ') FROM pg_class
                                       WHERE oid = ('public.' || r.name)::regclass), '');
    v_vcomm  := v_vcomm  || COALESCE(obj_description(('public.' || r.name)::regclass, 'pg_class'), '');
    /* The grants are captured as the statements that restore them. Rebuilding
       an aclitem[] from text does not parse (22P02, third run of this
       migration); the privileges themselves round-trip cleanly. */
    v_vacls  := v_vacls  || COALESCE((
      SELECT string_agg(format('GRANT %s ON public.%I TO %s',
                               privs,
                               r.name,
                               CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE grantee::regrole::text END), ';')
        FROM (SELECT a.grantee, string_agg(a.privilege_type, ', ') AS privs
                FROM pg_class c2, aclexplode(c2.relacl) a
               WHERE c2.oid = ('public.' || r.name)::regclass
                 AND a.grantee <> 'postgres'::regrole::oid
               GROUP BY a.grantee) g), '');
    EXECUTE format('DROP VIEW public.%I', r.name);
  END LOOP;

  -- ------------------------------------------------------------------
  -- THE SCALE. One statement per table, so each is rewritten once.
  -- ------------------------------------------------------------------
  ALTER TABLE public.clubs
    ALTER COLUMN chip_pool TYPE numeric(18,2);

  ALTER TABLE public.club_wallets
    ALTER COLUMN chip_balance      TYPE numeric(20,2),
    ALTER COLUMN insurance_balance TYPE numeric(20,2);

  ALTER TABLE public.union_wallets
    ALTER COLUMN bbj_wallet          TYPE numeric(20,2),
    ALTER COLUMN insurance_wallet    TYPE numeric(20,2),
    ALTER COLUMN promo_wallet        TYPE numeric(20,2),
    ALTER COLUMN spin_reserve_wallet TYPE numeric(20,2);

  ALTER TABLE public.agents
    ALTER COLUMN agent_wallet_balance TYPE numeric(18,2),
    ALTER COLUMN promo_wallet_balance TYPE numeric(18,2);

  -- ------------------------------------------------------------------
  -- RESTORE, verbatim, and prove each one came back identical.
  -- ------------------------------------------------------------------
  FOR i IN 1 .. array_length(v_defs, 1) LOOP
    EXECUTE v_defs[i];

    SELECT pg_get_triggerdef(t.oid) INTO v_back
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = v_tables[i]
       AND t.tgname = v_names[i];

    IF v_back IS DISTINCT FROM v_defs[i] THEN
      RAISE EXCEPTION 'VERIFY FAILED: trigger % on % came back DIFFERENT from how it went away',
        v_names[i], v_tables[i];
    END IF;
  END LOOP;

  IF array_length(v_vdefs, 1) IS NOT NULL THEN
    FOR i IN 1 .. array_length(v_vdefs, 1) LOOP
      EXECUTE format('CREATE VIEW public.%I %s AS %s', v_vnames[i],
                     CASE WHEN v_vopts[i] <> '' THEN 'WITH (' || v_vopts[i] || ')' ELSE '' END,
                     v_vdefs[i]);
      IF v_vcomm[i] <> '' THEN
        EXECUTE format('COMMENT ON VIEW public.%I IS %L', v_vnames[i], v_vcomm[i]);
      END IF;
      IF v_vacls[i] <> '' THEN
        FOR g IN SELECT unnest(string_to_array(v_vacls[i], ';')) AS stmt LOOP
          EXECUTE g.stmt;
        END LOOP;
      END IF;

      IF pg_get_viewdef(('public.' || v_vnames[i])::regclass, true) IS DISTINCT FROM v_vdefs[i] THEN
        RAISE EXCEPTION 'VERIFY FAILED: view % came back DIFFERENT from how it went away', v_vnames[i];
      END IF;
      IF COALESCE((SELECT array_to_string(reloptions, ', ') FROM pg_class
                    WHERE oid = ('public.' || v_vnames[i])::regclass), '') <> v_vopts[i] THEN
        RAISE EXCEPTION 'VERIFY FAILED: view % lost its options', v_vnames[i];
      END IF;
    END LOOP;
  END IF;

  RAISE NOTICE 'SUPPLY_COLUMNS_SCALED % trigger(s) and % view(s) captured, dropped and restored verbatim', array_length(v_defs,1), COALESCE(array_length(v_vdefs,1),0);
END $scale$;

-- ---------------------------------------------------------------------------
-- PROVE IT: all nine carry scale 2, the artifact is the value it always meant,
-- nothing else moved, and the autoledger is still on every table it journals.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_unscaled int;
  v_bad      int;
  v_jaqk     numeric;
  v_ledgers  int;
BEGIN
  SELECT count(*) INTO v_unscaled
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'
     AND (c.table_name, c.column_name) IN (
           ('clubs','chip_pool'),
           ('club_wallets','chip_balance'), ('club_wallets','insurance_balance'),
           ('union_wallets','bbj_wallet'), ('union_wallets','insurance_wallet'),
           ('union_wallets','promo_wallet'), ('union_wallets','spin_reserve_wallet'),
           ('agents','agent_wallet_balance'), ('agents','promo_wallet_balance'))
     AND c.numeric_scale IS DISTINCT FROM 2;
  IF v_unscaled <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % of the nine supply columns is/are still not scale 2', v_unscaled;
  END IF;

  /* The artifact row, by id, now reads the value it always meant. */
  SELECT chip_pool INTO v_jaqk FROM public.clubs
   WHERE id = 'a0000000-0000-0000-0000-000000000001';
  IF v_jaqk IS NOT NULL AND v_jaqk <> 12459.07 THEN
    RAISE EXCEPTION 'VERIFY FAILED: Club JAQK chip_pool reads %, expected 12459.07', v_jaqk;
  END IF;

  /* And no sub-cent value survives anywhere in the nine. */
  SELECT (SELECT count(*) FROM public.clubs WHERE chip_pool <> round(chip_pool,2))
       + (SELECT count(*) FROM public.club_wallets
           WHERE chip_balance <> round(chip_balance,2)
              OR insurance_balance <> round(insurance_balance,2))
       + (SELECT count(*) FROM public.union_wallets
           WHERE bbj_wallet <> round(bbj_wallet,2)
              OR insurance_wallet <> round(insurance_wallet,2)
              OR promo_wallet <> round(promo_wallet,2)
              OR COALESCE(spin_reserve_wallet,0) <> round(COALESCE(spin_reserve_wallet,0),2))
       + (SELECT count(*) FROM public.agents
           WHERE COALESCE(agent_wallet_balance,0) <> round(COALESCE(agent_wallet_balance,0),2)
              OR COALESCE(promo_wallet_balance,0) <> round(COALESCE(promo_wallet_balance,0),2))
    INTO v_bad;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % sub-cent value(s) survive in the nine supply columns', v_bad;
  END IF;

  /* The journal's own trigger is back on all four tables. */
  SELECT count(*) INTO v_ledgers
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal AND t.tgname = 'trg_ca_autoledger'
     AND t.tgenabled <> 'D'
     AND c.relname IN ('clubs','club_wallets','union_wallets','agents');
  IF v_ledgers <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the autoledger is on only % of the four tables', v_ledgers;
  END IF;

  RAISE NOTICE 'A_CHIP_IS_TWO_PLACES_IN_THE_SUPPLY_TOO nine columns carry scale 2; the Club JAQK artifact is 12459.07; no sub-cent value remains and the autoledger is intact on all four tables';
END $verify$;

COMMIT;
