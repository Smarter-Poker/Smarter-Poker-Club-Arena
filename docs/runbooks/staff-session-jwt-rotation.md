# Runbook — Commander Staff Session Secret Rotation

**When to use this runbook**

- Rotating `COMMANDER_STAFF_SESSION_SECRET` for security compliance (quarterly cadence).
- After a suspected credential leak affecting Commander.
- After rotating `SUPABASE_JWT_SECRET` (the two must stay in sync until the Commander
  auth layer is decoupled from Supabase JWTs).

---

## Background

`COMMANDER_STAFF_SESSION_SECRET` is the HMAC key used to sign staff session tokens
for the `smarter-poker-commander` Vercel project. It was intentionally seeded as the
same value as `SUPABASE_JWT_SECRET` (as of 2026-09-03) so that existing Supabase JWTs
issued to staff accounts remain valid without a forced logout.

**Zero-invalidation window**: as long as the secret is the same as `SUPABASE_JWT_SECRET`,
no signed-in staff session is broken by a Commander redeploy.

---

## Preconditions

- Vercel Team token with write access to `smarter-poker-commander`
  (env var `VERCEL_TOKEN` in `~/Documents/club-arena/.env`)
- Team ID: `team_SVD8r7AOPH065G3usBxVvrBc`
- `SUPABASE_JWT_SECRET` value available (in `.env.vercel.prod` or Supabase dashboard)

---

## Step 1 — Read the current SUPABASE_JWT_SECRET

```bash
grep SUPABASE_JWT_SECRET ~/Documents/club-arena/.env.vercel.prod
```

Copy the value; it is the new secret unless you are rotating both simultaneously.

---

## Step 2 — Set COMMANDER_STAFF_SESSION_SECRET on Vercel

```bash
NEW_SECRET="<value from step 1>"
VERCEL_TOKEN="vcp_..."   # from ~/Documents/club-arena/.env

curl -s -X POST \
  "https://api.vercel.com/v9/projects/smarter-poker-commander/env?teamId=team_SVD8r7AOPH065G3usBxVvrBc" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"COMMANDER_STAFF_SESSION_SECRET\",\"value\":\"$NEW_SECRET\",\"type\":\"sensitive\",\"target\":[\"production\",\"preview\",\"development\"]}"
```

> **If the variable already exists**, use PATCH with the existing env var ID:
>
> ```bash
> # Get the ID first
> curl -s "https://api.vercel.com/v9/projects/smarter-poker-commander/env?teamId=..." \
>   -H "Authorization: Bearer $VERCEL_TOKEN" \
>   | python3 -c "import json,sys; [print(e['id'], e['key']) for e in json.load(sys.stdin).get('envs',[])]"
>
> # Then PATCH
> curl -s -X PATCH \
>   "https://api.vercel.com/v9/projects/smarter-poker-commander/env/<ID>?teamId=..." \
>   -H "Authorization: Bearer $VERCEL_TOKEN" \
>   -H "Content-Type: application/json" \
>   -d "{\"value\":\"$NEW_SECRET\"}"
> ```

---

## Step 3 — Trigger a Commander redeploy

Vercel does NOT automatically redeploy when an env var changes. Force it:

```bash
# Trigger a redeploy of the latest production deployment
LATEST_DEPLOY=$(curl -s \
  "https://api.vercel.com/v6/deployments?projectId=smarter-poker-commander&teamId=team_SVD8r7AOPH065G3usBxVvrBc&limit=1" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['deployments'][0]['url'])")
echo "Current deployment: $LATEST_DEPLOY"

# Push an empty commit on the branch to trigger a build, OR use the Vercel UI
# to click "Redeploy" on the latest production deployment.
```

---

## Step 4 — Verify the probe passes

After the Commander redeployment completes (< 3 min):

```bash
# The health endpoint should show staff_session_secret: true
curl -fsS https://commander.smarter.poker/api/health | python3 -m json.tool
```

Look for `"staff_session_secret": true` in the output.

If the probe workflow is wired (`PROBE_EMAIL` / `PROBE_PASSWORD` are set in GitHub secrets
and the post-deploy probe is enabled), the signed-in leg will also run within 5 minutes
of the deploy.

---

## Step 5 — Rotating SUPABASE_JWT_SECRET simultaneously

If you must rotate both secrets at the same time:

1. Generate a new 64-byte random secret:
   ```bash
   openssl rand -base64 64 | tr -d '\n'
   ```
2. Update `SUPABASE_JWT_SECRET` in the Supabase dashboard (Auth → JWT Settings).
3. Update `SUPABASE_JWT_SECRET` on every Vercel project that uses it:
   - `hub-vanguard` (main World Hub)
   - `smarter-poker-commander`
4. Set `COMMANDER_STAFF_SESSION_SECRET` to the new value on `smarter-poker-commander`.
5. Redeploy both projects.
6. All existing Supabase JWT sessions are **immediately invalid** — staff members must
   re-authenticate. Warn them before rotating.

---

## History

| Date       | Action                                          | Operator |
| ---------- | ----------------------------------------------- | -------- |
| 2026-09-03 | Initial set — seeded from `SUPABASE_JWT_SECRET` | Agent    |
