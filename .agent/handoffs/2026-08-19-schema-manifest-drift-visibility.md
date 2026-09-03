# Handoff: make schema-manifest drift visible (needs a token with `workflow` scope)

**Why this is a handoff and not a commit:** the change edits
`.github/workflows/schema-manifest-refresh.yml`. GitHub refuses a PAT push that
touches a workflow file unless the token carries `workflow` scope:

```
! [remote rejected] refusing to allow a Personal Access Token to create or
  update workflow `.github/workflows/schema-manifest-refresh.yml` without
  `workflow` scope
```

Everything else below is finished and merged; only this one file is blocked.

## The problem, measured 2026-08-19

`schema-manifest-refresh.yml` **works** — it ran and succeeded on 08-18 and
08-19. What it cannot do is open a PR: Actions lacks create-PR permission in
this repo, so it pushes a branch and writes a link into the **job summary**,
which nobody reads.

Consequence found today:

- three regenerated manifests sitting on pushed branches
  (`chore/schema-manifest-64c839b`, `-87fc017`, `-a4effa5`) with **zero** open PRs
- meanwhile the `Supabase Invariants — Phantom References` gate was **red on
  main** and was hand-patched three separate times in one day (PRs #125, #127,
  and the pass-9 work)

**Do NOT merge those branches blindly.** They are stale: `main` is now at
**782 tables / 1787 functions**, the newest bot branch is **775 / 1754** —
merging it would REMOVE entries that code currently references.

## Two fixes

### 1. Repo setting (one click, durable, human-only)

Settings → Actions → General → **Allow GitHub Actions to create and approve
pull requests**. With that on, the existing fallback disappears and the daily
refresh opens a normal PR.

### 2. Workflow patch (below) — belt and braces

Raise a GitHub issue when PR creation fails. `issues: write` is a permission
the default `GITHUB_TOKEN` can always use, so drift stops being invisible even
if the setting above stays off.

Apply exactly this to `.github/workflows/schema-manifest-refresh.yml`:

**(a) extend `permissions:`**

```yaml
permissions:
  contents: write
  pull-requests: write
  # Actions cannot open PRs in this repo (see the fallback below), and a job
  # summary is read by nobody. An issue is the one notification channel the
  # default token can always use.
  issues: write
```

**(b) after the `$GITHUB_STEP_SUMMARY` block inside the "Open a PR if the schema
moved" step, still inside the `if ! gh pr create ... then` fallback, append:**

```bash
# 2026-08-19: the job summary was the ONLY notification, and it is
# not somewhere anyone looks. Three refreshed manifests were found
# sitting on pushed branches with no PR and no issue, while the
# phantom-reference gate went red on main and was hand-patched
# three times in one day. Raise an issue so drift is visible, and
# only ever one — comment on the open one if it already exists.
COMPARE="https://github.com/${GITHUB_REPOSITORY}/compare/main...${BRANCH}?quick_pull=1"
EXISTING=$(gh issue list --state open --label schema-drift --json number --jq '.[0].number // empty' || true)
if [ -n "$EXISTING" ]; then
  gh issue comment "$EXISTING" --body "Drift again on \`${BRANCH}\` (added ${ADDED}, removed ${REMOVED}): ${COMPARE}" || true
else
  gh label create schema-drift --color B60205 --description "Committed Supabase manifest is behind live" --force >/dev/null 2>&1 || true
  printf '%s\n' \
    "The live Supabase schema has moved ahead of the committed manifest." \
    "" \
    "A regenerated manifest is already pushed to \`${BRANCH}\` (added ${ADDED}, removed ${REMOVED})." \
    "" \
    "**Merge it:** ${COMPARE}" \
    "" \
    "Until it lands, check-phantom-tables.mjs fails CI for anyone whose code references an object created directly in production. Review added names; removed names matter more, since code may still reference them." \
    "" \
    "_Actions cannot open PRs in this repo. The durable fix is Settings -> Actions -> General -> 'Allow GitHub Actions to create and approve pull requests'._" \
    > /tmp/drift-issue.md
  gh issue create --title "Schema manifest has drifted from live" --label schema-drift --body-file /tmp/drift-issue.md || true
fi
```

## Verification after applying

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/schema-manifest-refresh.yml')); print('YAML valid')"
node scripts/ci/check-phantom-tables.mjs     # expect: 0 phantoms
node scripts/ci/check-stranded-writers.mjs   # expect: 0 stranded
```

Both were verified green locally with this patch applied before it was blocked.

## Optional follow-up (not included)

The refresh runs once daily (`cron: '20 5 * * *'`) while schema is applied to
prod continuously, so CI can sit red for up to 24h between runs. Raising the
cadence (every 2–3h) would bound that, at the cost of more drift branches.
Left as a judgement call rather than changed unilaterally.
