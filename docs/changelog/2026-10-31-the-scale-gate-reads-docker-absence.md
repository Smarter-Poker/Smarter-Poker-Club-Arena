# 2026-10-31: the native census scale gate reads Docker's absence in any wording

The first production run of the #8908 pre-activation scale gate (receiver
41226449485, target 53c5991113, the owner-ordered next-:55 window for Horse
V63-V69) qualified its disposable fixture, removed the container, and then
refused before any notice or intake:

    [native-census-scale] REFUSED: scale preactivation gate refused:
    owned disposable container state unknown

`inspect_own` accepted a non-zero `docker inspect` as absence only when stderr
contained exactly `No such object` or `No such container`. The host Docker
CLI's not-found wording did not match, so the gate could never prove its own
cleanup and every release through it refused.

Now: the not-found wording is matched case-insensitively, and any other
non-zero inspect is confirmed against the daemon's own listing (`docker ps
--all` anchored to the exact name, exit 0 and empty). A listing that fails or
still shows the name stays unknown and refuses, as before. Nothing else in the
gate changes; the controller's own SHA-256 is part of the gate's one-shot key,
so this file starts a fresh one-shot qualification instead of inheriting the
refused receipt.

Tests: `tests/operations/legacy-census-scale-preflight.test.py` pins lowercase
absence, daemon-confirmed absence, a listing that still shows the name, and the
anchored filter.
