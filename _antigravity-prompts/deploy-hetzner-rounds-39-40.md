# Antigravity dispatch — Deploy Hetzner engine container (Rounds 39 + 40)

## Context

Cowork mode (Claude in the desktop app) just finished Phase A of the live audit
sweep — Rounds 34 through 40. Rounds 39 and 40 produced two engine fixes that
are committed to GitHub `main` but NOT yet running on the Hetzner engine
container at `178.156.160.206`. The Cowork sandbox cannot SSH out (no access
to `~/.ssh` on the Mac), so it can't run the deploy script itself.

You (Antigravity, running on the Mac with SSH key access) are being dispatched
to do exactly one thing: pull the latest code on the Hetzner host, rebuild and
restart the `club-arena-engine` container, and verify the new code is live.

## Repo + commits

- Repo: `Smarter-Poker/Smarter-Poker-Club-Arena` (GitHub)
- Local clone: `/Users/smarter.poker/Documents/club-arena/`
- Branch: `main`
- The two commits to deploy:
  - `59661704` — `x39: hand_history.community_cards must accumulate flop/turn/river (Round 39)`
  - `9900b874` — `x40: fix penny-leak on chop pots (Math.trunc → Math.round in completeHand) (Round 40)`

Both touch `server/src/engine/` only — no migrations, no schema changes, no
frontend changes. Container restart is sufficient.

## Hetzner host

- IP: `178.156.160.206`
- User: `root`
- Path: `/opt/club-arena`
- Container name: `club-arena-engine`
- Public URL: `https://engine.smarter.poker`
- Engine listens on internal port 8080; Caddy reverse-proxies engine.smarter.poker → 8080.

## Deploy steps (the canonical one-shot script handles all of this)

```bash
cd /Users/smarter.poker/Documents/club-arena
bash server/deploy-hetzner.sh
```

The script does:

1. Pre-flight check `SENTRY_DSN` is set on the host (warn if not, do not block).
2. `ssh root@178.156.160.206 'cd /opt/club-arena && git pull origin main'`
3. Rebuild Docker image on the host: `docker build -t club-arena-engine ...`
4. Stop + remove old container, start new one with `-p 8080:8080` and `--restart unless-stopped`.
5. Tail the new container's logs for ~10s to confirm clean boot.

If the script fails at any step, paste the full stderr + the last 50 lines of
container logs and stop. Don't try to "fix forward" — bring me the failure.

## Verification (mandatory, do not skip)

After the deploy script reports success, run all three of these and paste
results:

### 1. Engine HTTP health is 200 and reports recent uptime

```bash
curl -s https://engine.smarter.poker/health | python3 -m json.tool
```

Expected: `"status":"ok"`, `"running":true`, AND `"uptime"` < 60 seconds (proves
container actually restarted and didn't just keep running the old code).

### 2. Recent hands have full community_cards (Round 39 verification)

Run this Supabase SQL (use the project_id `kuklfnapbkmacvwxktbh` and your
existing supabase MCP / dashboard / psql):

```sql
SELECT
  hand_number,
  community_cards,
  array_length(community_cards, 1) AS n_cards,
  jsonb_array_length(actions) AS n_actions,
  ((actions->-1)->>'stage') AS final_stage,
  ended_at
FROM hand_history
WHERE created_at > now() - interval '5 minutes'
  AND ((actions->-1)->>'stage') IN ('turn', 'river')
ORDER BY created_at DESC
LIMIT 10;
```

Expected: every row where `final_stage = 'river'` has `n_cards = 5`. Every
`final_stage = 'turn'` has `n_cards = 4`. Pre-fix the bug stored only 1 card
on these.

If the query returns no rows after 5 minutes, the bot fleet hasn't dealt a
new hand to a turn/river ending yet — wait another 3-4 minutes and re-run.
If after 10 min still no rows, that's a different issue — flag it.

### 3. No new chop pots leak cents (Round 40 verification)

```sql
WITH multi_winner AS (
  SELECT
    hh.id,
    hh.pot_size - hh.rake_amount - COALESCE(hh.bbj_amount, 0) AS expected,
    (SELECT SUM((w->>'amount')::numeric) FROM jsonb_array_elements(hh.winners) w) AS actual
  FROM hand_history hh
  WHERE hh.created_at > now() - interval '15 minutes'
    AND jsonb_array_length(hh.winners) > 1
)
SELECT
  COUNT(*) AS multi_winner_hands_post_deploy,
  COUNT(*) FILTER (WHERE expected = actual) AS exact_match,
  COUNT(*) FILTER (WHERE expected != actual) AS still_leaking
FROM multi_winner;
```

Expected post-deploy: `still_leaking = 0`. Pre-deploy 24h ledger showed
7 / 90 chops leaked 1¢ each. If the deploy worked, every multi-winner hand
created after the new container starts must have `expected = actual` exactly.

If `still_leaking > 0` after at least 5 chop pots have been dealt post-deploy,
the new container isn't actually running the patched HandController — pull
the container's git SHA (`docker exec club-arena-engine git rev-parse HEAD`)
and confirm it's `9900b874` or later.

## Reporting back

When done, post a summary with this shape:

```
DEPLOY: Hetzner engine — Rounds 39 + 40
Pre-deploy commit on host: <sha>
Post-deploy commit on host: 9900b874
Container restart: ✓ (uptime <X>s)
Health endpoint: 200 ok
Round 39 verification: <X> hands ended turn/river, all have n_cards = 4 or 5
Round 40 verification: <X> chop pots, 0 leaking
```

If any step fails, abort and post the failure + full context. Don't roll back
or attempt a retry — Cowork will adjudicate.

## Hard rules

- Don't touch any code. The two commits are already on `main`. Just deploy them.
- Don't edit `server/.env` on the host. If `SENTRY_DSN` is missing the script
  will warn — that's fine, it doesn't block deploy.
- Don't run `git push --force` or any rewrite. The remote `main` is the source
  of truth.
- Don't open PRs. This is a deploy-only task.
- Don't deploy any other branch.
