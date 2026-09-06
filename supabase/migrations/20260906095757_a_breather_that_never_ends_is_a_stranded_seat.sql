-- ═══════════════════════════════════════════════════════════════════════════
-- A BREATHER THAT NEVER ENDS IS A STRANDED SEAT (2026-09-06)
--
-- V48's last behaviour: a horse that loses 100bb+ in one hand takes an orbit
-- off, through the same public sitOut() a human's button calls.
--
-- The failure mode is not the sit-out, it is the sit-back-in. That happens on
-- a setTimeout 75 seconds later, and a timeout does not survive a container
-- replacement - server/** merges deploy, so replacements are routine. A horse
-- whose breather started 30 seconds before a deploy sits out forever: the
-- seat is held, the table is a seat short, and NOTHING says so. That is the
-- shape this estate keeps finding, so it gets a detector on the day the
-- behaviour ships rather than the week after somebody notices.
--
-- v48_sit_back_in must track v48_sit_out_after_loss. A gap is a stranded seat.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_audit_breather_returns(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  v_out bigint; v_in bigint; v_gap bigint; v_share numeric;
begin
  select coalesce(sum(fires) filter (where feature = 'v48_sit_out_after_loss'), 0),
         coalesce(sum(fires) filter (where feature = 'v48_sit_back_in'), 0)
    into v_out, v_in
    from horse_brain_telemetry where day = p_day;

  if v_out = 0 then
    -- Not a finding on its own: most horses are grinders by persona and the
    -- fleet default is 0. fn_audit_data_receipts already reports a receipt
    -- that never fires against its declared expectation.
    return v;
  end if;

  v_gap := v_out - v_in;
  v_share := round(v_gap::numeric / v_out, 3);

  if v_share > 0.10 then
    v := v || jsonb_build_object(
      'severity', case when v_share > 0.25 then 'critical' else 'warn' end,
      'category', 'logic', 'code', 'breather_never_returned',
      'title', v_gap || ' of ' || v_out || ' horse breathers did not book the seat back in',
      'evidence', jsonb_build_object('day', p_day, 'sat_out', v_out, 'came_back', v_in,
                                     'gap', v_gap, 'share', v_share),
      'recommendation', 'The return is a 75-second setTimeout in ServerTableEngineSettlement.horsesTakeABreather, and a timeout does not survive a container replacement. A horse whose breather started just before a deploy holds its seat sitting out forever. Check the day''s engine deploys against the gap; if they line up, the return needs to be driven by the table loop rather than by a timer. A seat held by a horse that will never act is worse than a seat it never took.');
  else
    v := v || jsonb_build_object('severity','info','category','logic','code','breather_returns',
      'title', v_in || ' of ' || v_out || ' horse breathers ended and the seat came back',
      'evidence', jsonb_build_object('day', p_day, 'sat_out', v_out, 'came_back', v_in, 'gap', v_gap),
      'recommendation','A horse that loses a buy-in in one hand takes an orbit off, like a person. The pair must track; a gap is a stranded seat.');
  end if;
  return v;
end $function$;

revoke all on function public.fn_audit_breather_returns(date) from public, authenticated, anon;
grant execute on function public.fn_audit_breather_returns(date) to service_role;
