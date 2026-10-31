CASE WHEN scope->>'kind'='unknown' THEN 'unknown' WHEN scope->>'kind' IN ('club','union') AND octet_length(scope->>'id')=36 THEN (scope->>'kind')||':'||(scope->>'id') END
