-- Three exact relevant catalog rows from the preserved captured-store-policy.sql.
-- Catalog policy only: no users, balances, new policy definitions or functions.
INSERT INTO public.ca_chip_store_coverage
SELECT * FROM jsonb_populate_recordset(NULL::public.ca_chip_store_coverage,
  '[{"added_at": "2026-09-11 16:10:27.128168+00", "counted_by": "treasuries", "notes": "clubs chip_treasury", "store": "club_treasury", "treatment": "counted"}, {"added_at": "2026-09-11 16:10:27.128168+00", "counted_by": null, "notes": "issuance held before it enters circulation", "store": "issuance_reserve", "treatment": "noncirculating"}, {"added_at": "2026-09-11 16:10:27.128168+00", "counted_by": "member_wallets + member_promo", "notes": "club_members chip_balance and promo_balance", "store": "player_wallet", "treatment": "counted"}]'::jsonb);
