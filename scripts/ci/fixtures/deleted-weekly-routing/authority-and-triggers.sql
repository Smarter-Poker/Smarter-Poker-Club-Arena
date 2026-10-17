REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz),public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_wallet_credit(),public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text),public.fn_rakeback_split_write(uuid,date,date,uuid[]),public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_wallet_credit(),public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text),public.fn_rakeback_split_write(uuid,date,date,uuid[]),public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER dr_browser BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_block_browser_balance_writes();
CREATE TRIGGER dr_lifecycle BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_guard_membership_lifecycle_write();
CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN (old.chip_balance IS DISTINCT FROM new.chip_balance) EXECUTE FUNCTION public.fn_club_members_ledger_writer();
GRANT USAGE ON SCHEMA public,auth TO authenticated;
GRANT SELECT,UPDATE ON public.club_members TO authenticated;
CREATE TRIGGER zzzz_deleted_member_credit AFTER UPDATE OF chip_balance, held_chips, locked_chips ON public.club_members FOR EACH ROW WHEN (((new.chip_balance > old.chip_balance) OR (new.held_chips < old.held_chips) OR (new.locked_chips < old.locked_chips))) EXECUTE FUNCTION fn_ca_deleted_wallet_credit();
CREATE TRIGGER zzzz_deleted_agent_credit AFTER UPDATE OF agent_wallet_balance ON public.agents FOR EACH ROW WHEN ((new.agent_wallet_balance > old.agent_wallet_balance)) EXECUTE FUNCTION fn_ca_deleted_wallet_credit();
CREATE TRIGGER zzzz_deleted_profile_bank_return AFTER UPDATE OF status ON public.profiles FOR EACH ROW WHEN (((new.status = 'deleted'::text) AND (old.status IS DISTINCT FROM 'deleted'::text))) EXECUTE FUNCTION fn_ca_deleted_wallet_credit();

-- Exact current agent financial journals; active actor/global tally remain explicit isolation boundaries.
CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON public.agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');
CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON public.agents FOR EACH ROW WHEN (((COALESCE(new.agent_wallet_balance, (0)::numeric) <> (0)::numeric) OR (COALESCE(new.promo_wallet_balance, (0)::numeric) <> (0)::numeric))) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');
