-- CASHIER AND TICKETS REBUILD

-- 1. tournament_tickets table
CREATE TABLE IF NOT EXISTS public.tournament_tickets (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    club_id uuid NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
    issuer_id uuid NOT NULL REFERENCES auth.users(id),
    holder_id uuid NOT NULL REFERENCES auth.users(id),
    value numeric NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'cancelled')),
    note text,
    created_at timestamptz DEFAULT now(),
    redeemed_at timestamptz
);

ALTER TABLE public.tournament_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "View tickets" ON public.tournament_tickets FOR SELECT TO authenticated
  USING (auth.uid() = issuer_id OR auth.uid() = holder_id OR EXISTS (
    SELECT 1 FROM public.club_members WHERE club_id = tournament_tickets.club_id AND user_id = auth.uid() AND role IN ('owner', 'admin')
  ));

-- 2. fn_issue_tournament_ticket
CREATE OR REPLACE FUNCTION public.fn_issue_tournament_ticket(
  p_club_id uuid,
  p_holder_id uuid,
  p_value numeric,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_issuer uuid := auth.uid();
  v_issuer_role text;
  v_issuer_bal numeric;
  v_holder_role text;
  v_ticket_id uuid;
BEGIN
  IF v_issuer IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not authenticated'); END IF;
  IF p_value <= 0 THEN RETURN jsonb_build_object('success', false, 'error', 'value must be > 0'); END IF;
  
  -- Issuer check
  SELECT role, coalesce(chip_balance, 0) INTO v_issuer_role, v_issuer_bal
  FROM club_members WHERE club_id = p_club_id AND user_id = v_issuer AND status = 'active' FOR UPDATE;
  IF v_issuer_role IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'you are not an active member'); END IF;
  IF v_issuer_bal < p_value THEN RETURN jsonb_build_object('success', false, 'error', 'insufficient chips'); END IF;

  -- Holder check
  SELECT role INTO v_holder_role FROM club_members WHERE club_id = p_club_id AND user_id = p_holder_id AND status = 'active';
  IF v_holder_role IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'recipient is not an active member'); END IF;

  -- Escrow chips from issuer
  UPDATE club_members SET chip_balance = chip_balance - p_value, updated_at = now()
  WHERE club_id = p_club_id AND user_id = v_issuer;

  INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
  VALUES (p_club_id, v_issuer, p_club_id, p_value, 'ticket_issue', coalesce(p_note, 'Ticket Issued'), v_issuer_bal - p_value);

  -- Create ticket
  INSERT INTO tournament_tickets (club_id, issuer_id, holder_id, value, note)
  VALUES (p_club_id, v_issuer, p_holder_id, p_value, p_note)
  RETURNING id INTO v_ticket_id;

  RETURN jsonb_build_object('success', true, 'ticket_id', v_ticket_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_issue_tournament_ticket(uuid, uuid, numeric, text) TO authenticated;

