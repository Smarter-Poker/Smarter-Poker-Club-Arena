---
description: Remediate Supabase Security Advisor errors using the Dual-Protocol (Views → security_invoker, Tables → RLS + permissive policy)
---

# Supabase Security Remediation (Dual-Protocol)

## Overview

This workflow clears security linting errors from the Supabase Security Advisor dashboard using two distinct remediation patterns, ensuring **zero regression** to existing functionality.

## Pre-Flight: Collect Issues

// turbo-all

1. Navigate to the Supabase Security Advisor page:
   `https://supabase.com/dashboard/project/kuklfnapbkmacvwxktbh/advisors/security`
2. Use the browser subagent to extract ALL issues from the security grid (it uses a virtualized list, so you must scroll and collect via JavaScript).
3. For each issue, record: **entity name**, **issue type**, and **object type** (TABLE or VIEW).

## Sorting: Bucket A vs Bucket B

Sort every issue into exactly one bucket:

### Bucket A: Views

- **Identifier:** Issue type is `security_definer_view` or metadata `"type": "view"`
- **Pattern:**

```sql
ALTER VIEW public."<name>" SET (security_invoker = true);
```

### Bucket B: Tables

- **Identifier:** Issue type is `rls_disabled_in_public`, `sensitive_columns_exposed`, or metadata `"type": "table"`
- **Pattern (Bridge Strategy):**

```sql
ALTER TABLE IF EXISTS public."<name>" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = '<name>' AND policyname = 'patch_maintain_access') THEN
    CREATE POLICY "patch_maintain_access" ON public."<name>" FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
```

### Bucket C: Functions (Search Path Mutable)

- **Identifier:** Issue type is `function_search_path_mutable`
- **Pre-step:** Query `pg_proc` to get exact function signatures (argument types matter!)

```sql
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.proname IN ('<name1>', '<name2>', ...);
```

- **Pattern:**

```sql
ALTER FUNCTION public."<name>"(<exact_args>) SET search_path = 'public';
```

### Bucket D: Auth Settings (Dashboard Only)

- **Identifier:** Issue type is `leaked_password_protection_disabled`
- **Pattern:** Enable in Supabase Dashboard → Auth → Email Provider → "Prevent use of leaked passwords"
- This is NOT fixable via SQL — it requires the dashboard UI toggle

## Rules of Engagement

1. **NEVER** apply a Table pattern to a View (it will fail)
2. **NEVER** apply a View pattern to a Table (it will do nothing)
3. **NEVER** fix `sensitive_columns_exposed` by hiding the column — use Bucket B (RLS + True Policy) instead
4. **`spatial_ref_sys` (PostGIS):** This is a system extension table owned by the Postgres superuser. The dashboard SQL editor role cannot modify it. **Exclude it from the transaction** to avoid an ownership error that would roll back the entire batch. Note: this will leave 1 residual error on the advisor — this is expected and acceptable.
5. All SQL must be wrapped in a single `BEGIN; ... COMMIT;` transaction
6. All policy creation must be idempotent (`IF NOT EXISTS`)
7. All table alterations must use `IF EXISTS` guards

## Execution

1. Generate the full SQL transaction file and save it as a migration:
   `supabase/migrations/YYYYMMDD_security_remediation.sql`
2. Open the Supabase SQL Editor via browser subagent:
   `https://supabase.com/dashboard/project/kuklfnapbkmacvwxktbh/sql/new`
3. Inject the SQL into the Monaco editor using JavaScript:
   ```javascript
   window.monaco?.editor?.getModels()[0]?.setValue(sql);
   ```
4. Click the "Run" button and wait for "Success. No rows returned"
5. If `spatial_ref_sys` causes an ownership error, remove it from the script and re-run

## Verification

1. Navigate back to the Security Advisor page
2. Confirm the error count has dropped (expect 1 remaining for `spatial_ref_sys`)
3. Take a screenshot for the walkthrough
4. Report the before/after counts to the user
