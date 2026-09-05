# The push guard read a markdown rule as a merge conflict

Found while pushing the Previous Hand phase 3 review (2026-09-05).

`.husky/pre-push` check 1 blocks a push whose files contain merge-conflict
markers. Its pattern was:

    ^(<<<<<<< |>>>>>>> |={7,}$)

The last alternative is wrong. Git writes the middle separator as EXACTLY
seven equals signs. `={7,}$` also matches a run of them, which is how a
changelog under `docs/` draws a horizontal rule under a heading - and this
repo's changelogs draw them constantly.

The effect: any push whose diff carried
`docs/changelog/2026-09-05-the-cluster-boards-are-a-rolled-back-probe-harness.md`
(a file with two 64-character rules, on `main`, not conflicted, written by
another agent) was BLOCKED with "contains a merge-conflict marker". Nothing was
conflicted. The only ways past were to rewrite somebody else's punctuation or
to `--no-verify`, which is exactly the habit the hook exists to prevent - and
the reason a hook that cries wolf is worse than no hook.

Fixed to match the three markers git actually writes, each at the start of its
own line: `<<<<<<< `, `>>>>>>> `, and a bare `=======`. Verified both ways: a
file containing the real separator still matches; a file containing a
64-character rule no longer does.

## Landed as main's version, not mine

While this was in flight, PR #3176 fixed the same line the same way (`={7}$`
rather than `=======$` - identical behaviour). The merge takes MAIN's version;
this file stays because the finding is worth having written down twice over
rather than losing it, and because it records the second symptom: the file that
tripped it here was another agent's changelog rules, and any branch merging
main was refused a push for a conflict it did not have.
