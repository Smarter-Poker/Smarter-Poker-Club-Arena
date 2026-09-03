-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830192115; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- V31 FOUNDATION — decode the solver's combo index, and name a board's flush
-- suit. strategy_matrix_v2 documents its own encoding in `combo_order`:
--     card = rank*4 + suit;  combo = b*(b-1)/2 + a;  2c2d=0 .. AhAs=1325
-- rank 0..12 is 2..A, suit 0..3 is c,d,h,s. Confirmed arithmetically (AhAs =>
-- 51*50/2+50 = 1325) and empirically (the 2026-08-30 spread measurement found
-- suit index 2 to be the flush suit on a two-heart board unprompted).
-- Nothing reads these objects yet; the V31 aggregator will join them.
-- TIER 2: new objects only, nothing existing altered.

create table if not exists public.gto_combo_map (
  combo_idx  smallint primary key,
  card_a     smallint not null,
  card_b     smallint not null,
  rank_a     smallint not null,
  rank_b     smallint not null,
  suit_a     smallint not null,
  suit_b     smallint not null,
  hand_class text     not null
);

comment on table public.gto_combo_map is
  'Static decode of strategy_matrix_v2 combo indices 0..1325 into ranks, suits and the 169 hand classes. card=rank*4+suit, combo=b*(b-1)/2+a, suits c,d,h,s = 0,1,2,3. Built and asserted by 20260830c.';

truncate table public.gto_combo_map;

insert into public.gto_combo_map
  (combo_idx, card_a, card_b, rank_a, rank_b, suit_a, suit_b, hand_class)
select
  (b * (b - 1) / 2 + a)::smallint,
  a::smallint, b::smallint,
  (a / 4)::smallint, (b / 4)::smallint,
  (a % 4)::smallint, (b % 4)::smallint,
  case
    when a / 4 = b / 4
      then rc[a / 4 + 1] || rc[b / 4 + 1]
    when a / 4 > b / 4
      then rc[a / 4 + 1] || rc[b / 4 + 1] || case when a % 4 = b % 4 then 's' else 'o' end
    else rc[b / 4 + 1] || rc[a / 4 + 1] || case when a % 4 = b % 4 then 's' else 'o' end
  end
from generate_series(1, 51) b
cross join lateral generate_series(0, b - 1) a
cross join (select array['2','3','4','5','6','7','8','9','T','J','Q','K','A'] as rc) k;

do $$
declare
  v_n integer;
  v_txt text;
begin
  select count(*) into v_n from public.gto_combo_map;
  if v_n <> 1326 then
    raise exception 'gto_combo_map has % rows, expected 1326', v_n;
  end if;

  select hand_class into v_txt from public.gto_combo_map where combo_idx = 0;
  if v_txt <> '22' then
    raise exception 'combo 0 decoded as %, expected the 2c2d pair 22', v_txt;
  end if;
  perform 1 from public.gto_combo_map
    where combo_idx = 0 and card_a = 0 and card_b = 1 and suit_a = 0 and suit_b = 1;
  if not found then
    raise exception 'combo 0 is not 2c/2d';
  end if;

  select hand_class into v_txt from public.gto_combo_map where combo_idx = 1325;
  if v_txt <> 'AA' then
    raise exception 'combo 1325 decoded as %, expected AA (AhAs)', v_txt;
  end if;
  perform 1 from public.gto_combo_map
    where combo_idx = 1325 and card_a = 50 and card_b = 51
      and rank_a = 12 and rank_b = 12 and suit_a = 2 and suit_b = 3;
  if not found then
    raise exception 'combo 1325 is not Ah/As - the suit convention is not c,d,h,s';
  end if;

  select hand_class into v_txt from public.gto_combo_map where combo_idx = 51*50/2 + 47;
  if v_txt <> 'AKs' then
    raise exception 'As/Ks decoded as %, expected AKs', v_txt;
  end if;
  select hand_class into v_txt from public.gto_combo_map where combo_idx = 51*50/2 + 46;
  if v_txt <> 'AKo' then
    raise exception 'As/Kh decoded as %, expected AKo', v_txt;
  end if;

  select count(distinct hand_class) into v_n from public.gto_combo_map;
  if v_n <> 169 then
    raise exception 'gto_combo_map yields % hand classes, expected 169', v_n;
  end if;

  select count(*) into v_n from public.gto_combo_map where hand_class ~ '^(.)\1$';
  if v_n <> 78 then
    raise exception 'pair combos = %, expected 78 (13 classes x 6)', v_n;
  end if;
  select count(*) into v_n from public.gto_combo_map where hand_class like '%s';
  if v_n <> 312 then
    raise exception 'suited combos = %, expected 312 (78 classes x 4)', v_n;
  end if;
  select count(*) into v_n from public.gto_combo_map where hand_class like '%o';
  if v_n <> 936 then
    raise exception 'offsuit combos = %, expected 936 (78 classes x 12)', v_n;
  end if;

  select count(*) into v_n from generate_series(0, 1325) g
    where not exists (select 1 from public.gto_combo_map m where m.combo_idx = g);
  if v_n <> 0 then
    raise exception '% combo indices are missing from gto_combo_map', v_n;
  end if;

  select count(*) into v_n from public.gto_combo_map where card_a >= card_b;
  if v_n <> 0 then
    raise exception '% rows have card_a >= card_b', v_n;
  end if;
end $$;

-- STRICT is load-bearing: without it a NULL board falls through the empty
-- tally to the -1 default, so a row with no board would return a confident
-- "rainbow" instead of "I do not know", and the aggregator could not skip it
-- the way V30 skips a row whose texture class is null. NULL in, NULL out.
create or replace function public.fn_gto_board_flush_suit(p_board text)
returns smallint
language sql
immutable
strict
as $fn$
  with chars as (
    select case substr(lower(p_board), g * 2, 1)
             when 'c' then 0 when 'd' then 1 when 'h' then 2 when 's' then 3
             else null end as suit
    from generate_series(1, coalesce(length(p_board), 0) / 2) g
  ),
  tally as (
    select suit, count(*) as n from chars where suit is not null group by suit
  )
  select coalesce((
    select suit::smallint from tally where n >= 2 order by n desc, suit asc limit 1
  ), (-1)::smallint);
$fn$;

comment on function public.fn_gto_board_flush_suit(text) is
  'Suit index (c,d,h,s = 0..3) most present on the board, -1 if no suit appears twice, NULL if the board is NULL. The V31 suit bucket counts how many of these a combo holds.';

do $$
declare v smallint;
begin
  v := public.fn_gto_board_flush_suit('2s9sKdQs');
  if v <> 3 then raise exception '2s9sKdQs flush suit = %, expected 3 (s)', v; end if;
  v := public.fn_gto_board_flush_suit('2c4hQh');
  if v <> 2 then raise exception '2c4hQh flush suit = %, expected 2 (h)', v; end if;
  v := public.fn_gto_board_flush_suit('2c4hQd');
  if v <> -1 then raise exception '2c4hQd flush suit = %, expected -1', v; end if;
  v := public.fn_gto_board_flush_suit('');
  if v <> -1 then raise exception 'empty board flush suit = %, expected -1', v; end if;
  if public.fn_gto_board_flush_suit(null) is not null then
    raise exception 'null board must return null (function is not STRICT)';
  end if;
end $$;
