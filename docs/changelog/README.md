# Session changelog entries

**One file per session. Never append to a shared file.**

    docs/changelog/YYYY-MM-DD-<short-slug>.md

## Why this exists

`MIGRATION-CHANGELOG.md` is ~950KB and append-only, and CLAUDE.md rule 10.9
told every agent to add to it at session end. Every agent therefore wrote to
the same last line of the same file, so every agent conflicted with every other
agent — on documentation, which cannot affect whether the code works.

On 2026-08-26 a local three-way merge of all 108 conflicting pull requests
against `main` ranked the files that actually collide:

| conflicts | file                                              |
| --------- | ------------------------------------------------- |
| **18**    | **MIGRATION-CHANGELOG.md**                        |
| 16        | src/pages/ClubHomePage.tsx                        |
| 9         | src/pages/TablePage.tsx                           |
| 7         | server/src/services/TournamentRecurringService.ts |
| 7         | server/src/GameServer.ts                          |
| 7         | scripts/agent-workspace.sh                        |
| 5         | AGENT-PLAYBOOK.md                                 |

The changelog was the single largest source of merge conflict in the
repository — ahead of both of the giant page components. Roughly a sixth of a
119-PR blocked queue, caused by a file nothing executes.

Two files created independently in this directory can never conflict. That is
the whole idea.

## What to write

Same content as before. Lead with what changed and why, not what you did:

```markdown
# 2026-08-26 — what the seat-exit audit found

## Shipped

- ...

## Deliberately not changed

- ...
```

## The old file

`MIGRATION-CHANGELOG.md` is **frozen as history**. Do not append to it, and do
not reformat or split it — 18 open pull requests are currently conflicting on
it, and rewriting it would make every one of them worse. It stays exactly as it
is until that queue drains; new work lands here.
