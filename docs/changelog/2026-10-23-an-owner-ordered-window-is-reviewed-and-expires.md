# An Owner-Ordered Window Is Reviewed and Expires

Owner order, October 23, 2026, 11:07 America/Chicago: "NO, I WANT YOU TO RUN THIS NOW, DO A 11:55 ENGINE RESET AND MAKE THIS LIVE NOW." (river nuts always bet full, #7788)

## Why

#7777 correctly removed commit text as authority to pause games: an `Engine-Release: urgent` trailer on a routine merge paused every table at midnight, and later commits could inherit it. Its checkpoint kept the 04:00 rule binding "absent a later explicit narrow human exception," but left no way to carry one. Only a measured outage could restart the engine off-cycle.

## What Changed

- **One reviewed carrier.** `server/release/owner-maintenance-windows.json` holds owner-ordered entries: the quoted order, the exact commit the release must contain, a validity window of at most six hours, and the America/Chicago minutes the announcement may be made in. It is merged through protected main like any source and expires on its own.
- **Both gates read it, neither reads commit text.** `stage-engine-release.yml` admits dispatch only while an entry is valid and HEAD contains its commit. The host transaction re-reads the entry from the target's own immutable tree (`git show "$SHA:..."`) and asks for a window only after the measured-emergency reasons, at the named minute.
- **Everything after the reason is unchanged.** Newest-release ownership, the engine lock, the fresh health read, the seal's one window per rolling hour, the 2-minute last-hand lead, the 5-minute drain/freeze, certificate, rollback reserve and thaw. The seal and serving engine receive the existing owner cause, `urgent`.
- **Once.** A window grants nothing after its named commit is serving (both gates read the serving `releaseSha`; an unreadable identity grants nothing), so later merges inside the window never earn another reset.
- **The first entry** names 6416f795 (#7788), valid 2026-10-23 12:00 to 16:30 Chicago, announced at :53 or :54 so the global pause starts at :55 alongside the hourly tournament break.

## Proof

Eight new real-shell cases in `tests/operations/engine-release-recovery-window.py` (valid window reserves once as `urgent`; wrong minute, expired, future, over six hours, unnamed order, malformed, missing commit, legacy urgency flag and no file grant nothing; a spent hour waits; an older release defers to a newer one), all 24 original cases, and producer cases in `tests/daily-engine-maintenance.law.test.ts`, whose harness now runs in an isolated tree so the live entry cannot change its verdicts with the clock.
