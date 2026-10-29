-- ═════════════════════════════════════════════════════════════════════
-- STACK-OFF "BLEED" IS A SUNK-COST ARTIFACT: SCORE THE RIVER DECISION
--
-- WHAT WAS WRONG
--   fn_audit_river_aggression_ev (tag_ev_negative) ranks a tagged situation by
--   the WHOLE-HAND net of the hands that carry it. For the four river
--   stack-off situations (board_paired_two_pair_stackoff,
--   one_pair_river_stackoff, top_pair_weak_kicker_stackoff,
--   river_raise_paidoff) that net includes every chip hero put in on the
--   flop and turn BEFORE the river decision. That money is sunk: it is lost
--   whether hero calls the river or folds it. Measured against folding the
--   river (2026-10-16 audit, NLH, 2-day sample, wins and losses via the _won
--   mirrors):
--
--     situation                         win%   whole-hand   river-decision
--     board_paired_two_pair_stackoff    34.5   -25.6bb      +31.6bb
--     one_pair_river_stackoff           39.5   -19.0bb      +10.8bb
--     top_pair_weak_kicker_stackoff     28.2   -31.5bb      +14.5bb
--     river_raise_paidoff               28.6   -25.6bb      -13.0bb (includes
--                                       the river bet; the call alone needs
--                                       ~27%, i.e. break-even)
--
--   So three of the four are profitable river decisions that the audit
--   scored as multi-hundred-thousand-bb leaks. Acting on that (caps, tighter
--   V51 river flat) would have made the horses worse.
--
-- WHAT THIS DOES
--   1. fn_horse_river_decision_ev(p_since) computes, from horse_hand_reviews,
--      per covered situation: win rate, whole-hand net, and the RIVER-DECISION
--      EV = net_bb + (hero chips committed before the river) / big_blind,
--      i.e. the net of the river street alone against checking or folding it.
--   2. fn_audit_river_aggression_ev now looks that number up for the covered
--      situations. A negative whole-hand EV with a river-decision EV >= 0 is
--      reported as severity info, code tag_ev_negative, with the decision EV
--      in the evidence and a recommendation that says why it is not a leak. A
--      negative river-decision EV keeps severity warn. Every other situation
--      is judged exactly as before.
--
-- LIMITS (stated so nobody over-reads the number)
--   * Showdown-only: the tags need a showdown, so folds to a river raise are
--     not in the sample. river_raise_paidoff therefore cannot be fully judged.
--   * Fold equity on jams is not modelled; the baseline is "check or fold the
--     river".
--   * Action amounts are assumed incremental chips, not raise-to totals.
--   * Sample is capped at the newest 4000 reviews per situation.
-- ═════════════════════════════════════════════════════════════════════

create or replace function public.fn_horse_river_decision_ev(p_since date)
returns table (
  situation text, hands bigint, win_rate numeric,
  whole_hand_bb numeric, river_decision_ev_bb numeric
)
language sql stable security definer set search_path = public as $$
  with base as (
    select regexp_replace(t, '_won$', '') as sit,
           r.is_win, r.net_bb, r.big_blind, r.actions, r.horse_user_id,
           row_number() over (partition by regexp_replace(t, '_won$', '')
                              order by r.created_at desc) as rn
      from horse_hand_reviews r, unnest(r.leak_tags) t
     where r.created_at >= p_since::timestamptz
       and r.big_blind > 0
       and regexp_replace(t, '_won$', '') in (
             'board_paired_two_pair_stackoff', 'one_pair_river_stackoff',
             'top_pair_weak_kicker_stackoff', 'river_raise_paidoff')
  ),
  capped as (select * from base where rn <= 4000),
  money as (
    select c.sit, c.is_win, c.net_bb, c.big_blind,
           coalesce(sum((a->>'amount')::numeric) filter (
             where a->>'stage' = 'river'
               and a->>'action' in ('call', 'bet', 'raise', 'all_in')), 0) as river_chips,
           coalesce(sum((a->>'amount')::numeric) filter (
             where a->>'action' in ('call', 'bet', 'raise', 'all_in', 'sb', 'bb', 'ante')), 0) as total_chips
      from capped c
      left join lateral jsonb_array_elements(c.actions) a
        on a->>'userId' = c.horse_user_id::text
     group by c.sit, c.is_win, c.net_bb, c.big_blind, c.rn, c.horse_user_id, c.actions
  )
  select sit,
         count(*)::bigint,
         round(avg(is_win::int)::numeric, 3),
         round(avg(net_bb)::numeric, 2),
         round(avg(net_bb + (total_chips - river_chips) / big_blind)::numeric, 2)
    from money
   group by sit;
