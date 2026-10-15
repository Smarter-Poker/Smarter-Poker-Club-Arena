-- 20261015014037_player_management_fees_come_from_the_fee_ledgers.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-14, on Player Management: "IT SHOULD ALWAYS SHOW FEES
-- GENERATED, NOT WALLET BALANCES." Putting the fee number on every row exposed
-- that the number itself was wrong. Read from production for Deep Stack
-- Society (2a1132b9-...): the roster printed 675.00 of fees for the whole club
-- while the club's own fee ledgers hold 820,309.86 of attributed cash rake
-- (ca_club_rake_daily_user, equal to rake_attributions to the cent) and
-- 532,750.21 of tournament fees (accounting_tournament_fee_sources, 400
-- players). The cause: Player Management, the downline list and the player
-- detail all read fees from hand-statistics projections
-- (club_roster_hand_totals / club_member_play_totals, built from ca_hand_facts),
-- which carry no tournament fees at all and lose cash rake whenever a hand's
-- statistics card is absent. Statistics are not the money ledger.
--
-- The root fix: every fee number on these surfaces now comes from the two
-- ledgers the platform pays agents and rakeback from.
--   cash       public.ca_club_rake_daily_user (rake attributed to the player,
--              launch-accounting accepted, maintained by its own triggers);
--   tournament public.ca_club_member_tournament_fee_daily, a new per-day
--              projection of the immutable accounting_tournament_fee_sources
--              receipts, written by a statement trigger in the same
--              transaction as each receipt. The receipts table refuses
--              UPDATE, DELETE and TRUNCATE, so an insert trigger is complete.
-- public.ca_club_member_fee_totals(club, from, to, user) is the one reader.
-- Hand counts keep coming from club_roster_hand_totals (they are statistics).
--
-- ca_club_roster_rows (Player Management page, export, filters, sorts),
-- ca_club_member_downline and ca_club_member_detail are patched against their
-- exact current definitions (md5 preimages read from production) so a moved
-- source aborts instead of being overwritten.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.ca_club_member_tournament_fee_daily (
  club_id uuid NOT NULL,
  user_id uuid NOT NULL,
  day date NOT NULL,
  fees numeric NOT NULL DEFAULT 0,
  entries bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id, day)
);
COMMENT ON TABLE public.ca_club_member_tournament_fee_daily IS
  'Per club, player and UTC day projection of accounting_tournament_fee_sources (immutable tournament fee receipts). Written only by trg_ca_club_member_tournament_fee_daily in the receipt''s own transaction. Read through ca_club_member_fee_totals.';
ALTER TABLE public.ca_club_member_tournament_fee_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_club_member_tournament_fee_daily FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fn_ca_club_member_tournament_fee_daily_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.ca_club_member_tournament_fee_daily AS d
         (club_id, user_id, day, fees, entries, updated_at)
  SELECT n.club_id, n.player_id, (n.charged_at AT TIME ZONE 'UTC')::date,
         sum(n.rake_credit), count(*)::bigint, now()
    FROM new_rows n
   WHERE n.club_id IS NOT NULL AND n.player_id IS NOT NULL
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
  ON CONFLICT (club_id, user_id, day) DO UPDATE
     SET fees = d.fees + EXCLUDED.fees,
         entries = d.entries + EXCLUDED.entries,
         updated_at = now();
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_club_member_tournament_fee_daily_apply() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_ca_club_member_tournament_fee_daily
  AFTER INSERT ON public.accounting_tournament_fee_sources
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_ca_club_member_tournament_fee_daily_apply();

-- Existing receipts. CREATE TRIGGER above holds SHARE ROW EXCLUSIVE on the
-- receipts table until COMMIT, so no receipt can land between this read and
-- the trigger taking over: each receipt is counted exactly once.
INSERT INTO public.ca_club_member_tournament_fee_daily (club_id, user_id, day, fees, entries, updated_at)
SELECT s.club_id, s.player_id, (s.charged_at AT TIME ZONE 'UTC')::date,
       sum(s.rake_credit), count(*)::bigint, now()
  FROM public.accounting_tournament_fee_sources s
 WHERE s.club_id IS NOT NULL AND s.player_id IS NOT NULL
 GROUP BY 1, 2, 3;

