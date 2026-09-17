\set ON_ERROR_STOP on
-- Portable supplement entry point. UNRUN protected disposable fixture only.
-- The owner loads the captured full schema/policies/access before this file.
-- No private transaction boundary: preserve the invoking fixture transaction.
\ir schema.sql
\ir definitions.sql
\ir access.sql
