def compose_treasury_flow(body):
 def replace(a,b):
  nonlocal body
  assert body.count(a)==1,(a[:90],body.count(a))
  body=body.replace(a,b)
 replace('SELECT q.*,f.id cash_funding_id',"SELECT q.*,gift.proof treasury_gift,returned.proof treasury_return,f.id cash_funding_id")
 prefix='FROM originals q\n  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id\n  LEFT JOIN LATERAL (' if 'bbj_wallet_matches' in body else 'FROM originals q\n  LEFT JOIN LATERAL ('
 replace(prefix,"""FROM originals q
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_gift_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category'='horse_funding'
    AND q.l->>'from_type'='club_treasury' AND q.l->>'to_type'='table_stack') gift ON true
  LEFT JOIN LATERAL (SELECT smarter_private.original_treasury_return_evidence(q.ledger_id) proof
   WHERE q.tournament_id IS NULL AND q.l->>'category' IN('cashout','table_cashout','refund')
    AND q.l->>'from_type'='table_stack' AND q.l->>'to_type'='player_wallet') returned ON true
"""+("  LEFT JOIN bbj_wallet_matches j ON j.ledger_id=q.ledger_id\n" if "bbj_wallet_matches" in body else "")+"  LEFT JOIN LATERAL (")
 replace("AND r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid","AND ((r.account_type=q.l->>'to_type' AND r.account_entity_id=(q.l->>'to_entity_id')::uuid) OR (r.operation_kind='horse_funding' AND r.account_type='club_treasury' AND r.user_id=(q.l->>'to_entity_id')::uuid AND smarter_private.cash_initial_funding_receipt(r.id)))")
 # Only a qualified initial gift is a buy-in. Ordinary treasury topups stay addons.
 body=body.replace("r.operation_kind='buyin'","smarter_private.cash_initial_funding_receipt(r.id)")
 replace("WHEN cash_funding_id IS NOT NULL THEN 'cash_funding'", "WHEN treasury_gift->>'status'='proven' THEN 'cash_funding' WHEN treasury_return->>'status'='proven' THEN 'cash_return' WHEN cash_funding_id IS NOT NULL THEN 'cash_funding'")
 replace('late_club,cash_club,',"late_club,(treasury_gift->>'earning_club')::uuid,(treasury_return->>'earning_club')::uuid,cash_club,")
 replace('late_user,cash_user,',"late_user,(treasury_gift->>'user_id')::uuid,(treasury_return->>'user_id')::uuid,cash_user,")
 replace("AND owner_club::text=l->>'club_id'", "AND (owner_club::text=l->>'club_id' OR (treasury_gift->>'status'='proven' AND treasury_gift->>'ledger_id'=ledger_id::text AND treasury_gift->>'sponsor_bank_club'=l->>'club_id' AND treasury_gift->>'earning_club'=owner_club::text))")
 replace("WHEN 'cash_funding' THEN cash_amount=(l->>'amount')::numeric", "WHEN 'cash_funding' THEN (cash_amount=(l->>'amount')::numeric OR (treasury_gift->>'status'='proven' AND (treasury_gift->>'amount')::numeric=(l->>'amount')::numeric))")
 replace("WHEN 'cash_return' THEN (", "WHEN 'cash_return' THEN ((treasury_return->>'status'='proven' AND (treasury_return->>'amount')::numeric=(l->>'amount')::numeric) OR ")
 return body
