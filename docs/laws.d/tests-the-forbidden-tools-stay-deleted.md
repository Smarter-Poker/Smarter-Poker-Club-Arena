# tests/the-forbidden-tools-stay-deleted.law.test.ts

wait_for_pr_and_deploy.sh and apply-migration-temp.yml stay deleted, and no workflow applies SQL to production with psql -f (which bypasses the migration ledger)
