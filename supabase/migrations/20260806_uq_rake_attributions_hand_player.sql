-- Audit Wave 1, finding M2 (residual): rake_attributions had NO uniqueness
-- guard. A replayed hand-complete could insert a second attribution row per
-- (hand_id, player_id), which downstream becomes double rakeback and double
-- agent commission.
--
-- The canonical production rake writer, atomic_distribute_rake, is already
-- fully idempotent (ON CONFLICT (hand_id) DO NOTHING on rake_records plus
-- per-leg claims in rake_distribution_legs), and rake_attributions is not
-- currently written by any live path (0 rows). This index makes the durable
-- layer safe regardless of which client version is deployed, so the hole
-- cannot be reopened by wiring up CommissionService.attributeRake later.

CREATE UNIQUE INDEX IF NOT EXISTS uq_rake_attributions_hand_player
  ON public.rake_attributions (hand_id, player_id);

COMMENT ON INDEX public.uq_rake_attributions_hand_player IS
  'Audit M2: one rake attribution per (hand, player). Writers must upsert with ON CONFLICT DO NOTHING so a replayed hand-complete is a no-op, never a double credit.';
