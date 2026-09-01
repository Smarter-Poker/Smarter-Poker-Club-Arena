-- fn_ca_money_rpc_drift flagged fn_set_club_lobby_message as an unregistered
-- balance writer. It writes lobby_message. It touches no money at all.
--
-- The sweep matched on the TABLE and nothing else: any function containing
-- "UPDATE clubs" was a money path as far as it was concerned, and clubs holds
-- the lobby message, the member count, the rake percent and a dozen other
-- ordinary columns. Same for club_members, tournament_players and the rest.
--
-- That is not a harmless imprecision. A checker that cries wolf on a lobby
-- message teaches everyone to register whatever it names, and the registry -
-- whose entire value is that a human audited each entry - fills up with
-- functions nobody audited because nobody believed the alarm. The check also
-- gates epoch-3 preflight, so a false positive blocks a real gate.
--
-- Now it requires both: the table AND a column that actually holds a balance.
-- The column list is derived from the live fn_ca_autoledger triggers rather
-- than typed out, so it follows the schema instead of drifting from it, plus
-- the few balance columns on tables the autoledger does not watch
-- (table_seats.stack, wallets.balance, club_members' held/locked/credit
-- columns, tournament chips and prizes).
--
-- Everything else about it is unchanged: same tables, same registry, same
-- incident, same side effect of raising one when it finds something.

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_drift()
 RETURNS TABLE(proname text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_cols text[];
  v_col_re text;
BEGIN
  /* The balance columns, read from the triggers that watch them. */
  SELECT array_agg(DISTINCT c) INTO v_cols
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;

  v_col_re := '\y(' || array_to_string(v_cols, '|') || ')\y';

  FOR r IN
    SELECT DISTINCT p.proname AS pn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND (
        p.prosrc ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
        OR p.prosrc ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y'
      )
      /* ...and it has to actually name a balance column. */
      AND p.prosrc ~* v_col_re
      AND NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry g WHERE g.proname = p.proname)
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_money_rpc_drift', 'unauthorized_adjustment', 'warning',
      'rpc-drift:' || r.pn,
      0, NULL, NULL, 'ledger', 'pg_proc', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'NEW unregistered function writes balance columns: ' || r.pn
        || ' - audit it, then register it in ca_money_rpc_registry',
      NULL, jsonb_build_object('proname', r.pn));
    proname := r.pn; RETURN NEXT;
  END LOOP;
END $function$;

DO $$
DECLARE v_hits int;
BEGIN
  SELECT count(*) INTO v_hits FROM public.fn_ca_money_rpc_drift()
   WHERE proname = 'fn_set_club_lobby_message';
  IF v_hits > 0 THEN
    RAISE EXCEPTION 'the sweep still calls a lobby-message setter a money path';
  END IF;
END $$;

-- Who may call it, stated rather than left to be looked up. Checked against
-- production first: anon and authenticated already have no execute here and
-- service_role has it, and CREATE OR REPLACE does not touch grants - so this is
-- a no-op that makes the migration say what is true. Also applied on its own as
-- 20260901174433_state_the_money_rpc_sweep_is_service_role_only.
REVOKE ALL ON FUNCTION public.fn_ca_money_rpc_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_money_rpc_drift() TO service_role;
