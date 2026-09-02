-- ═══════════════════════════════════════════════════════════════════════════
-- V31 FOUNDATION — decode the solver's combo index, and name a board's
-- flush suit. (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- strategy_matrix_v2 stores every action's strategy as a 1,326-long vector,
-- one slot per exact two-card combination. The payload documents its own
-- encoding in `combo_order`:
--
--     card = rank*4 + suit;  combo = b*(b-1)/2 + a;  2c2d=0 .. AhAs=1325
--
-- rank 0..12 is 2..A and suit 0..3 is c,d,h,s. That suit convention is
-- confirmed twice over: arithmetically (AhAs => 12*4+2=50, 12*4+3=51,
-- 51*50/2+50 = 1325, matching the documented endpoint) and empirically —
-- the 2026-08-30 spread measurement found suit index 2 to be the flush suit
-- on a two-heart board without being told the convention.
--
-- Nothing reads this table yet. It exists so the V31 aggregator can decode
-- 1,326 slots with a join instead of arithmetic repeated per row, and so the
-- decode is asserted ONCE, here, rather than trusted in every consumer.
--
-- WHY A SUIT BUCKET AT ALL: measured 2026-08-30, grouping the solver's 1,326
-- combos into the 169 hand classes V29/V30 use loses an average within-class
-- spread of 0.238; adding a single dimension — how many of the board's flush
-- suit the combo holds — recovers 67% of it (worst 39%, best 89%, n=83).
-- 169 x 3 cells cost ~31 MB against ~110 MB for all 1,326 combos.
--
-- TIER 2 (new objects only; nothing existing is altered, nothing reads these).
-- Applied through the Supabase MCP, which supplies the transaction; the
-- assertion blocks below abort the whole migration if the decode is wrong.

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
  'Static decode of strategy_matrix_v2 combo indices 0..1325 into ranks, '
  'suits and the 169 hand classes. card=rank*4+suit, combo=b*(b-1)/2+a, '
  'suits c,d,h,s = 0,1,2,3. Built and asserted by 20260830c.';

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

-- ── assertions: the decode is either exactly right or this migration aborts ──
do $$
declare
  v_n integer;
  v_txt text;
begin
  select count(*) into v_n from public.gto_combo_map;
  if v_n <> 1326 then
    raise exception 'gto_combo_map has % rows, expected 1326', v_n;
  end if;

  -- documented endpoints
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
    raise exception 'combo 1325 is not Ah/As — the suit convention is not c,d,h,s';
  end if;

  -- the class partition: 13 pairs + 78 suited + 78 offsuit = 169
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

  -- every index present exactly once, contiguous
  select count(*) into v_n from generate_series(0, 1325) g
    where not exists (select 1 from public.gto_combo_map m where m.combo_idx = g);
  if v_n <> 0 then
    raise exception '% combo indices are missing from gto_combo_map', v_n;
  end if;

  -- card_a is always the lower card
  select count(*) into v_n from public.gto_combo_map where card_a >= card_b;
  if v_n <> 0 then
    raise exception '% rows have card_a >= card_b', v_n;
  end if;
end $$;

-- ── the board's flush suit ───────────────────────────────────────────────
--
-- Returns the suit index (0..3) that appears most often on the board, or
-- -1 when no suit appears twice (so every combo buckets to 0 and the cell
-- degenerates to the 169-class behaviour V30 already has). Board text is
-- the scenario_hash tail / v2 `board` field: rank+suit character pairs,
-- e.g. '2s9sKdQs'.
--
-- STRICT is load-bearing, and the assertion below is why it is here: without
-- it a NULL board falls through the empty tally to the -1 default, so a row
-- with no board at all would return a confident "rainbow" instead of "I do
-- not know". The aggregator must be able to SKIP such a row, exactly as V30
-- skips a row whose texture class is null. NULL in, NULL out.
create or replace function public.fn_gto_board_flush_suit(p_board text)
returns smallint
language sql
immutable
strict
as $$
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
$$;

comment on function public.fn_gto_board_flush_suit(text) is
  'Suit index (c,d,h,s = 0..3) most present on the board, -1 if no suit '
  'appears twice. The V31 suit bucket counts how many of these a combo holds.';

do $$
declare v smallint;
begin
  v := public.fn_gto_board_flush_suit('2s9sKdQs');   -- three spades
  if v <> 3 then raise exception '2s9sKdQs flush suit = %, expected 3 (s)', v; end if;
  v := public.fn_gto_board_flush_suit('2c4hQh');     -- two hearts
  if v <> 2 then raise exception '2c4hQh flush suit = %, expected 2 (h)', v; end if;
  v := public.fn_gto_board_flush_suit('2c4hQd');     -- rainbow
  if v <> -1 then raise exception '2c4hQd flush suit = %, expected -1', v; end if;
  v := public.fn_gto_board_flush_suit('');
  if v <> -1 then raise exception 'empty board flush suit = %, expected -1', v; end if;
  if public.fn_gto_board_flush_suit(null) is not null then
    raise exception 'null board must return null';
  end if;
end $$;

-- ROLLBACK (nothing reads either object; both are new):
--   drop function if exists public.fn_gto_board_flush_suit(text);
--   drop table if exists public.gto_combo_map;
