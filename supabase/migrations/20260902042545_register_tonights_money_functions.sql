-- fn_ca_money_rpc_drift is doing exactly its job: four functions that write
-- balance columns appeared tonight and none was declared. Registering them
-- with what each one is allowed to move, so the registry stays an inventory of
-- audited money paths rather than a list of things nobody got around to.

INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_ca_fund_overlay_on_lock', 'approved',
   'Trigger zz_ca_fund_overlay_on_lock. Moves the guarantee shortfall from the union bank into tournaments.prize_pool at lock time, under FOR UPDATE, all-or-nothing, and writes one descriptive chip_ledger row naming the tournament and the shortfall. Named zz_ so it sorts after the managed-game lifecycle guard.'),
  ('fn_ca_spin_cancel_returns_draw', 'approved',
   'Trigger zz_ca_spin_cancel_returns_draw. On a spin cancelled without a prize being awarded, returns the jackpot draw to spin_bonus_pools and books a surplus_return row. Credits the reserve only; never touches a player wallet.'),
  ('fn_ca_return_unawarded_spin_draws', 'approved',
   'Sweep for the same condition across history. Dry-run by default (p_apply=false); the same reserve credit and surplus_return row when applied.'),
  ('fn_spin_book_entry', 'approved',
   'Pre-existing spin reserve bookkeeping surfaced by the registry drift check. Writes spin_bonus_pools.balance and spin_reserve_ledger. Registered as an inventory entry, not a new approval.')
ON CONFLICT (proname) DO UPDATE
  SET status = EXCLUDED.status,
      notes  = EXCLUDED.notes;
