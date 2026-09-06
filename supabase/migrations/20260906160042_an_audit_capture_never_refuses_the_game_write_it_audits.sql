-- 20260906160042_an_audit_capture_never_refuses_the_game_write_it_audits.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- AN AUDIT CAPTURE NEVER REFUSES THE GAME WRITE IT AUDITS (2026-09-06)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MEASURED, from cash_cluster_events during the horse-launcher audit Dan
-- ordered today: 683 `controller_tick_error` rows between 11:38:37 and
-- 12:43:16 UTC, every one of them
--
--   constraint "managed_game_contract_version_game_kind_game_id_contract_ha_key"
--   for table "managed_game_contract_versions" does not exist   (42704)
--
-- `trg_tables_capture_management_contract` is an AFTER INSERT OR UPDATE
-- trigger on `public.tables`, FOR EACH ROW, with no column list and no
-- exception handling. So one wrong constraint name inside an AUDIT RECORD
-- aborted the statement of every caller that wrote a table row - and the
-- caller that matters here is `fn_cash_cluster_open_table`. For 65 minutes no
-- feeder could open anywhere on the platform, and the only trace was an error
-- row in the cluster's own log naming a table nobody debugging the fleet would
-- think to look at.
--
-- The constraint name was corrected upstream (the live function has a plain
-- INSERT again). THAT IS NOT THE FIX. The fix is that a capture failure of any
-- kind - a rename, a schema change, a lock timeout, a future column - can
-- never again refuse the game write it exists to describe. This is the
-- doctrine CLAUDE.md 11.5 already states for the seat-exit trigger: "the
-- trigger never blocks - a guard that can refuse a seat exit can strand a
-- player mid-hand", made LOUD rather than impossible. And it is 10.11: fix the
-- cause, do not merely detect it.
--
-- TWO CHANGES, one function.
--
-- 1. THE CAPTURE CANNOT RAISE. Its body is wrapped, and on any exception it
--    files a `ca_drift_incidents` row and returns NEW. The incident carries a
--    dedupe key, so 683 failures are one row with occurrences = 683 rather
--    than 683 rows. The row is filed through UPDATE-then-INSERT and NEVER
--    through `ON CONFLICT ON CONSTRAINT <name>`: naming a constraint is the
--    exact mistake this migration exists to survive, and a failure handler
--    that can itself fail is not a handler. Its own insert is wrapped too.
--
--    THE READER IS NAMED (CLAUDE.md 10.86 rule 3). `ca_detector_registry`
--    gets the source below, which puts it on `v_ca_alert_board` with an owner
--    and a 4-hour SLA beside every other detector. A RAISE WARNING goes to the
--    Postgres log as well, but the log is not the reader - the board is.
--
-- 2. A WRITE THAT CHANGES NOTHING IN THE CONTRACT DOES NO WORK. The contract
--    document is `p_row` MINUS a denylist that already contains
--    `current_players`, `status`, `lifecycle`, `role`, `main_index`,
--    `last_activity_at`, `current_hand_id`, `hand_number` and the engine-lease
--    columns - i.e. everything the engine and the cluster controller actually
--    write all day. `pg_stat_user_tables` reports 3,377,815 updates on
--    `public.tables`, and every one of them was building a document, hashing
--    it, taking `pg_advisory_xact_lock` and running an indexed SELECT before
--    discovering the hash had not moved. Comparing the two documents FIRST is
--    exactly equivalent (the hash is a pure function of the document) and
--    exits before the lock. A column list on the trigger would be the other
--    way to do it, and it is the worse way: it duplicates the denylist in a
--    second place that no test compares, so the day somebody adds a contract
--    column the trigger silently stops capturing it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy).

BEGIN;

-- The detector gets an owner and an SLA, so a capture failure is something a
-- person is answerable for rather than a warning in a log file.
INSERT INTO public.ca_detector_registry (source, owner, sla_hours, status, note)
VALUES (
  'managed_game_contract_capture',
  'managed-games',
  4,
  'active',
  'fn_capture_managed_game_contract could not write a contract version. The game write itself SUCCEEDED (the trigger no longer refuses it); what is missing is the audit row. Read metadata->>''sqlstate'' and metadata->>''message''. Filed by the trigger itself, deduped by (game_kind, sqlstate).'
)
ON CONFLICT (source) DO UPDATE
  SET owner = EXCLUDED.owner,
      sla_hours = EXCLUDED.sla_hours,
      status = 'active',
      note = EXCLUDED.note,
      updated_at = now();

CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
  v_sqlstate text;
  v_message text;
  v_dedupe text;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));

  -- ── NOTHING IN THE CONTRACT MOVED (2026-09-06) ───────────────────────────
  -- The engine and the cluster controller write `current_players`, `status`,
  -- `lifecycle`, `last_activity_at` and the lease columns thousands of times
  -- an hour, and every one of those is in the document's denylist. Comparing
  -- the documents is the same test the hash comparison below performs, minus
  -- the advisory lock and the indexed read - and it is derived from the
  -- document rather than from a second copy of the denylist, so it cannot
  -- drift the day a contract column is added.
  IF TG_OP = 'UPDATE'
     AND v_contract IS NOT DISTINCT FROM
         public.fn_managed_game_contract_document(v_kind, to_jsonb(OLD)) THEN
    RETURN NEW;
  END IF;

  -- ── THE CAPTURE CANNOT REFUSE THE WRITE IT DESCRIBES ─────────────────────
  BEGIN
    v_hash := public.fn_managed_game_contract_hash(v_contract);

    -- Updates of one physical row normally serialize already. This lock also
    -- protects repair/import paths that can publish the same logical game from
    -- separate statements before either has allocated its next version.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_kind || ':' || NEW.id::text, 0));

    SELECT contract_hash, version
      INTO v_last_hash, v_version
      FROM public.managed_game_contract_versions
     WHERE game_kind = v_kind AND game_id = NEW.id
     ORDER BY version DESC
     LIMIT 1;

    IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.managed_game_contract_versions (
      game_kind, game_id, club_id, union_id, version, contract,
      contract_hash, published_by, change_reason
    ) VALUES (
      v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
      v_contract, v_hash, auth.uid(),
      CASE
        WHEN TG_OP = 'INSERT' THEN 'created'
        WHEN auth.uid() IS NULL THEN 'system_revision'
        ELSE 'operator_revision'
      END
    );

    RETURN NEW;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_dedupe := 'contract_capture:' || v_kind || ':' || coalesce(v_sqlstate, 'unknown');

    -- The handler must not be able to fail either. A detector that raises is
    -- the defect it was written to catch, one level up.
    BEGIN
      UPDATE public.ca_drift_incidents
         SET occurrences  = occurrences + 1,
             last_seen_at = now(),
             metadata     = metadata
                            || jsonb_build_object('last_game_id', NEW.id,
                                                  'message', v_message)
       WHERE source = 'managed_game_contract_capture'
         AND dedupe_key = v_dedupe
         AND status IN ('open', 'acknowledged', 'reconciling');
      IF NOT FOUND THEN
        -- `classification` and `layer` are CHECK-constrained enums. They are
        -- read off the live catalogue, not guessed: 'contract_capture_failed'
        -- and 'schema' are NOT in either list, and writing them would have
        -- made this handler raise - the exact defect one level up, which is
        -- what the whole migration is about. `projection` is also the honest
        -- word: managed_game_contract_versions IS a projection of the game row.
        INSERT INTO public.ca_drift_incidents (
          source, dedupe_key, classification, severity, layer,
          club_id, union_id, entity_type, entity_id, suspected_cause, metadata
        ) VALUES (
          'managed_game_contract_capture', v_dedupe, 'unknown',
          'critical', 'projection',
          NEW.club_id, NEW.union_id, v_kind, NEW.id,
          'fn_capture_managed_game_contract raised ' || coalesce(v_sqlstate, '?') ||
            '. The game write SUCCEEDED; the contract version row is missing.',
          jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message,
                             'game_kind', v_kind, 'first_game_id', NEW.id,
                             'tg_op', TG_OP)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- the incident could not be filed; the WARNING below still speaks
    END;

    RAISE WARNING
      'managed game contract capture failed for % % (%): % - the % write was NOT refused; incident filed under source managed_game_contract_capture',
      v_kind, NEW.id, v_sqlstate, v_message, TG_TABLE_NAME;

    RETURN NEW;
  END;
END;
$function$;

COMMENT ON FUNCTION public.fn_capture_managed_game_contract() IS
  'Captures a managed-game contract version. NEVER raises: a failed capture files a ca_drift_incidents row under source managed_game_contract_capture and returns NEW, because an audit record must not be able to refuse the game write it describes (2026-09-06, after 683 refused cluster ticks in 65 minutes). Exits early when the contract document is unchanged, so the engine''s current_players/status churn costs no advisory lock.';

COMMIT;
