-- Native qualification schema for the opening registration resolution. The
-- tables the boundary reads come from the union-pnl-evidence-fast harness
-- (production column lists); the ones the prover adds carry the production
-- columns it reads (information_schema, 2026-09-28).
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY, from_type text, from_entity_id uuid, to_type text, to_entity_id uuid, amount numeric,
 category text, club_id uuid, tournament_id uuid, created_at timestamptz, status text, chain_seq bigint UNIQUE, row_hash text);
CREATE INDEX idx_chip_ledger_tournament_category ON public.chip_ledger(tournament_id,category) WHERE tournament_id IS NOT NULL;
CREATE TABLE public.tournaments(id uuid PRIMARY KEY, buy_in_amount numeric, buy_in_fee numeric, rebuy_cost numeric, addon_cost numeric,
 is_rebuy boolean, is_reentry boolean, add_on_available boolean, free_buy boolean);
CREATE TABLE public.union_pnl_inventory_checkpoints(boundary timestamptz PRIMARY KEY, base_boundary timestamptz, max_event_id bigint, row_count bigint,
 issue_count bigint, rows_md5 text, issues_md5 text, result_md5 text, legacy_verified boolean, seal_ms bigint, sealed_by text, sealed_at timestamptz);
CREATE TABLE public.union_pnl_inventory_checkpoint_rows(boundary timestamptz, source_name text, row_id uuid, latest_event_id bigint,
 first_operation text, after_row jsonb, PRIMARY KEY(boundary,source_name,row_id));
CREATE TABLE public.tournament_ticket_admission_authorizations(token uuid PRIMARY KEY, ticket_id uuid, tournament_id uuid, user_id uuid,
 registration_id uuid, created_at timestamptz);
CREATE TABLE public.tournament_qualification_entitlements(id uuid PRIMARY KEY, tournament_id uuid, user_id uuid, source_stage_no integer,
 source_registration_id uuid, state text, created_at timestamptz);
CREATE FUNCTION public.fn_union_pnl_inventory_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $function$;
-- the inventory the boundary reads at a sealed boundary is the checkpoint's
-- active rows (fn_union_pnl_inventory_population's filter), in row order
CREATE FUNCTION public.hx_seal(p_at timestamptz) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.union_pnl_inventory_checkpoints(boundary,row_count,issue_count,sealed_at)
  SELECT p_at,(SELECT count(*) FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary=p_at),0,p_at;
 INSERT INTO public.hx_inventory(boundary,result) SELECT p_at,jsonb_build_object('status','observed','population',jsonb_build_object(
  'tables','[]'::jsonb,'table_seats','[]'::jsonb,'union_clubs','[]'::jsonb,
  'tournaments',COALESCE((SELECT jsonb_agg(jsonb_build_object('source_event_id',c.latest_event_id,'row',c.after_row) ORDER BY c.row_id)
    FROM public.union_pnl_inventory_checkpoint_rows c WHERE c.boundary=p_at AND c.source_name='tournaments'
     AND c.after_row->>'status' NOT IN ('COMPLETED','CANCELLED')),'[]'),
  'tournament_players',COALESCE((SELECT jsonb_agg(jsonb_build_object('source_event_id',c.latest_event_id,'row',c.after_row) ORDER BY c.row_id)
    FROM public.union_pnl_inventory_checkpoint_rows c WHERE c.boundary=p_at AND c.source_name='tournament_players'
     AND EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoint_rows t WHERE t.boundary=p_at AND t.source_name='tournaments'
      AND t.row_id::text=c.after_row->>'tournament_id' AND t.after_row->>'status' NOT IN ('COMPLETED','CANCELLED'))),'[]')),'issues','[]'::jsonb);
$$;
-- The money-RPC registry guard's balance-writer test, as production defines it.
CREATE FUNCTION public.fn_ca_money_rpc_balance_columns() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT array_agg(DISTINCT c)
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;
$function$;
CREATE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$function$;
