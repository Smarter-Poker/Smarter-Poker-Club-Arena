-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725165955 "sp_v2_to_app_matrix_bridge"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fd0273090ed3b91355d16d226065aebd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 1326-combo -> 169-hand-class lookup (card = rank*4 + suit; combo = b*(b-1)/2 + a)
create table if not exists sp_combo_class(idx int primary key, cls text not null);

insert into sp_combo_class(idx, cls)
select (b*(b-1))/2 + a,
       case when b/4 = a/4
            then substr('23456789TJQKA', b/4+1, 1) || substr('23456789TJQKA', a/4+1, 1)
            else substr('23456789TJQKA', b/4+1, 1) || substr('23456789TJQKA', a/4+1, 1)
                 || case when b%4 = a%4 then 's' else 'o' end
       end
from generate_series(1,51) b, generate_series(0,50) a
where a < b
on conflict (idx) do nothing;

-- Server-side port of src/utils/v2Matrix.js v2ToAppMatrix().
-- Aggregates 1326 per-combo frequencies into 169 hand classes, normalized per class.
create or replace function sp_v2_to_app_matrix(v2 jsonb)
returns jsonb
language plpgsql
stable
as $fn$
declare
  codes text[];
  res   jsonb;
begin
  if v2 is null or jsonb_typeof(v2->'frequencies') <> 'object' then
    return null;
  end if;

  if jsonb_typeof(v2->'actions') = 'array' and jsonb_array_length(v2->'actions') > 0 then
    select array_agg(case when jsonb_typeof(e) = 'string' then e #>> '{}' else e->>'code' end order by ord)
      into codes
      from jsonb_array_elements(v2->'actions') with ordinality t(e, ord);
  else
    select array_agg(k order by k) into codes
      from jsonb_object_keys(v2->'frequencies') k;
  end if;

  codes := array_remove(codes, null);
  if codes is null or array_length(codes, 1) is null then
    return null;
  end if;

  with per as (
    select c.code,
           g.idx,
           coalesce((v2->'frequencies'->c.code->g.idx)::text::numeric, 0) as v
      from unnest(codes) c(code)
      cross join generate_series(0, 1325) g(idx)
  ),
  live as (
    select idx from per group by idx having sum(v) > 0.001
  ),
  agg as (
    select m.cls, p.code, sum(p.v) as sv
      from per p
      join live l on l.idx = p.idx
      join sp_combo_class m on m.idx = p.idx
     group by m.cls, p.code
  ),
  tot as (
    select cls, sum(sv) as s from agg group by cls
  ),
  freq as (
    select jsonb_object_agg(code, obj) as f
      from (select a.code, jsonb_object_agg(a.cls, round(a.sv / nullif(t.s, 0), 6)) as obj
              from agg a join tot t on t.cls = a.cls
             group by a.code) z
  ),
  evs as (
    select m.cls, avg(e.val::numeric) as ev
      from jsonb_array_elements_text(
             case when jsonb_typeof(v2->'hand_evs_bb') = 'array' then v2->'hand_evs_bb' else '[]'::jsonb end
           ) with ordinality e(val, ord)
      join sp_combo_class m on m.idx = e.ord - 1
      join live l on l.idx = m.idx
     where e.val is not null
     group by m.cls
  )
  select jsonb_build_object(
           'actions',        to_jsonb(codes),
           'frequencies',    coalesce((select f from freq), '{}'::jsonb),
           'hand_evs',       coalesce((select jsonb_object_agg(cls, round(ev, 6)) from evs), '{}'::jsonb),
           'ev_ip',          v2->'ev_ip_bb',
           'ev_oop',         v2->'ev_oop_bb',
           'exploitability', v2->'exploitability_pct',
           'board',          v2->'board',
           'node',           v2->'node',
           'street',         v2->'street',
           'source',         to_jsonb('pio_v2'::text),
           '__sanitized',    to_jsonb(true)
         )
    into res;

  return res;
end
$fn$;
