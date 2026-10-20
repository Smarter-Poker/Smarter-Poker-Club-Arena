# Lightning Uses The Original Cash Clock

The private Action pilot exposed a real financial continuity gap: an active
cash session still had its original 600,000 ms and opening timestamp after 68
Lightning hands. Its voluntary departure remained pending. The installed
cash-session evaluator is intact; Lightning settlement never calls it, and
the parked physical anchor omits the existing presence and clock-release path.

The candidate invokes the existing evaluator in the original settlement
transaction, using each participant's exact physical anchor and current stack.
It preserves baseline, clock length, identity, financial delegates and voluntary
leave rules. A mode transition does not trigger it. The parked anchor resumes
the existing clock owner and its occupancy-bound release. A native refusal
invalidates the stale presence mirror so the next existing observation adopts
the database's actual clock. No clock is reset or backdated, and no new sweep,
repair job, payout or release controller is added.

The two engine regressions fail on the original implementation. All 103
affected engine tests pass after the repair. The maintained PostgreSQL 17
settlement chain reproduces the profitable but untouched clock before the
candidate. Afterwards it verifies real front/feeder settlement, unchanged
baseline and cash identity, profit/loss behavior, duplicate settlement,
rollback on an invalid cash-session binding, private trigger ACL, and a
voluntary pending departure serving its retained remainder. A cancelled leave
with a retained historical request cannot override a genuine later sit-out;
that boundary fails before its pending-flag guard and passes afterward. The existing
native chain runs this regression in required accounting qualification.

Compilation, exact-candidate hooks, hosted checks, protected integration,
guarded installation and live engine proof remain pending. Production state
has not been changed by this candidate. Public rollout remains off.
