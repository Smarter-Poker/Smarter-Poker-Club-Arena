-- SELECT ONLY. Parent executes once in REPEATABLE READ READ ONLY with a bounded
-- statement deadline (20s) and lock deadline (1s). No advisory/business calls.
-- One naturally completed ordinary Spin, canonical terminal receipt and exact
-- closed-table set. Purpose: isolated receipt-eligibility/pruner fixture ONLY.
-- It is not a financial/terminal-replay estate and does not restore production.
-- Keep captured receipt UUIDs/values unchanged only inside the fresh isolated
-- allocation; never treat fixture restoration as production authority. Names,
-- contact fields and auth secrets are omitted. Original executed query retained.
WITH selected AS MATERIALIZED (
 SELECT t.id
 FROM public.tournament_terminal_settlements r
 JOIN public.tournaments t ON t.id=r.tournament_id
 JOIN public.clubs c ON c.id=t.club_id
 WHERE t.status='COMPLETED' AND lower(t.variant)='spin' AND upper(t.tournament_type)='SPIN'
   AND t.max_players=3 AND NOT COALESCE(t.is_premium_spin,false)
   AND NOT COALESCE(t.is_bounty,false) AND NOT COALESCE(t.is_pko,false)
   AND NOT COALESCE(t.is_mystery_bounty,false)
   AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
   AND t.parent_tournament_id IS NULL AND t.survivors_advance_to IS NULL
   AND c.retired_by IS NULL AND r.settlement_mode='places'
   AND r.receipt_version=1 AND r.closed_table_count=1
   AND cardinality(r.closed_table_ids)=1
   AND r.source_seat_count BETWEEN 0 AND 3
   AND cardinality(r.source_seat_ids)=r.source_seat_count
   AND r.released_seat_count BETWEEN 0 AND r.source_seat_count
   AND cardinality(r.released_seat_ids)=r.released_seat_count
   AND r.released_seat_ids <@ r.source_seat_ids
   AND r.prize_pool=t.prize_pool AND r.bounty_pool=t.bounty_pool
   AND r.cash_payout_total=r.prize_pool AND r.bounty_payout_total=r.bounty_pool
   AND r.completed_at=t.ended_at AND r.escrow_closed_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.tables b WHERE b.id=r.closed_table_ids[1]
     AND b.tournament_id=t.id AND b.club_id=t.club_id
     AND b.union_id IS NOT DISTINCT FROM t.union_id
     AND b.cluster_id IS NULL AND b.status='closed' AND b.lifecycle='closed')
   AND (SELECT count(*) FROM public.tables b WHERE b.tournament_id=t.id)=1
   AND NOT EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts x WHERE x.tournament_id=t.id)
 ORDER BY r.completed_at DESC,r.tournament_id
 LIMIT 1
), t AS MATERIALIZED (
 SELECT x.* FROM public.tournaments x JOIN selected s ON s.id=x.id
), r AS MATERIALIZED (
 SELECT x.* FROM public.tournament_terminal_settlements x JOIN selected s ON s.id=x.tournament_id
), b AS MATERIALIZED (
 SELECT x.* FROM public.tables x JOIN selected s ON s.id=x.tournament_id
), c AS MATERIALIZED (
 SELECT x.* FROM public.clubs x JOIN t ON t.club_id=x.id
), union_ids AS MATERIALIZED (
 SELECT union_id id FROM t WHERE union_id IS NOT NULL
 UNION SELECT union_id FROM b WHERE union_id IS NOT NULL
 UNION SELECT union_id FROM c WHERE union_id IS NOT NULL
), u AS MATERIALIZED (
 SELECT x.* FROM public.unions x JOIN union_ids y ON y.id=x.id
), profile_ids AS MATERIALIZED (
 SELECT owner_id id FROM c WHERE owner_id IS NOT NULL
 UNION SELECT owner_id FROM u WHERE owner_id IS NOT NULL
), auth_ids AS MATERIALIZED (
 SELECT id FROM profile_ids
 UNION SELECT created_by FROM b WHERE created_by IS NOT NULL
 UNION SELECT winner_id FROM r
), auth_rows AS MATERIALIZED (
 SELECT x.id,x.aud,x.role FROM auth.users x JOIN auth_ids y ON y.id=x.id
), profile_rows AS MATERIALIZED (
 SELECT x.id,x.is_horse FROM public.profiles x JOIN profile_ids y ON y.id=x.id
), relations AS MATERIALIZED (
 SELECT c.oid,c.relname,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='public' AND c.relname IN('tournaments','tournament_terminal_settlements','tables','clubs','unions','profiles'))
    OR (n.nspname='auth' AND c.relname='users')
), packet AS (
 SELECT jsonb_build_object(
  'schema_version',1,'observed_at',clock_timestamp(),'transaction_timestamp',transaction_timestamp(),
  'server_version_num',current_setting('server_version_num'),
  'transaction_read_only',current_setting('transaction_read_only'),
  'transaction_isolation',current_setting('transaction_isolation'),
  'purpose','authentic completed-receipt eligibility fixture; no financial lifecycle replay',
  'tournament',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',id,'club_id',club_id,'union_id',union_id,'game_type',game_type,
    'variant',variant,'tournament_type',tournament_type,'status',status,
    'buy_in_amount',buy_in_amount,'buy_in_fee',buy_in_fee,'guaranteed_prize',guaranteed_prize,
    'prize_pool',prize_pool,'prize_pool_finalized',prize_pool_finalized,
    'bounty_pool',bounty_pool,'bounty_pool_paid',bounty_pool_paid,'total_rake',total_rake,
    'spin_multiplier',spin_multiplier,'is_premium_spin',is_premium_spin,
    'spin_locked_tiers',spin_locked_tiers,'starting_chips',starting_chips,
    'blind_structure',blind_structure,'payout_structure',payout_structure,
    'start_time',start_time,'started_at',started_at,'ended_at',ended_at,
    'max_players',max_players,'min_players',min_players,'table_size',table_size,
    'current_players',current_players,'is_bounty',is_bounty,'is_pko',is_pko,'is_mystery_bounty',is_mystery_bounty,
    'satellite_target_id',satellite_target_id,'satellite_target',satellite_target,
    'parent_tournament_id',parent_tournament_id,'survivors_advance_to',survivors_advance_to,
    'payout_math_version',payout_math_version,'payout_unit_cents',payout_unit_cents,
    'source_row_md5',md5(to_jsonb(t)::text))) FROM t),'[]'::jsonb),
  'terminal_receipts',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY tournament_id) FROM r),'[]'::jsonb),
  'tables',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',id,'club_id',club_id,'union_id',union_id,'tournament_id',tournament_id,
    'cluster_id',cluster_id,'created_by',created_by,'status',status,'lifecycle',lifecycle,
    'game_type',game_type,'game_variant',game_variant,'small_blind',small_blind,'big_blind',big_blind,
    'min_buy_in',min_buy_in,'max_buy_in',max_buy_in,'max_players',max_players,'current_players',current_players,
    'terminal_closed_at',terminal_closed_at,'source_row_md5',md5(to_jsonb(b)::text)) ORDER BY id) FROM b),'[]'::jsonb),
  'clubs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,'union_id',union_id,
    'retired_by',retired_by,'asset',asset,'is_platform',is_platform,'is_union',is_union,
    'source_row_md5',md5(to_jsonb(c)::text)) ORDER BY id) FROM c),'[]'::jsonb),
  'unions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'owner_id',owner_id,
    'source_row_md5',md5(to_jsonb(u)::text)) ORDER BY id) FROM u),'[]'::jsonb),
  'profiles',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM profile_rows x),'[]'::jsonb),
  'auth_identities',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM auth_rows x),'[]'::jsonb),
  'foreign_keys',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',x.nspname,'relation',x.relname,
    'name',k.conname,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,
    'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY x.nspname,x.relname,k.conname)
    FROM relations x JOIN pg_constraint k ON k.conrelid=x.oid AND k.contype='f'),'[]'::jsonb),
  'eligibility_authority',jsonb_build_object(
    'pruner_full_definition_md5',md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure)),
    'history_writer_full_definition_md5',md5(pg_get_functiondef('public.fn_ca_insert_hand_with_awards(jsonb,jsonb)'::regprocedure)),
    'terminal_immutable_binding',(SELECT jsonb_build_object('name',x.tgname,'enabled',x.tgenabled,
      'definition',pg_get_triggerdef(x.oid,true),'handler_full_definition_md5',md5(pg_get_functiondef(x.tgfoid)))
      FROM pg_trigger x WHERE x.tgrelid='public.tournament_terminal_settlements'::regclass
        AND x.tgname='tournament_terminal_settlements_append_only' AND NOT x.tgisinternal))
 ) value
), admission AS (
 SELECT (SELECT count(*)=1 FROM t) AND (SELECT count(*)=1 FROM r)
  AND (SELECT count(*)=1 FROM b) AND (SELECT count(*)=1 FROM c)
  AND (SELECT count(*) FROM union_ids)=(SELECT count(*) FROM u)
  AND (SELECT count(*) FROM u)<=2
  AND (SELECT count(*) FROM auth_ids)=(SELECT count(*) FROM auth_rows)
  AND (SELECT count(*) FROM auth_rows)<=5
  AND (SELECT count(*) FROM profile_ids)=(SELECT count(*) FROM profile_rows)
  AND (SELECT count(*) FROM profile_rows)<=3
  AND (SELECT count(*)=7 FROM relations)
  AND current_setting('transaction_read_only')='on'
  AND current_setting('transaction_isolation')='repeatable read' complete
)
SELECT jsonb_build_object('complete',complete AND octet_length(value::text)<=262144,
 'counts',jsonb_build_object('tournaments',(SELECT count(*) FROM t),'receipts',(SELECT count(*) FROM r),
   'tables',(SELECT count(*) FROM b),'clubs',(SELECT count(*) FROM c),'unions',(SELECT count(*) FROM u),
   'auth',(SELECT count(*) FROM auth_rows),'profiles',(SELECT count(*) FROM profile_rows)),
 'serialized_bytes',octet_length(value::text),
 'packet',CASE WHEN complete AND octet_length(value::text)<=262144 THEN value ELSE NULL END)
FROM packet CROSS JOIN admission;
