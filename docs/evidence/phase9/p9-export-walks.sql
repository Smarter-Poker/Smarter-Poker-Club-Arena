set default_transaction_read_only = on;
set statement_timeout = '170s';
begin read only;
-- Phase 9 uncalled-money check, population W (declaration-walks.txt).
select json_build_object(
  'id', h.id, 'table', h.table_id, 'hn', h.hand_number, 'created_at', h.created_at,
  'variant', coalesce(h.bomb_pot->>'variant', h.game_variant), 'gv', h.game_variant,
  'button', h.button_seat, 'has_human', h.has_human, 'tour', h.tournament_id is not null,
  'source', h.source, 'version', h.version,
  'rit', h.rit_boards, 'cc', h.community_cards, 'cc2', h.community_cards2, 'cc3', h.community_cards3,
  'bomb', h.bomb_pot, 'kill', h.kill_pot is not null,
  'players', (select json_agg(json_build_object('u', p->>'userId', 's', (p->>'seat')::int)) from jsonb_array_elements(case when jsonb_typeof(h.players)='array' then h.players else '[]'::jsonb end) p),
  'actions', (select json_agg(json_build_object(
       'u', a->>'userId', 'a', a->>'action', 'm', a->'amount', 'st', a->>'stage', 'd', a->'dead', 's', a->'seat', 'he', a->>'historyEvent',
       'pn_total', case when a->'publicNode'->>'status' = 'captured'
                        then (select json_object_agg(x->>0, x->3) from jsonb_array_elements(a->'publicNode'->'seats') x) end
     ) order by ord) from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) with ordinality t(a, ord)),
  'pn', (select json_build_object('mode', a->'publicNode'->'mode', 'asset', a->'publicNode'->'asset', 'chipUnit', a->'publicNode'->'chipUnit',
            'deductions', a->'publicNode'->'deductions', 'boardCount', a->'publicNode'->'boardCount', 'anteType', a->'publicNode'->'anteType',
            'variant', a->'publicNode'->'variant', 'bombPot', a->'publicNode'->'bombPot', 'structure', a->'publicNode'->'structure')
         from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) a
         where a->'publicNode'->>'status' = 'captured' limit 1),
  'pot', h.pot_size, 'rake', h.rake_amount, 'bbj', h.bbj_amount, 'bb', h.big_blind, 'sb', h.small_blind,
  'hole', h.hole_cards, 'pots', h.pots,
  'winners', case when jsonb_typeof(h.winners)='array' then (select json_agg(json_build_object('u', coalesce(w->>'userId', w->>'user_id'), 'a', w->'amount')) from jsonb_array_elements(h.winners) w) end,
  'wbb', h.winners_by_board,
  'walk', w.walk, 'onep', w.onep
)
from hand_history h
cross join lateral (
  select
    (exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) a where a->>'action'='bb')
     and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) a where a->>'action'='fold')
     and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) a
                     where coalesce(a->>'userId','') <> 'system' and a->>'action' not in ('sb','bb','ante','post','bomb_ante','fold','return'))
     and not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.actions)='array' then h.actions else '[]'::jsonb end) a
                     where a->>'action'='fold' and a->>'stage' <> 'preflop')) as walk,
    exists (select 1 from jsonb_array_elements(case when jsonb_typeof(h.pots)='array' then h.pots else '[]'::jsonb end) p
            where jsonb_typeof(p->'eligible')='array' and jsonb_array_length(p->'eligible')=1) as onep
) w
where h.created_at >= :'since'::timestamptz and h.created_at < :'until'::timestamptz
  and (w.walk or w.onep)
order by h.created_at, h.id;
rollback;
