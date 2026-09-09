BEGIN;
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.fn_use_throwable_v2(text,uuid)'::regprocedure);
  original text := $original$  SELECT id INTO v_credit
    FROM public.feature_purchases
   WHERE user_id = v_uid
     AND feature = 'throwable'
     AND COALESCE(uses_remaining, 0) > 0
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_credit IS NOT NULL THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
     RETURNING uses_remaining INTO v_left;$original$;
  replacement text := $replacement$  LOOP
    SELECT id INTO v_credit
      FROM public.feature_purchases
     WHERE user_id = v_uid
       AND feature = 'throwable'
       AND COALESCE(uses_remaining, 0) > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE;

    EXIT WHEN v_credit IS NULL;
    -- A selected credit may expire while its row lock is awaited. Recheck
    -- at consumption, then select the next valid pack before charging diamonds.
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
       AND user_id = v_uid
       AND COALESCE(uses_remaining, 0) > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     RETURNING uses_remaining INTO v_left;
    EXIT WHEN FOUND;
  END LOOP;

  IF v_credit IS NOT NULL THEN$replacement$;
BEGIN
  IF md5(definition) <> '8772c2ff647fc93dc5dcdb0c21b4f26d' THEN
    RAISE EXCEPTION 'Throwable function changed since review; revalidate before applying';
  END IF;
  IF strpos(definition, original) = 0 THEN
    RAISE EXCEPTION 'Expected pack consumption block was not found';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$migration$;
COMMIT;
