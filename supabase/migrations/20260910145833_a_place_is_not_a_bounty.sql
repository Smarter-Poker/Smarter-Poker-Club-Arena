-- a_place_is_not_a_bounty
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE ONE DEFECT THAT KEPT TEN EVENTS FROZEN.
--
-- fn_claim_bounty_legacy_candidate_20260907 does two jobs in one call: it
-- RECORDS the elimination (status, finishing place, prize, seat closed) and it
-- SETTLES the bounty. Every gate in it returns `ok:false` for the whole call.
-- So a bounty that cannot be settled means a player who provably busted is
-- never given a finishing place, an unranked player keeps the event from
-- finishing, and the escrow - which has nothing to do with bounties - is paid
-- to nobody.
--
-- MEASURED 2026-09-10 14:33 UTC, across the ten stalled events: 62 knockout
-- candidates still `pending`, of which 33 sit behind a PKO settlement watermark
-- and 33 cannot name an exact pot claimant (some both), and only 2 are blocked
-- by neither. ZERO have a live seat, ZERO have chips again, ZERO of their hands
-- have been pruned from hand_history. Every one of them provably busted, hours
-- or days ago, and 3,600.00 of prize escrow sits behind them. Every stalled
-- event is a bounty event; non-bounty events do not stall, because the plain
-- elimination door has no claimant requirement.
--
-- BOTH RULES ARE CORRECT - FOR A BOUNTY.
-- fn_exact_tournament_knockout_claimants returns NULL rather than name someone
-- who might not have owned the knockout, and it should. The PKO watermark
-- refuses an out-of-order bounty, and it should; it cannot be rewound without
-- letting settled bounties re-settle. Neither is a statement about whether a
-- player busted.
--
-- A PLACE IS NOT A BOUNTY. A finishing place belongs to the PLAYER and is
-- knowable from the bust order. A bounty belongs to a KNOCKER and needs exact
-- evidence. Conflating them lets an unpayable 8.00 head freeze a 600.00 event.
--
-- WHAT CHANGES: the two bounty-settlement refusals (and the head-value one,
-- which is the same shape) stop returning. They set v_bounty_blocked, the
-- elimination is recorded and the place assigned exactly as before, and NO
-- obligation row is written.
--
-- WHY WRITING NO OBLIGATION IS THE RIGHT ANSWER, verified against the live
-- consumers rather than assumed:
--   * fn_tournament_has_unsettled_bounties only ever looks at obligations that
--     EXIST (state 'pending', or 'settled' without a complete marker) and at
--     tournament_bounty_awards. Nothing anywhere requires one obligation per
--     elimination. So the event can finish.
--   * the head therefore stays in tournaments.bounty_pool unpaid, which is
--     precisely what fn_finalize_bounty_pool already resolves at completion as
--     RESIDUAL, with its own completion receipt. An uncollected head already
--     had a designed home; this routes these there instead of freezing.
--   * fn_complete_tournament_terminal asserts paid <= pool and that
--     bounty_pool_paid matches the wallet evidence. It does NOT require
--     paid = pool, so an unpaid head does not block completion.
--   * tournament_bounty_obligations.state is CHECKed to ('pending','settled').
--     Inventing a third state would have meant touching that constraint and
--     every consumer of it. Not writing the row touches none of them.
--
-- WHAT DOES NOT CHANGE, and this is the part to read twice:
--   * every EVIDENCE gate still refuses - atomic_knockout_evidence_required,
--     accepted_zero_settlement_not_found, exact_knockout_history_not_found,
--     player_has_chips, status_not_claimable, the identity conflicts. Those
--     answer "did this bust happen", and without them we would be placing a
--     player on no evidence. They are asserted below to survive.
--   * the CAS on the elimination UPDATE still raises serialization_failure.
--   * the two PKO predecessor gates and the caller-supplied claimant checks
--     still apply whenever the bounty IS being settled; they are skipped only
--     when it is not, because they are rules about the ORDER OF PAYMENT and
--     there is no payment to order.
--   * nobody is paid a bounty they did not earn. The unattributed head is not
--     given to anyone here.
--
-- THE RECORD (10.9: the record is part of the fix): each unattributed head
-- writes one financial_alerts row naming the tournament, the player, the hand,
-- the place, the head value and the reason. It is severity `warning`, so
-- fn_ca_financial_alert_to_incident - which promotes only `critical` - does not
-- turn it into a board item per bust. A listed fact, not an alarm.
--
-- Asserted text substitution on the live definition: eleven anchors, each
-- required to appear EXACTLY ONCE, and post-conditions on both what must be
-- gone and what must have survived.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_pairs text[][] := ARRAY[
    -- 1. the flag itself
    ARRAY[
      E'  v_pko_watermark bigint;\nBEGIN\n',
      E'  v_pko_watermark bigint;\n  v_bounty_blocked text := NULL;\nBEGIN\n'
    ],
    -- 2. claimants that cannot be named exactly
    ARRAY[
      E'  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN\n'
      || E'    RETURN jsonb_build_object(\n'
      || E'      ''ok'',false,''reason'',''exact_pot_claimants_not_found'');\n'
      || E'  END IF;\n',
      E'  IF v_claimants IS NULL OR jsonb_array_length(v_claimants)=0 THEN\n'
      || E'    /* A PLACE IS NOT A BOUNTY (2026-09-10).\n'
      || E'       fn_exact_tournament_knockout_claimants returns NULL when it cannot\n'
      || E'       name the exact winner of the last pot the busted player was eligible\n'
      || E'       for, and it is right to refuse to guess. That is a reason not to PAY\n'
      || E'       a bounty. It is not a reason to withhold a finishing place from a\n'
      || E'       player who provably busted - refusing here left 33 busts unrecorded\n'
      || E'       across nine events and held their prize escrow for days. */\n'
      || E'    v_bounty_blocked:=''exact_pot_claimants_not_found'';\n'
      || E'    v_claimants:=''[]''::jsonb;\n'
      || E'  END IF;\n'
    ],
    -- 3. a caller-supplied knocker cannot be validated against no claimants
    ARRAY[
      E'  IF p_knocker_user_id IS NOT NULL\n     AND NOT EXISTS (\n',
      E'  IF v_bounty_blocked IS NULL AND p_knocker_user_id IS NOT NULL\n     AND NOT EXISTS (\n'
    ],
    -- 4. nor can caller-supplied claimants be compared against none
    ARRAY[
      E'  IF v_input_claimants IS NOT NULL\n     AND v_input_claimants IS DISTINCT FROM v_claimants THEN\n',
      E'  IF v_bounty_blocked IS NULL AND v_input_claimants IS NOT NULL\n     AND v_input_claimants IS DISTINCT FROM v_claimants THEN\n'
    ],
    -- 5. the PKO settlement watermark
    ARRAY[
      E'    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN\n'
      || E'      RETURN jsonb_build_object(\n'
      || E'        ''ok'',false,''reason'',''pko_order_already_advanced'',\n'
      || E'        ''last_settled_hand_number'',v_pko_watermark);\n'
      || E'    END IF;\n',
      E'    IF v_pko_watermark IS NOT NULL AND p_hand_number<v_pko_watermark THEN\n'
      || E'      /* The watermark keeps PKO bounties in payment order and cannot be\n'
      || E'         rewound without letting settled bounties re-settle, so a bust\n'
      || E'         behind it can never be paid in order. The player still busted and\n'
      || E'         the place is still theirs: record it, and leave the head in the\n'
      || E'         pool for fn_finalize_bounty_pool to resolve as residual. */\n'
      || E'      v_bounty_blocked:=COALESCE(v_bounty_blocked,''pko_order_already_advanced'');\n'
      || E'    END IF;\n'
    ],
    -- 6. a pending predecessor is an ordering rule for payment
    ARRAY[
      E'  IF v_mode=''pko'' AND EXISTS (\n    SELECT 1 FROM public.tournament_bounty_obligations prior\n',
      E'  IF v_bounty_blocked IS NULL AND v_mode=''pko'' AND EXISTS (\n    SELECT 1 FROM public.tournament_bounty_obligations prior\n'
    ],
    -- 7. so is a same-hand predecessor
    ARRAY[
      E'  IF v_mode=''pko'' AND EXISTS (\n    SELECT 1\n      FROM public.hand_history h\n',
      E'  IF v_bounty_blocked IS NULL AND v_mode=''pko'' AND EXISTS (\n    SELECT 1\n      FROM public.hand_history h\n'
    ],
    -- 8. no head value is the same shape: nothing to pay, still a place to give
    ARRAY[
      E'  IF coalesce(v_head,0)<=0 THEN\n'
      || E'    RETURN jsonb_build_object(''ok'',false,''reason'',''exact_head_value_not_found'');\n'
      || E'  END IF;\n',
      E'  IF coalesce(v_head,0)<=0 THEN\n'
      || E'    v_bounty_blocked:=COALESCE(v_bounty_blocked,''exact_head_value_not_found'');\n'
      || E'  END IF;\n'
    ],
    -- 9. the obligation is written only when the bounty is actually settleable
    ARRAY[
      E'  INSERT INTO public.tournament_bounty_obligations(\n    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,\n',
      E'  IF v_bounty_blocked IS NULL THEN\n  INSERT INTO public.tournament_bounty_obligations(\n    tournament_id,eliminated_user_id,table_id,hand_id,hand_number,\n'
    ],
    -- 10. and the unattributed head is recorded instead
    ARRAY[
      E'  RETURNING id INTO v_obligation_id;\n',
      E'  RETURNING id INTO v_obligation_id;\n'
      || E'  ELSE\n'
      || E'    /* The bust is recorded and placed above. The head could not be\n'
      || E'       attributed, so no obligation is written: fn_tournament_has_unsettled_bounties\n'
      || E'       only sees obligations that EXIST, so the event can finish, and the\n'
      || E'       head stays in tournaments.bounty_pool for fn_finalize_bounty_pool to\n'
      || E'       resolve as residual with its own completion receipt. This row is the\n'
      || E'       record that it happened - severity `warning`, so\n'
      || E'       fn_ca_financial_alert_to_incident (which promotes only `critical`)\n'
      || E'       does not raise a board item per bust. A listed fact, not an alarm. */\n'
      || E'    INSERT INTO public.financial_alerts(severity,source,message,context)\n'
      || E'    VALUES (''warning'',\n'
      || E'      ''fn_claim_tournament_bounty_elimination.bounty_head_not_attributed'',\n'
      || E'      ''A bust was recorded and placed, but its bounty head could not be ''\n'
      || E'        ||''attributed (''||v_bounty_blocked||''); the head stays in the ''\n'
      || E'        ||''bounty pool as residual.'',\n'
      || E'      jsonb_build_object(''tournament_id'',p_tournament_id,\n'
      || E'        ''eliminated_user_id'',p_eliminated_user_id,''table_id'',p_table_id,\n'
      || E'        ''hand_id'',p_hand_id,''hand_number'',p_hand_number,\n'
      || E'        ''position'',v_position,''head_amount'',round(coalesce(v_head,0),2),\n'
      || E'        ''mode'',v_mode,''reason'',v_bounty_blocked));\n'
      || E'  END IF;\n'
    ],
    -- 11. and the caller is told, in the same shape it already reads
    ARRAY[
      E'    ''ok'',true,''already'',false,''claimed'',v_claimed,''mode'',v_mode,\n',
      E'    ''ok'',true,''already'',false,''claimed'',v_claimed,''mode'',v_mode,\n    ''bounty_blocked'',v_bounty_blocked,\n'
    ]
  ];
  v_i integer;
