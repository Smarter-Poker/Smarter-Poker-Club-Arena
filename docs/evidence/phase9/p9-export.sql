set default_transaction_read_only = on;
set statement_timeout = '170s';
begin read only;
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
  'wbb', h.winners_by_board
)
from hand_history h
where h.created_at >= :'since'::timestamptz and h.created_at < :'until'::timestamptz
  and coalesce(h.bomb_pot->>'variant', h.game_variant) in ('plo4','plo5','plo6','plo8','flo8')
  and ((h.rit_boards is not null and jsonb_typeof(h.rit_boards)='array' and jsonb_array_length(h.rit_boards)>0)
       or (h.community_cards2 is not null and cardinality(h.community_cards2)>0))
order by h.created_at, h.id;
rollback;
