ALTER TABLE public.tournament_players ADD COLUMN club_id uuid;
ALTER TABLE public.ca_hand_transfers ADD COLUMN hand_id uuid;
CREATE TABLE public.cash_participant_funding_receipts(
 id uuid PRIMARY KEY, operation_kind text,table_id uuid,account_entity_id uuid,
 funding_club_id uuid,seat_joined_at timestamptz,recorded_at timestamptz);
CREATE TABLE public.rake_attributions(hand_id uuid,player_id uuid,club_id uuid);
