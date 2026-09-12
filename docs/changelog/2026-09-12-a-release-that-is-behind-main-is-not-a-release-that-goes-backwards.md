# A release that is behind main is not a release that goes backwards

**2026-09-12**

The engine could not deploy. Not intermittently: eight consecutive release
transactions built their image, waited, and died on the same check, and the
engine ran one build for four and a half hours. One of the eight carried the fix
for a live fault that was killing every cash table every twenty seconds, so the
gate was refusing the remedy for the outage it was sitting on top of.

## What the gate asked

In four places, the release path required the target to **be** the newest commit
touching `server/**` on protected main:

```
[ "$LATEST_REQUIRED" = "$SHA" ] || die "target is stale; protected main requires $LATEST_REQUIRED"
```

A release waits in a FIFO, and then the transaction waits again on the box for
its `:55` maintenance-break window, because the break is what carries the engine
restart. That wait runs up to fifty minutes, and the check is re-run throughout
it. At this repo's merge rate, about nineteen an hour, a build that is perfectly
valid when it is cut is "stale" long before its window opens.

From the box's own journal:

```
03:07  image for 367a6ade built and validated on the box
03:32  main moved   367a6adec..43216b121
03:41  main moved   43216b121..f894216ca
03:53  main moved   f894216ca..35f1b585e
03:53  FATAL: target 367a6adecd is stale; protected main requires 35f1b585ef
03:53  sealed desired runtime d68cc549 was recovered
```

The rollback is correct, the ancestry proof is correct, riding the break so
players are not interrupted is correct. Composed, they produce a path that
cannot deliver at the repo's normal merge rate. `d68cc549` was live only because
it happened to be the newest engine commit when its own window came round.

## What is true instead

Every deploy is behind main the instant it lands, so being behind cannot be what
makes one unsafe. Two properties are what actually matter, and both are kept:

**Containment.** The target is an ancestor of protected main. This is what
catches a rewind, a force-push, or a build off some other history. It was always
a separate check, it runs in all four places, and it is still a hard failure.

**No reversal.** The engine never moves backwards. This is now proved on the box
against the runtime it has sealed:

```sh
sealed_sha="$("$RELEASE_SEAL" get desired-sha)"
[ "$sealed_sha" = "$SHA" ] || git merge-base --is-ancestor "$sealed_sha" "$SHA" \
  || die "target $SHA does not descend from the sealed runtime $sealed_sha"
```

That also serialises two racing releases without needing identity: an older
release cannot land on top of a newer one that has already sealed.

Identity was a blunt approximation of no-reversal, asserted in three places that
cannot know what is running. It is replaced by no-reversal itself, asserted in
the one place that can. The two runner-side checks now print a notice instead of
failing, and the on-box staging step says what it is staging.

## So it cannot come back

`tests/a-release-that-is-behind-main-still-ships.law.test.ts` pins that the
containment proofs still exit non-zero, that the sealed-runtime ancestry proof
exists, and that no high-water identity comparison has become a hard failure
again. Verified to bite: restoring one of the gates fails the law with the file
and line.

The law reads executable lines only. Both files now quote the old refusal in the
comment explaining why it went, and the first version of the law found that
comment and reported the documentation as the defect - the same trap
`check-unqualified-writes.mjs` records in its own header. It also asserts the
quote is still there, because the reason a gate was removed is the thing most
worth keeping.
