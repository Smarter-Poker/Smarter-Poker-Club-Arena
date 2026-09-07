-- Union statements retain opening balances and enforce existing finance access.
-- Filtering source entries before SUM discarded the prior debt or credit.
-- An authenticated EXECUTE grant exposed this SECURITY DEFINER read without
-- an actor check. Reuse ca_can_view_club_finances, ca_can_oversee_union and
-- fn_is_platform_admin; do not invent a new role matrix.
-- Stable row IDs disambiguate equal timestamp/reference entries.
-- No financial rows or historical document statuses change.
BEGIN;
DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_union_club_statement_of_account(uuid,uuid,timestamptz)'::regprocedure))
      <> '0a50cd459368ac935bccea6432e722d8' THEN
    RAISE EXCEPTION 'Union statement changed since audit; re-read before applying';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_union_club_statement_of_account(p_union_id uuid, p_club_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(entry_at timestamp with time zone, entry_type text, reference text, description text, amount numeric, running_balance numeric, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH entries AS (
    -- Weekly square-ups and the credit notes that adjust them. Positive means
    -- the club owes the union, so the direction of the document decides sign,
    -- and a credit note reverses that direction and therefore the sign.
    SELECT si.created_at AS entry_at,
           CASE WHEN si.invoice_type = 'union_weekly_credit_note'
                THEN 'credit_note' ELSE 'statement' END AS entry_type,
           COALESCE(si.invoice_number, si.id::text) AS reference,
           CASE WHEN si.invoice_type = 'union_weekly_credit_note'
                THEN 'Credit note against ' || COALESCE(si.breakdown->>'credit_note_for', '(unknown)')
                     || COALESCE(' - ' || (si.breakdown->>'reason'), '')
                ELSE 'Weekly statement '
                     || COALESCE(to_char((si.breakdown->>'period_start')::timestamptz, 'YYYY-MM-DD'), '?')
                     || ' to '
                     || COALESCE(to_char((si.breakdown->>'period_end')::timestamptz, 'YYYY-MM-DD'), '?')
                END AS description,
           CASE WHEN si.from_entity_type = 'club'
                THEN  si.net_amount
                ELSE -si.net_amount END AS amount,
           si.status, si.id AS entry_id
      FROM settlement_invoices si
     WHERE si.club_id = p_club_id
       AND si.invoice_type IN ('union_weekly_squareup', 'union_weekly_credit_note')
       AND (si.breakdown->>'union_id')::uuid = p_union_id

    UNION ALL

    -- Money the club has actually handed over reduces what it owes.
    SELECT p.received_at,
           'payment',
           COALESCE(p.reference, p.id::text),
           'Payment received'
             || COALESCE(' by ' || p.method, '')
             || CASE WHEN p.applied_settlement_id IS NULL THEN ' (unapplied)' ELSE '' END,
           -p.amount,
           CASE WHEN p.applied_settlement_id IS NULL THEN 'unapplied' ELSE 'applied' END, p.id
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.club_id = p_club_id
  )
  SELECT b.entry_at, b.entry_type, b.reference, b.description,
         b.amount, b.running_balance, b.status
    FROM (
      SELECT e.entry_at, e.entry_type, e.reference, e.description,
             round(e.amount, 2) AS amount,
             round(SUM(e.amount) OVER (ORDER BY e.entry_at, e.reference, e.entry_type, e.entry_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2) AS running_balance,
             e.status, e.entry_id
        FROM entries e
    ) b
   -- Filter the display only after computing the complete account balance.
   WHERE (p_since IS NULL OR b.entry_at >= p_since)
     AND (COALESCE(public.ca_can_view_club_finances(p_club_id), false)
          OR COALESCE(public.ca_can_oversee_union(p_union_id), false)
          OR COALESCE(public.fn_is_platform_admin(), false))
   ORDER BY b.entry_at, b.reference, b.entry_type, b.entry_id;
$function$;

COMMIT;
