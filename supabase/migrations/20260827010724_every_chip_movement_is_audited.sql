-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827010724; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- EVERY CHIP MOVEMENT IS AUDITED
-- ═══════════════════════════════════════════════════════════════════════════
-- chip_ledger went silent on 2026-05-03 because not one of the 59 money-moving
-- functions writes to it. The obvious repair is to edit those functions. This
-- does NOT do that, on purpose: 59 hand-edits will miss some, and it does
-- nothing at all for the money path somebody writes next month.
--
-- Instead the LIVE POOL ITSELF is instrumented. club_members.chip_balance is
-- where every chip actually lives, so a row-level trigger on that column sees
-- every movement by construction -- through an RPC, through the engine,
-- through a hand-run UPDATE, through code not yet written.
--
-- THE TRIGGER CAN NEVER REFUSE THE WRITE. CLAUDE.md 11.5 settled this for
-- seat exits ("a guard that can refuse a seat exit can strand a player
-- mid-hand") and it is the same here: a guard that can block a buy-in is
-- worse than the gap it closes. Probed by forcing the insert to fail --
-- balance moved 24979 -> 25029 with 0 ledger rows written, transaction rolled
-- back. The swallow is therefore COUNTED, in ca_ledger_write_failures, so a
-- broken writer is loud without being fatal.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_ledger_write_failures (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  club_id     uuid,
  user_id     uuid,
  delta       numeric,
  sqlstate    text,
  message     text
);
COMMENT ON TABLE public.ca_ledger_write_failures IS
  'Ledger writes the club_members trigger had to swallow. The trigger must never refuse a money write, so failures land here instead of raising. Non-empty means the audit trail is losing rows: investigate immediately.';
ALTER TABLE public.ca_ledger_write_failures ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  st    text;
  msg   text;
BEGIN
  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  -- amount > 0 is a CHECK constraint on chip_ledger, and a no-op is not a
  -- movement worth recording.
  IF d = 0 THEN
    RETURN NEW;
  END IF;

  BEGIN
    /* performed_by is NOT NULL with an FK to auth.users. Engine and cron
       writes have no auth.uid(), so they are attributed to the smarterpoker
       system principal -- the same one the 2026-04-19 reconcile used. */
    actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

    /* Callers may name the movement:
         PERFORM set_config('app.ledger_category','buyin',true);
       Anything that does not is recorded as 'adjustment' -- honest about the
       fact that we saw the money move but were not told why. */
    cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet'  END,
      CASE WHEN d > 0 THEN NEW.club_id     ELSE NEW.user_id      END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury'  END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE NEW.club_id      END,
      abs(d), cat, NEW.club_id,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures
        (club_id, user_id, delta, sqlstate, message)
      VALUES (NEW.club_id, NEW.user_id, d, st, msg);
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- even the failure log must not be able to block the money.
    END;
  END;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_club_members_ledger_writer() IS
  'Writes one chip_ledger row per club_members.chip_balance change. Added 2026-08-26 after the ledger was found silent since 2026-05-03. Cannot refuse the money write; failures are counted in ca_ledger_write_failures.';

DROP TRIGGER IF EXISTS trg_club_members_audit_chip_movement ON public.club_members;
CREATE TRIGGER trg_club_members_audit_chip_movement
  AFTER UPDATE OF chip_balance ON public.club_members
  FOR EACH ROW
  WHEN (OLD.chip_balance IS DISTINCT FROM NEW.chip_balance)
  EXECUTE FUNCTION public.fn_club_members_ledger_writer();

-- ── Assertions: the migration proves its own premises or aborts. ───────────
DO $$
DECLARE v_trg int; v_fn int;
BEGIN
  SELECT count(*) INTO v_trg FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'club_members' AND t.tgname = 'trg_club_members_audit_chip_movement';
  IF v_trg <> 1 THEN RAISE EXCEPTION 'trigger not installed (found %)', v_trg; END IF;

  SELECT count(*) INTO v_fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_members_ledger_writer';
  IF v_fn <> 1 THEN RAISE EXCEPTION 'writer function missing'; END IF;

  RAISE NOTICE 'chip movement auditing is live.';
END $$;