CREATE FUNCTION public.ca_club_member_fee_totals(
  p_club_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, cash_fees numeric, tournament_fees numeric, total_fees numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cash AS (
    SELECT d.user_id AS uid, sum(d.rake_cents)::numeric / 100 AS fees
      FROM public.ca_club_rake_daily_user d
     WHERE d.club_id = p_club_id
       AND (p_user_id IS NULL OR d.user_id = p_user_id)
       AND (p_from IS NULL OR d.day >= p_from)
       AND (p_to IS NULL OR d.day <= p_to)
     GROUP BY d.user_id
  ), mtt AS (
    SELECT t.user_id AS uid, sum(t.fees) AS fees
      FROM public.ca_club_member_tournament_fee_daily t
     WHERE t.club_id = p_club_id
       AND (p_user_id IS NULL OR t.user_id = p_user_id)
       AND (p_from IS NULL OR t.day >= p_from)
       AND (p_to IS NULL OR t.day <= p_to)
     GROUP BY t.user_id
  )
  SELECT coalesce(c.uid, m.uid),
         round(coalesce(c.fees, 0), 2),
         round(coalesce(m.fees, 0), 2),
         round(coalesce(c.fees, 0) + coalesce(m.fees, 0), 2)
    FROM cash c
    FULL JOIN mtt m ON m.uid = c.uid;
$function$;
COMMENT ON FUNCTION public.ca_club_member_fee_totals(uuid, date, date, uuid) IS
  'Fees generated per club member from the fee ledgers: attributed cash rake (ca_club_rake_daily_user) plus tournament fee receipts (ca_club_member_tournament_fee_daily). Internal; called by the roster, downline and member detail readers.';
REVOKE ALL ON FUNCTION public.ca_club_member_fee_totals(uuid, date, date, uuid) FROM PUBLIC, anon, authenticated;

DO $patch$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  -- Player Management rows (page, export, filters and sorts read these).
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '432ba60071a5a372ba058c755d46bf80' THEN
    RAISE EXCEPTION 'ca_club_roster_rows preimage changed; qualify current source';
  END IF;
  v_old := $old$  fees AS MATERIALIZED (
    SELECT r.user_id AS uid, r.fees AS fee_total, r.hands AS hand_total
      FROM public.club_roster_hand_totals r
      JOIN base b ON b.m_user_id = r.user_id
      JOIN access ac ON ac.uid = r.user_id AND ac.sensitive
     WHERE r.club_id = p_club_id
  ),$old$;
  v_new := $new$  fees AS MATERIALIZED (
    SELECT coalesce(lf.user_id, h.user_id) AS uid,
           coalesce(lf.total_fees, 0) AS fee_total,
           coalesce(h.hands, 0) AS hand_total
      FROM public.ca_club_member_fee_totals(p_club_id) lf
      FULL JOIN (
        SELECT r.user_id, r.hands
          FROM public.club_roster_hand_totals r
         WHERE r.club_id = p_club_id
      ) h ON h.user_id = lf.user_id
      JOIN access ac ON ac.uid = coalesce(lf.user_id, h.user_id) AND ac.sensitive
  ),$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'ca_club_roster_rows fee source missing';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;

  -- Downline list on the player page.
  SELECT pg_get_functiondef('public.ca_club_member_downline(uuid,uuid)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '01bf55c36679b3b772eeb85f8fe972e2' THEN
    RAISE EXCEPTION 'ca_club_member_downline preimage changed; qualify current source';
  END IF;
  v_old := $old$  ), fees AS MATERIALIZED (
    SELECT r.user_id AS uid, r.fees AS fee_total
      FROM public.club_roster_hand_totals r
     WHERE r.club_id = p_club_id AND r.user_id IN (SELECT f.uid FROM flat f)
  )$old$;
  v_new := $new$  ), fees AS MATERIALIZED (
    SELECT lf.user_id AS uid, lf.total_fees AS fee_total
      FROM public.ca_club_member_fee_totals(p_club_id) lf
     WHERE lf.user_id IN (SELECT f.uid FROM flat f)
  )$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'ca_club_member_downline fee source missing';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;

  -- Player detail: Total Fee and MTT Fee, overall or for a date range.
  SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '4c9933400f9f0bd1bc826769d91282c3' THEN
    RAISE EXCEPTION 'ca_club_member_detail preimage changed; qualify current source';
  END IF;
  v_old := $old$  ), txn AS MATERIALIZED ($old$;
  v_new := $new$  ), ledger_fee AS MATERIALIZED (
    SELECT coalesce(sum(lf.cash_fees), 0) AS fees,
           coalesce(sum(lf.tournament_fees), 0) AS mtt_fees
      FROM public.ca_club_member_fee_totals(p_club_id, p_from, p_to, p_user_id) lf
     WHERE v_sensitive
  ), txn AS MATERIALIZED ($new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'ca_club_member_detail txn anchor missing';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$'total_fee', round(coalesce(rl.fees, 0), 2), 'mtt_fee', round(coalesce(rl.mtt_fees, 0), 2),$old$;
  v_new := $new$'total_fee', round(coalesce(ledger.fees, 0), 2), 'mtt_fee', round(coalesce(ledger.mtt_fees, 0), 2),$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'ca_club_member_detail fee output missing';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_old := $old$  LEFT JOIN roll rl ON true
$old$;
  v_new := $new$  LEFT JOIN roll rl ON true
  LEFT JOIN ledger_fee ledger ON true
$new$;
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'ca_club_member_detail roll join missing';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  EXECUTE v_definition;
END
$patch$;

-- The backfill must equal the receipts it was built from, or nothing commits.
DO $verify$
DECLARE v_receipts numeric; v_projection numeric;
BEGIN
  SELECT coalesce(sum(rake_credit), 0) INTO v_receipts
    FROM public.accounting_tournament_fee_sources
   WHERE club_id IS NOT NULL AND player_id IS NOT NULL;
  SELECT coalesce(sum(fees), 0) INTO v_projection
    FROM public.ca_club_member_tournament_fee_daily;
  IF v_receipts <> v_projection THEN
    RAISE EXCEPTION 'tournament fee projection % does not equal receipts %', v_projection, v_receipts;
  END IF;
END
$verify$;

COMMIT;
