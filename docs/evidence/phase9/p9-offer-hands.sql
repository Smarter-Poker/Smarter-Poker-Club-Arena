set default_transaction_read_only = on;
set statement_timeout = '120s';
begin read only;
select h.id || ',' || coalesce(h.bomb_pot->>'variant', h.game_variant) || ',' ||
  (case when h.rit_boards is not null and jsonb_typeof(h.rit_boards)='array' then 1+jsonb_array_length(h.rit_boards) else 1 end) || ',' ||
  coalesce((select string_agg(x, '|' order by o) from jsonb_array_elements(h.rit_boards) with ordinality r(b,o), lateral (select string_agg(c, ';') x from jsonb_array_elements_text(r.b) c) y), '') || ',' ||
  array_to_string(h.community_cards, ';')
from action_audit_logs a
join hand_history h on h.table_id::text = a.details->>'table_id' and h.hand_number = (a.details->>'hand_number')::int
  and h.created_at >= '2026-10-02T23:50:00Z' and h.created_at < '2026-10-03T03:30:00Z'
where a.created_at >= '2026-10-03T00:00:00Z' and a.created_at < '2026-10-03T03:00:00Z' and a.action_type = 'engine_rit_offer'
  and coalesce(h.bomb_pot->>'variant', h.game_variant) in ('plo4','plo5','plo6','plo8','flo8');
rollback;
