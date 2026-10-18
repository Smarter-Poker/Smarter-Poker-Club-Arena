DO $$ DECLARE j jsonb:=ca_union_statement_board('00000000-0000-4000-8000-000000000001',null,8); BEGIN
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'clubs') x WHERE x->>'status'='paid' AND (x->>'paid_total')::numeric=0 AND (x->>'outstanding')::numeric=100) THEN RAISE EXCEPTION 'Original legacy inconsistency not reproduced'; END IF;
END $$;
