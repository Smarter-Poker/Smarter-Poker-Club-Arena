# A shaped escrow hand compares its own shape (2026-10-15)

## What happened

The original week (union fade0000, 2026-10-05 to 2026-10-12) could never certify its club P&L. `fn_union_pnl_week_hand_lines` raises `posthand_escrow_projection_touch_disagrees` for table 1c531058, hand 31008564 (2026-10-10 18:23 UTC). That hand is the only one on the platform with a posthand escrow certificate.

## Cause

`fn_union_pnl_cash_outcome_touch_row` writes each touch row's participants through `fn_union_pnl_compact_participants` (user_id, earning_club_id, observed_stack_delta). `fn_union_pnl_posthand_escrow_touch` compared that compact array with the outcome's full participants, which also carry is_horse, ownership_scope, funding_receipt_ids and ownership_certified. The two arrays can never be equal, so every shaped escrow hand was refused, however correct it was. The existing fixture only exercised the refusals, never the passing case.

## Fix

Migration `20261015060505_a_shaped_escrow_hand_compares_its_own_shape.sql` compares the touch with `fn_union_pnl_compact_participants(o.evidence->'participants')`, the shape the touch was written in.

Proved in production with a pg_temp successor:

- the real hand passes and returns its escrow participants;
- a forged delta is still refused;
- a NULL touch is still refused;
- a shifted recognized_at is still refused.

Preimage `ea07d6fa…`, postimage `e51decda…`. Owner, security definer, config and ACL are unchanged. The function is not part of the original-inventory source pins, so the inventory generation does not change.
