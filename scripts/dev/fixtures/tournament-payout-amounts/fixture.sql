-- Deliberately narrow input shapes. No production rows, money helpers,
-- triggers, foreign keys, or lifecycle constraints are substituted or claimed.
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, prize_pool numeric, payout_structure jsonb,
  variant text, tournament_type text, is_premium_spin boolean,
  spin_multiplier numeric, buy_in_amount numeric, satellite_target_id uuid,
  satellite_target uuid, bubble_protection boolean
);
CREATE TABLE public.tournament_players (tournament_id uuid);
