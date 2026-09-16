CREATE OR REPLACE FUNCTION public.fn_union_issue_weekly_invoices(p_union_id uuid, p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notify boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_from timestamptz := COALESCE(p_start, public.fn_union_prev_week_start(now()));
  v_to   timestamptz := COALESCE(p_end,   public.fn_union_week_start(now()));
  v_due  timestamptz;
  v_union_name text;
  r record;
  v_period_id uuid;
  v_invoice_id uuid;
  v_already_sent boolean;
  v_issued int := 0;
  v_notified int := 0;
  v_notified_batch int := 0;
  v_messaged int := 0;
  v_basis_exact boolean;
  v_msg jsonb;
  v_body text;
  v_number text;
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  /* THE GUARDS LIVE HERE, NOT ONLY IN THE CASCADE (Phase 6 verification,
     20260908). The Open Claw safety net calls this function directly. */
  IF EXISTS (SELECT 1 FROM public.union_settlement_floor f
              WHERE f.union_id = p_union_id AND v_from < f.earliest_period_start) THEN
    RETURN jsonb_build_object('success', false, 'error', 'before_settlement_floor',
                              'period_start', v_from, 'period_end', v_to);
  END IF;
  IF public.fn_union_setting(p_union_id, 'weekly_invoices_enabled', 1) <> 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'weekly_invoices_disabled',
                              'period_start', v_from, 'period_end', v_to);
  END IF;
  -- A statement says "rakeback already moved in chips". It is issued only for a
  -- period whose round 1 is final, and then it reads that round's own rows.
  IF NOT EXISTS (SELECT 1 FROM public.ca_settlements s
                  WHERE s.settlement_type = 'union_rakeback_close' AND s.union_id = p_union_id
                    AND s.state = 'final'
                    AND s.external_ref = p_union_id::text || ':'
                      || to_char(v_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
                      || to_char(v_to   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_not_closed',
                              'period_start', v_from, 'period_end', v_to);
  END IF;

  v_due := v_to + interval '3 days';
  SELECT u.name INTO v_union_name FROM unions u WHERE u.id = p_union_id;

  -- Is the seated-stack baseline this week's ECO rests on an exact one?
  SELECT bool_and(COALESCE(e.baseline_cash_exact, false))
    INTO v_basis_exact
    FROM fn_union_eco_adjustment(p_union_id, v_from, v_to) e;
  v_basis_exact := COALESCE(v_basis_exact, false);

  FOR r IN SELECT * FROM fn_union_club_invoice(p_union_id, v_from, v_to) LOOP
    v_msg := NULL;
    v_invoice_id := NULL;
    v_already_sent := false;

    SELECT sp.id INTO v_period_id
      FROM settlement_periods sp
     WHERE sp.club_id = r.club_id AND sp.union_id = p_union_id
       AND sp.start_at = v_from AND sp.end_at = v_to
     ORDER BY sp.created_at DESC LIMIT 1;

    IF v_period_id IS NULL THEN
      INSERT INTO settlement_periods (club_id, union_id, period_number, year,
                                      start_at, end_at, status)
      VALUES (r.club_id, p_union_id,
              EXTRACT(week FROM v_from)::int, EXTRACT(isoyear FROM v_from)::int,
              v_from, v_to, 'processing')
      RETURNING id INTO v_period_id;
    END IF;

    -- Reuse the number this document already carries. Take a new one ONLY
    -- when there is no document yet: the upsert below may take the ON
    -- CONFLICT path, and a number taken and not used is a gap in the series.
    SELECT si.invoice_number INTO v_number
      FROM settlement_invoices si
     WHERE si.club_id = r.club_id AND si.period_id = v_period_id
       AND si.invoice_type = 'union_weekly_squareup';
    IF NOT FOUND THEN
      v_number := public.fn_next_invoice_number(p_union_id, now());
    END IF;

    INSERT INTO settlement_invoices (
      club_id, period_id, invoice_type, invoice_number,
      from_entity_type, from_entity_id, to_entity_type, to_entity_id,
      gross_amount, net_amount, deductions, breakdown, status,
      chips_transferred, due_at, notes)
    VALUES (
      r.club_id, v_period_id, 'union_weekly_squareup', v_number,
      CASE WHEN r.outstanding >= 0 THEN 'union' ELSE 'club' END,
      CASE WHEN r.outstanding >= 0 THEN p_union_id::text ELSE r.club_id::text END,
      CASE WHEN r.outstanding >= 0 THEN 'club'  ELSE 'union' END,
      CASE WHEN r.outstanding >= 0 THEN r.club_id::text ELSE p_union_id::text END,
      abs(r.outstanding), abs(r.outstanding), 0,
      jsonb_build_object(
        'union_id', p_union_id, 'union_name', v_union_name,
        'club_id', r.club_id, 'club_name', r.club_name,
        'period_start', r.period_start, 'period_end', r.period_end,
        'rake_generated', r.rake_generated,
        'union_fee_kept', r.union_fee_kept,
        'rakeback_due',   r.rakeback_due,
        'players_won',    r.players_won,
        'player_pnl_net', r.player_pnl_net,
        'eco_amount',     r.eco_amount,
        'eco_enabled',    r.eco_enabled,
        'presettled',     r.presettled,
        'settled_in_chips', r.settled_in_chips,
        'outstanding',    r.outstanding,
        'net_position',   r.net_position,
        'direction',      r.direction,
        'baseline_cash_exact', v_basis_exact,
        'computed_at',    now()),
      'generated', false, v_due,
      'Weekly union square-up. settled_in_chips already moved during the week; '
      || 'outstanding is the amount to settle.')
    ON CONFLICT (club_id, period_id, invoice_type)
      WHERE invoice_type = 'union_weekly_squareup'
    DO UPDATE SET
      from_entity_type = EXCLUDED.from_entity_type,
      from_entity_id   = EXCLUDED.from_entity_id,
      to_entity_type   = EXCLUDED.to_entity_type,
      to_entity_id     = EXCLUDED.to_entity_id,
      gross_amount     = EXCLUDED.gross_amount,
      net_amount       = EXCLUDED.net_amount,
      invoice_number   = COALESCE(settlement_invoices.invoice_number, EXCLUDED.invoice_number),
      breakdown        = EXCLUDED.breakdown,
      due_at           = EXCLUDED.due_at,
      updated_at       = now()
    WHERE COALESCE(settlement_invoices.message_sent, false) = false
    RETURNING id, COALESCE(message_sent, false) INTO v_invoice_id, v_already_sent;

    -- The upsert returns nothing when the guard above refused to restate an
    -- already-delivered invoice. That row is the record; read it as it stands.
    IF v_invoice_id IS NULL THEN
      SELECT si.id, COALESCE(si.message_sent, false)
        INTO v_invoice_id, v_already_sent
        FROM settlement_invoices si
       WHERE si.club_id = r.club_id
         AND si.period_id = v_period_id
         AND si.invoice_type = 'union_weekly_squareup';
    END IF;

    v_issued := v_issued + 1;

    IF p_notify AND NOT v_already_sent THEN
      INSERT INTO notifications (user_id, type, title, message, data, read)
      SELECT DISTINCT u.uid, 'union_invoice',
             v_union_name || ' weekly statement',
             CASE
               WHEN r.outstanding > 0 THEN
                 v_union_name || ' owes ' || r.club_name || ' '
                 || to_char(abs(r.outstanding), 'FM999,999,999,990.00') || ' for the week.'
               WHEN r.outstanding < 0 THEN
                 r.club_name || ' owes ' || v_union_name || ' '
                 || to_char(abs(r.outstanding), 'FM999,999,999,990.00') || ' for the week.'
               ELSE
                 r.club_name || ' is square with ' || v_union_name || ' for the week.'
             END,
             jsonb_build_object('invoice_id', v_invoice_id, 'club_id', r.club_id,
                                'union_id', p_union_id,
                                'period_start', r.period_start, 'period_end', r.period_end,
                                'outstanding', r.outstanding, 'due_at', v_due,
                                'source', 'club_arena'),
             false
        FROM (
          SELECT c.owner_id AS uid FROM clubs c WHERE c.id = r.club_id AND c.owner_id IS NOT NULL
          UNION
          SELECT cm.user_id FROM club_members cm
           WHERE cm.club_id = r.club_id AND cm.role IN ('owner','co_owner','admin')
             AND COALESCE(cm.status,'active') NOT IN ('banned','suspended')
        ) u
       WHERE u.uid IS NOT NULL;
      GET DIAGNOSTICS v_notified_batch = ROW_COUNT;
      v_notified := v_notified + v_notified_batch;
    END IF;

    -- CLUB MESSENGER. Only once per invoice: message_sent is the guard.
    IF NOT v_already_sent THEN
      v_body :=
        v_union_name || ' weekly statement' || E'\n'
        || to_char(r.period_start, 'YYYY-MM-DD') || ' to ' || to_char(r.period_end, 'YYYY-MM-DD')
        || E'\n\n'
        || 'Rake generated       ' || to_char(r.rake_generated,   'FM999,999,999,990.00') || E'\n'
        || 'Your rakeback (90%)  ' || to_char(r.rakeback_due,     'FM999,999,999,990.00') || E'\n'
        || 'Union fee kept       ' || to_char(r.union_fee_kept,   'FM999,999,999,990.00') || E'\n'
        || 'Player win/loss      ' || to_char(r.players_won,      'FM999,999,999,990.00') || E'\n'
        || 'Settled in chips     ' || to_char(r.settled_in_chips, 'FM999,999,999,990.00') || E'\n'
        || CASE WHEN r.eco_enabled
                THEN 'ECO adjustment       ' || to_char(r.eco_amount, 'FM999,999,999,990.00') || E'\n'
                ELSE '' END
        || CASE WHEN COALESCE(r.presettled, 0) <> 0
                THEN 'Payments received    ' || to_char(r.presettled, 'FM999,999,999,990.00') || E'\n'
                ELSE '' END
        || E'\n'
        || CASE
             WHEN r.outstanding < 0 THEN 'AMOUNT DUE ' || to_char(abs(r.outstanding), 'FM999,999,999,990.00')
             WHEN r.outstanding > 0 THEN 'OWED TO YOU ' || to_char(abs(r.outstanding), 'FM999,999,999,990.00')
             ELSE 'SQUARE FOR THE WEEK'
           END
        || CASE WHEN r.outstanding <> 0
                THEN E'\n' || 'Due ' || to_char(v_due, 'YYYY-MM-DD')
                ELSE '' END
        || E'\n\n'
        || 'Player win/loss and rakeback already moved in chips during the week. '
        || 'The amount above is what is left to square up.'
        || CASE WHEN r.eco_enabled AND NOT v_basis_exact
                THEN E'\n\n'
                     || 'PROVISIONAL. The ECO adjustment on this statement was '
                     || 'calculated without an exact opening seated-stack figure '
                     || 'for the period, so it is subject to correction. Raise it '
                     || 'with the union if it looks wrong.'
                ELSE '' END;

      v_msg := fn_union_send_club_message(
        p_union_id, r.club_id, v_body,
        jsonb_build_object(
          'kind', 'union_invoice',
          'invoice_id', v_invoice_id,
          'union_id', p_union_id,
          'club_id', r.club_id,
          'period_start', r.period_start,
          'period_end', r.period_end,
          'due_at', v_due,
          'outstanding', r.outstanding,
          'direction', r.direction,
          'baseline_cash_exact', v_basis_exact,
          'lines', jsonb_build_object(
            'rake_generated', r.rake_generated,
            'rakeback_due', r.rakeback_due,
            'union_fee_kept', r.union_fee_kept,
            'players_won', r.players_won,
            'settled_in_chips', r.settled_in_chips,
            'eco_amount', r.eco_amount,
            'eco_enabled', r.eco_enabled,
            'presettled', r.presettled)),
        'invoice');

      IF COALESCE((v_msg->>'delivered')::int, 0) > 0 THEN
        v_messaged := v_messaged + (v_msg->>'delivered')::int;
        UPDATE settlement_invoices
           SET message_sent = true, message_sent_at = now()
         WHERE id = v_invoice_id;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'club_id', r.club_id, 'club_name', r.club_name,
      'invoice_id', v_invoice_id, 'outstanding', r.outstanding,
      'direction', r.direction, 'due_at', v_due,
      'messaged', COALESCE((v_msg->>'delivered')::int, 0),
      'already_sent', v_already_sent));
  END LOOP;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to, 'due_at', v_due,
    'baseline_cash_exact', v_basis_exact,
    'invoices', v_issued, 'notified', v_notified, 'messenger_deliveries', v_messaged,
    'detail', v_out);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_send_club_message(p_union_id uuid, p_club_id uuid, p_content text, p_metadata jsonb DEFAULT '{}'::jsonb, p_message_type text DEFAULT 'text'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sender      uuid;
  v_union_name  text;
  v_union_page  uuid;
  v_club_page   uuid;
  v_conv        uuid;
  v_title       text;
  v_msg_id      uuid;
  v_recipients  int := 0;
  r             record;
BEGIN
  SELECT u.owner_id, u.name INTO v_sender, v_union_name
    FROM unions u WHERE u.id = p_union_id;
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union has no owner to send as');
  END IF;

  SELECT sp.id INTO v_union_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_union_id::text AND sp.linked_entity_type = 'club' LIMIT 1;
  SELECT sp.id INTO v_club_page FROM social_pages sp
   WHERE sp.linked_entity_id = p_club_id::text AND sp.linked_entity_type = 'club' LIMIT 1;

  v_title := COALESCE(v_union_name, 'Union') || ' Statements';

  SELECT c.id INTO v_conv
    FROM social_conversations c
   WHERE c.is_group = true
     AND c.group_name = v_title
     AND c.context_entity_id IS NOT DISTINCT FROM v_club_page
   ORDER BY c.created_at ASC
   LIMIT 1;

  IF v_conv IS NULL THEN
    INSERT INTO social_conversations (is_group, group_name, context_entity_id, context_entity_type)
    VALUES (true, v_title, v_club_page, CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    RETURNING id INTO v_conv;
  END IF;

  -- RECIPIENTS FIRST, seated under the CLUB identity.
  FOR r IN
    SELECT DISTINCT x.uid
      FROM (
        SELECT c.owner_id AS uid FROM clubs c
         WHERE c.id = p_club_id AND c.owner_id IS NOT NULL
        UNION
        SELECT cm.user_id FROM club_members cm
         WHERE cm.club_id = p_club_id
           AND cm.role IN ('owner','co_owner','admin')
           AND COALESCE(cm.status,'active') NOT IN ('banned','suspended')
      ) x
     WHERE x.uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = x.uid)
  LOOP
    INSERT INTO social_conversation_participants
      (conversation_id, user_id, context_entity_id, context_entity_type)
    VALUES (v_conv, r.uid, v_club_page,
            CASE WHEN v_club_page IS NULL THEN NULL ELSE 'club' END)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
    v_recipients := v_recipients + 1;
  END LOOP;

  IF v_recipients = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'club has no owner or admin with a profile',
                              'conversation_id', v_conv);
  END IF;

  -- The union owner joins under the UNION identity only if they are not
  -- already seated as a club recipient (one row per user is enforced).
  INSERT INTO social_conversation_participants
    (conversation_id, user_id, context_entity_id, context_entity_type)
  VALUES (v_conv, v_sender, v_union_page,
          CASE WHEN v_union_page IS NULL THEN NULL ELSE 'club' END)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  INSERT INTO social_messages (conversation_id, sender_id, content, message_type, media_metadata)
  VALUES (v_conv, v_sender, p_content,
          COALESCE(NULLIF(p_message_type, ''), 'text'),
          CASE WHEN p_metadata = '{}'::jsonb OR p_metadata IS NULL THEN NULL ELSE p_metadata END)
  RETURNING id INTO v_msg_id;

  UPDATE social_conversations
     SET last_message_at = now(),
         last_message_preview = left(regexp_replace(p_content, E'\\s+', ' ', 'g'), 100),
         updated_at = now()
   WHERE id = v_conv;

  RETURN jsonb_build_object('success', true, 'delivered', v_recipients,
                            'conversation_id', v_conv, 'message_id', v_msg_id,
                            'club_page', v_club_page, 'union_page', v_union_page);
END;
$function$;
