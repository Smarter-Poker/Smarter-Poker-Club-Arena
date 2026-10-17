CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SEQUENCE public.chip_ledger_chain_seq;
CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();
