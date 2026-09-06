# The push hook counts exactly seven equals signs

2026-09-05

## What was broken

`.husky/pre-push` check 1 refused any push whose diff touched
`docs/changelog/2026-09-05-the-cluster-boards-are-a-rolled-back-probe-harness.md`:

```
[club-arena pre-push] BLOCKED: docs/changelog/2026-09-05-the-cluster-boards-are-a-rolled-back-probe-harness.md contains a merge-conflict marker
```

There is no conflict marker in that file. It is a verbatim probe transcript
inside a fenced code block, and it underlines its sections with a rule of 64
equals signs. The check's pattern was `^={7,}$` - seven OR MORE - so the rule
matched.

The file landed on `main` in #3196. From that moment every branch that merged
`main` carried it in the push diff, so every branch was refused a push for a
conflict none of them had. Three open pull requests hit it within the hour.
The only ways past it were `--no-verify`, which section 8 of CLAUDE.md forbids,
or not merging `main` at all.

## The fix

The separator git writes is exactly seven equals signs alone on a line. The
pattern now says `^={7}$`. Verified both directions: a line of exactly seven
is still caught, a rule of 64 is not. `<<<<<<< ` and `>>>>>>> ` are unchanged -
they already required the trailing space that git writes before the branch
name, which is why neither of them ever produced this false positive.

## Why the changelog was not edited instead

It is somebody else's record of a rolled-back probe, quoted verbatim, and the
rule is part of what the probe printed. Loosening a guard until it stops
lying about a correct file is the fix; rewriting the evidence to suit the
guard is not.