$$;

revoke all on function public.fn_horse_river_decision_ev(date) from public, authenticated, anon;
grant execute on function public.fn_horse_river_decision_ev(date) to service_role;

create or replace function public.fn_audit_river_aggression_ev(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_dec numeric;
  v_dn bigint;
  v_ranked int := 0;
  v_sev text;
  v_rec text;
begin
  for r in
    select * from fn_horse_tag_ev(p_day - 6)
     where mirrored and hands >= 200
     order by bb_per_hand asc
  loop
    v_ranked := v_ranked + 1;
    if r.bb_per_hand < 0 then
      v_sev := case when r.net_bb < -20000 then 'warn' else 'info' end;
      v_rec := 'Both outcomes of this situation are counted, so this is EV and not a damage total. A negative number here is a real leak and a cap is worth testing: flag it, add a league matchup, and do not claim an improvement without significance.';
      v_dec := null; v_dn := null;
      select x.river_decision_ev_bb, x.hands into v_dec, v_dn from fn_horse_river_decision_ev(p_day - 2) x where x.situation = r.situation;
      if v_dec is not null then
        if v_dec >= 0 then
          v_sev := 'info';
          v_rec := 'Whole-hand EV includes chips put in before the river, which are lost whether hero calls or folds. Scored on the river decision alone this situation is not losing (river-decision EV ' || v_dec || 'bb per hand against checking or folding the river). Do not cap or tighten it on this finding.';
        else
          v_sev := 'warn';
          v_rec := 'Scored on the river decision alone this situation is still losing (river-decision EV ' || v_dec || 'bb per hand against checking or folding the river). Showdown-only sample: folds to a river raise are not counted. Flag it, add a league matchup, and do not claim an improvement without significance.';
        end if;
      end if;
      v := v || jsonb_build_object('severity', v_sev,
        'category','gto','code','tag_ev_negative',
        'title', r.situation || ' is losing ' || r.bb_per_hand || 'bb per hand over ' || r.hands || ' hands',
        'evidence', jsonb_build_object('situation', r.situation, 'hands', r.hands,
                                       'won_hands', r.won_hands, 'net_bb', r.net_bb,
                                       'bb_per_hand', r.bb_per_hand, 'win_rate', r.win_rate,
                                       'river_decision_ev_bb', v_dec,
                                       'decision_sample_hands', v_dn),
        'recommendation', v_rec);
    end if;
  end loop;

  if v_ranked = 0 then
    v := v || jsonb_build_object('severity','info','category','schema','code','tag_ev_unavailable',
      'title','No mirrored situation has 200 hands in the seven-day window',
      'evidence', jsonb_build_object('day', p_day),
      'recommendation','horse_review_rollup.leak_net_bb is written by fn_hhr_rollup_add on every review insert. If counts exist and nets do not, the rollup is running a build from before 2026-09-06.');
  else
    v := v || jsonb_build_object('severity','info','category','gto','code','tag_ev_ranked',
      'title', v_ranked || ' mirrored situations ranked by EV over seven days',
      'evidence', jsonb_build_object('situations', v_ranked, 'since', p_day - 6),
      'recommendation','Ranked by bb per hand across BOTH outcomes, which is the only honest ranking: a loss-only total ranks situations by how often they occur in big pots. The fold family has no winning mirror and is deliberately excluded - a folded hand never wins, so its total is the fold, not a leak.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_river_aggression_ev(date) from public, authenticated, anon;
grant execute on function public.fn_audit_river_aggression_ev(date) to service_role;