BEGIN
  -- exactly one function of that name, or pg_get_functiondef is ambiguous and
  -- the substitution would rewrite an overload nobody looked at
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the knockout door has % definitions, expected exactly 1', v_n;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_claim_bounty_legacy_candidate_20260907 is missing';
  END IF;

  IF position('A PLACE IS NOT A BOUNTY' IN v_def) = 0 THEN
    FOR v_i IN 1 .. array_length(v_pairs, 1) LOOP
      v_n := (length(v_def) - length(replace(v_def, v_pairs[v_i][1], '')))
             / length(v_pairs[v_i][1]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'anchor % appears % times in the knockout door, expected exactly 1', v_i, v_n;
      END IF;
      v_def := replace(v_def, v_pairs[v_i][1], v_pairs[v_i][2]);
    END LOOP;
    EXECUTE v_def;

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907';
  END IF;

  -- the three bounty-settlement refusals no longer end the call
  IF position(E'''ok'',false,''reason'',''exact_pot_claimants_not_found''' IN v_def) <> 0
     OR position(E'''ok'',false,''reason'',''pko_order_already_advanced''' IN v_def) <> 0
     OR position(E'''ok'',false,''reason'',''exact_head_value_not_found''' IN v_def) <> 0 THEN
    RAISE EXCEPTION 'a bounty-settlement refusal still ends the elimination call';
  END IF;

  -- every EVIDENCE gate survives: these answer "did this bust happen"
  IF position('atomic_knockout_evidence_required' IN v_def) = 0
     OR position('accepted_zero_settlement_not_found' IN v_def) = 0
     OR position('exact_knockout_history_not_found' IN v_def) = 0
     OR position('atomic_knockout_candidate_identity_conflict' IN v_def) = 0
     OR position('player_has_chips' IN v_def) = 0
     OR position('status_not_claimable' IN v_def) = 0
     OR position('invalid_place_or_prize' IN v_def) = 0
     OR position('obligation_identity_conflict' IN v_def) = 0
     OR position('bounty elimination CAS missed after locked claim' IN v_def) = 0 THEN
    RAISE EXCEPTION 'an evidence gate was lost; a player could be placed on no proof';
  END IF;

  -- the ordering rules still apply when a bounty IS being settled
  IF position('pending_pko_predecessor' IN v_def) = 0
     OR position('same_hand_pko_predecessor' IN v_def) = 0
     OR position('invalid_knocker' IN v_def) = 0
     OR position('claimants_do_not_match_exact_pot' IN v_def) = 0 THEN
    RAISE EXCEPTION 'a bounty ordering rule was lost';
  END IF;

  -- and the flag is actually wired, not merely declared
  v_n := (length(v_def) - length(replace(v_def, 'v_bounty_blocked', ''))) / length('v_bounty_blocked');
  IF v_n < 12 THEN
    RAISE EXCEPTION 'v_bounty_blocked appears only % times; the substitution is incomplete', v_n;
  END IF;
END
$body$;

COMMIT;
