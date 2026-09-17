DO $$ DECLARE x jsonb;r jsonb; BEGIN
 SELECT f.x INTO x FROM fixture_terminal_concurrent f;
 r:=fn_finalize_bounty_pool((x->>'t')::uuid,(x->>'b')::uuid);
 PERFORM fixture_assert(r->>'ok'='true' AND (r->>'residual')::numeric=7.50,'concurrent finalizer sees committed predecessor and exact7.50residual');
END $$;
