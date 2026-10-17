# 2026-10-17 - The Financial Admin certificate admits the Club Data scope read

Post-deploy run 39069001820 failed `financial-admin-deep.spec.ts:437` with "Financial read-only guard blocked 1 REST mutation: POST /rest/v1/rpc/fn_ca_club_data_scope".

#7292 (17:40 UTC) made `ClubBottomNav` call `fn_ca_club_data_scope` through `useClubDataScope` on every club route. The read-only guard admits only reviewed RPC paths, so every Financial Admin certificate after #7292 counted this read as a write and failed.

`fn_ca_club_data_scope(uuid)` is STABLE SECURITY DEFINER and contains no DML (pg_proc, 2026-10-17). It is now on the reviewed shell-read list (`tests/e2e/helpers/financial-readonly-guard.ts`) with that evidence. `tests/unit/financialReadOnlyGuard.test.ts` pins it as allowed. Every other unlisted POST is still blocked.
