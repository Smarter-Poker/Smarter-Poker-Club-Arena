# tests/stage-b-postgrest-settings-apply-only-to-this-api.law.test.ts

Stage B and its executable probe require exactly one role-wide canonical PostgREST request hook, refuse every competing setting applicable to the current database and authenticator login, and ignore unrelated database or role settings while checking private-schema exposure.
