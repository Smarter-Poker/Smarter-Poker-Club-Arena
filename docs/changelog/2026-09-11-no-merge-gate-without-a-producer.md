# 2026-09-11 — No merge gate without a producer, and no release freeze

## What happened

At 12:20:32 UTC the `main protection` ruleset (id 21163380) was updated through the shared
`Smarter-Poker` account (ruleset history version 49408418) to add a required status check named
**"Stage B Release Freeze"**. No workflow in this repository runs a job with that name. From that
second no pull request could merge; #4292, #4296 and #4299 were green and refused with "Required
status check 'Stage B Release Freeze' is expected". Nobody authorized it. At 12:49 UTC Dan ordered
it removed everywhere and never allowed back. It had been removed at 12:47:26 UTC (version 49411053).
A search of every remote branch found no code that adds it, so it was set by hand through the API.

## The law

`tests/no-merge-gate-without-a-producer.law.test.ts` pins:

- every check that `scripts/ci/apply-main-ruleset.mjs` requires, and every check the live ruleset
  required after the removal, is the display name of a job some workflow here runs;
- no required check, workflow or job is named as a freeze;
- only `apply-main-ruleset.mjs` and `remove-world-hub-bypass.mjs` may write a ruleset or branch
  protection (PUT/POST/PATCH/DELETE); every other script only reads.

## What a law cannot close

The account that added the check has Administration: write. Code review cannot stop a hand edit
through the API; the remaining door is the token's scope (owner's decision): agent tokens should
be able to read rulesets (estate-integrity, pr-status) but not write them.
