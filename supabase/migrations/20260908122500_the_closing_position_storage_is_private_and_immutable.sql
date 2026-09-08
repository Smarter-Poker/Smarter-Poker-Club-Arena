/*
 * The same public-schema defaults that opened the closing-position RPCs also
 * gave anon and authenticated direct privileges on the evidence table and its
 * bigserial sequence.  RLS happened to block table rows, but a durable boundary
 * does not depend on one policy, and the sequence remained directly mutable.
 *
 * Remove every browser grant, reduce service_role to read-only evidence access,
 * leave sequence ownership with postgres, and make the immutable trigger refuse
 * TRUNCATE as well as UPDATE and DELETE.  The capture RPC is SECURITY DEFINER,
 * so it retains its intentional insert/nextval path through the postgres owner.
 *
 * This suffix sorts after the source migrations.  An entirely absent object set
 * is a safe branch-order replay no-op; any partial set aborts.
 */

DO $hardening$
DECLARE
  v_table regclass := to_regclass('public.ca_epoch_closing_positions');
  v_sequence regclass := to_regclass('public.ca_epoch_closing_positions_id_seq');
  v_guard regprocedure := to_regprocedure(
    'public.fn_ca_closing_position_is_immutable()'
  );
  v_role text;
BEGIN
  IF v_table IS NULL AND v_sequence IS NULL AND v_guard IS NULL THEN
    RAISE NOTICE
      'closing-position storage is not present; ordered replay will harden it after its source migrations';
    RETURN;
  END IF;

  IF v_table IS NULL OR v_sequence IS NULL OR v_guard IS NULL THEN
    RAISE EXCEPTION
      'closing-position storage set is partial (table %, sequence %, guard %); refusing an incomplete authority repair',
      v_table IS NOT NULL,
      v_sequence IS NOT NULL,
      v_guard IS NOT NULL;
  END IF;

  REVOKE ALL ON TABLE public.ca_epoch_closing_positions
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT SELECT ON TABLE public.ca_epoch_closing_positions TO service_role;

  REVOKE ALL ON SEQUENCE public.ca_epoch_closing_positions_id_seq
    FROM PUBLIC, anon, authenticated, service_role;

  DROP TRIGGER IF EXISTS trg_ca_closing_position_immutable
    ON public.ca_epoch_closing_positions;
  CREATE TRIGGER trg_ca_closing_position_immutable
    BEFORE UPDATE OR DELETE OR TRUNCATE ON public.ca_epoch_closing_positions
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.fn_ca_closing_position_is_immutable();

  COMMENT ON FUNCTION public.fn_ca_closing_position_is_immutable() IS
    'Refuses every UPDATE, DELETE and TRUNCATE on ca_epoch_closing_positions. Closing evidence is corrected forward by a new capture and is never edited or erased.';
  REVOKE ALL ON FUNCTION public.fn_ca_closing_position_is_immutable()
    FROM PUBLIC, anon, authenticated, service_role;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF has_table_privilege(v_role, v_table, 'SELECT')
       OR has_table_privilege(v_role, v_table, 'INSERT')
       OR has_table_privilege(v_role, v_table, 'UPDATE')
       OR has_table_privilege(v_role, v_table, 'DELETE')
       OR has_table_privilege(v_role, v_table, 'TRUNCATE')
       OR has_table_privilege(v_role, v_table, 'REFERENCES')
       OR has_table_privilege(v_role, v_table, 'TRIGGER') THEN
      RAISE EXCEPTION '% retains a privilege on closing-position evidence', v_role;
    END IF;

    IF has_sequence_privilege(v_role, v_sequence, 'USAGE')
       OR has_sequence_privilege(v_role, v_sequence, 'SELECT')
       OR has_sequence_privilege(v_role, v_sequence, 'UPDATE') THEN
      RAISE EXCEPTION '% retains a privilege on the closing-position sequence', v_role;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', v_table, 'SELECT')
     OR has_table_privilege('service_role', v_table, 'INSERT')
     OR has_table_privilege('service_role', v_table, 'UPDATE')
     OR has_table_privilege('service_role', v_table, 'DELETE')
     OR has_table_privilege('service_role', v_table, 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role closing-position access is not read-only';
  END IF;

  IF has_sequence_privilege('service_role', v_sequence, 'USAGE')
     OR has_sequence_privilege('service_role', v_sequence, 'SELECT')
     OR has_sequence_privilege('service_role', v_sequence, 'UPDATE') THEN
    RAISE EXCEPTION 'service_role retains direct closing-position sequence access';
  END IF;

  IF has_function_privilege('anon', v_guard, 'EXECUTE')
     OR has_function_privilege('authenticated', v_guard, 'EXECUTE')
     OR has_function_privilege('service_role', v_guard, 'EXECUTE') THEN
    RAISE EXCEPTION 'closing-position trigger guard remains directly executable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
     WHERE t.tgrelid = v_table
       AND t.tgname = 'trg_ca_closing_position_immutable'
       AND NOT t.tgisinternal
       AND (t.tgtype & 2) = 2
       AND (t.tgtype & 8) = 8
       AND (t.tgtype & 16) = 16
       AND (t.tgtype & 32) = 32
       AND (t.tgtype & 1) = 0
  ) THEN
    RAISE EXCEPTION
      'closing-position immutable trigger does not refuse statement-level UPDATE, DELETE and TRUNCATE';
  END IF;
END
$hardening$;
