-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826212645; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- STOP POINTING AT THE LEGACY users TABLE, AND DROP TWO DEAD ONES
--
-- Dan 2026-08-26: "ANYTHING THATS POINT TO AN [OLD] TABLE OR PAGE, CAN AND
-- SHOULD BE DELETED."
--
-- public.users is a legacy shadow identity table. Signup writes public.profiles
-- and has for a long time; public.users only stays populated because a mirror
-- trigger was added this morning to stop 29 real accounts being unable to join
-- a club. Eight foreign keys still checked it. Six of them repoint cleanly to
-- profiles, verified row by row before this ran:
--
--   clubs.owner_id                    3 rows, 0 would break
--   commission_rate_audit.changed_by  0 rows
--   hand_actions.player_id            0 rows
--   rake_attributions.player_id       0 rows
--   rake_rate_audit.changed_by        0 rows
--   tournament_waitlists.user_id      0 rows
--
-- The seventh, player_wallets.user_id, is the only one that would have broken:
-- all 6 of its rows are PlayerOne..PlayerSix seed accounts from 2026-01-07 that
-- exist in neither profiles nor auth.users. Nothing in the codebase reads
-- player_wallets - not one reference in src/ or server/src - so the table goes
-- rather than the constraint.
--
-- club_invites goes too: zero rows, and its single writer (PlayerInviteModal's
-- "Generate Invite Code") was replaced with the redeemable link earlier today.
-- Nothing ever read it, so any code it generated could never be redeemed.
--
-- WHAT IS DELIBERATELY LEFT ALONE, and why - because "delete the old table" is
-- the instruction and these two look like they qualify:
--
--   public.users ITSELF still stands. Three client files still WRITE it
--   (AuthPage, ProfilePage, CompleteProfileModal) and 1,037 of its 2,059 rows
--   are not in profiles. Removing it is a separate change that has to fix those
--   writers first; doing it in the same breath as the constraints would take a
--   live signup path down with it.
--
--   public.wallets is NOT dead. CLAUDE.md says "nothing reads it", and that is
--   wrong: PlayerSearch, ChipTransferModal, SettingsPage, TablePage and
--   ChipFlowService all read it, and it holds 1,852 rows plus a RESTRICT
--   foreign key from chip_escrow_holds. Whatever its chip pool status, the
--   table is load-bearing in the client today.
--
-- ROLLBACK
--   ALTER TABLE public.clubs DROP CONSTRAINT clubs_owner_id_fkey;
--   ALTER TABLE public.clubs ADD CONSTRAINT clubs_owner_id_fkey
--     FOREIGN KEY (owner_id) REFERENCES public.users(id);
--   ...and the same shape for the other five. The two dropped tables are
--   recreatable from this file's history; both were empty of anything live.

DO $$
DECLARE
  v_broken int;
BEGIN
  SELECT count(*) INTO v_broken FROM public.clubs c
   WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = c.owner_id);
  IF v_broken > 0 THEN
    RAISE EXCEPTION '% club owners are not in profiles - repointing would fail', v_broken;
  END IF;

  IF (SELECT count(*) FROM public.club_invites) > 0 THEN
    RAISE EXCEPTION 'club_invites is no longer empty - something started using it';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.player_wallets pw
     WHERE EXISTS (SELECT 1 FROM auth.users a WHERE a.id = pw.user_id)
  ) THEN
    RAISE EXCEPTION 'player_wallets now holds a row for a real auth user - do not drop it';
  END IF;
END $$;

-- ── The six clean repoints ──────────────────────────────────────────────────
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_owner_id_fkey;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.profiles(id);

ALTER TABLE public.commission_rate_audit DROP CONSTRAINT IF EXISTS commission_rate_audit_changed_by_fkey;
ALTER TABLE public.commission_rate_audit
  ADD CONSTRAINT commission_rate_audit_changed_by_fkey
  FOREIGN KEY (changed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.hand_actions DROP CONSTRAINT IF EXISTS hand_actions_player_id_fkey;
ALTER TABLE public.hand_actions
  ADD CONSTRAINT hand_actions_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.rake_attributions DROP CONSTRAINT IF EXISTS rake_attributions_player_id_fkey;
ALTER TABLE public.rake_attributions
  ADD CONSTRAINT rake_attributions_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.rake_rate_audit DROP CONSTRAINT IF EXISTS rake_rate_audit_changed_by_fkey;
ALTER TABLE public.rake_rate_audit
  ADD CONSTRAINT rake_rate_audit_changed_by_fkey
  FOREIGN KEY (changed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.tournament_waitlists DROP CONSTRAINT IF EXISTS tournament_waitlists_user_id_fkey;
ALTER TABLE public.tournament_waitlists
  ADD CONSTRAINT tournament_waitlists_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- ── The two dead tables ─────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.player_wallets;
DROP TABLE IF EXISTS public.club_invites;

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE
  v_left int;
  v_names text;
BEGIN
  SELECT count(*), string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO v_left, v_names
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'public.users'::regclass;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'still % foreign keys pointing at public.users: %', v_left, v_names;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name IN ('player_wallets','club_invites')) THEN
    RAISE EXCEPTION 'a dead table survived the drop';
  END IF;

  -- The repoints must actually point at profiles, not merely exist.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN ('clubs_owner_id_fkey','hand_actions_player_id_fkey',
                       'rake_attributions_player_id_fkey','tournament_waitlists_user_id_fkey',
                       'commission_rate_audit_changed_by_fkey','rake_rate_audit_changed_by_fkey')
       AND confrelid <> 'public.profiles'::regclass
  ) THEN
    RAISE EXCEPTION 'a repointed foreign key does not reference profiles';
  END IF;
END $$;

