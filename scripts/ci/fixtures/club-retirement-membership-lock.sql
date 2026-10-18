-- Isolated retirement-core dependencies. Memberships use the real composite
-- key (club_id,user_id); no invented id may hide a production lock failure.
CREATE TABLE public.table_seats(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid);
CREATE TABLE public.tournament_players(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tournament_id uuid);
CREATE TABLE public.tournament_escrow(tournament_id uuid PRIMARY KEY,prize_balance numeric DEFAULT 0,closed_at timestamptz);
CREATE TABLE public.agents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.club_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.club_diamond_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.bbj_pools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.spin_bonus_pools(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.club_opening_setups(club_id uuid PRIMARY KEY);
CREATE TABLE public.promo_vault_inventory(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.cashout_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.chip_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.chip_escrow_holds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.tournament_tickets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.settlement_periods(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid);
CREATE TABLE public.credit_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id uuid);
CREATE TABLE public.chip_escrow(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cashout_request_id uuid);
CREATE TABLE public.audit_trail(id bigserial PRIMARY KEY,actor_id uuid,actor_role text,action text,
 target_type text,target_id uuid,club_id uuid,before_state jsonb,after_state jsonb,reason text);
