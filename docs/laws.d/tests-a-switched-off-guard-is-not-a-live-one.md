# tests/a-switched-off-guard-is-not-a-live-one.law.test.ts

The estate audit must read whether Agent Autopilot is switched ON before it
judges that workflow's last run, because a DISABLED workflow reports its final
run through `gh run list` for ever, exactly as a deleted one does. Measured
2026-10-02: `Estate Integrity` was red with 19 problems and three of them said
that commander-shared, smarter-poker-workers and PepNationLab had a red
Autopilot and that "while it is red, pull requests stop being queued". No clause
was true. Those runs were at 2026-09-16T04:06/04:35/05:24Z and GitHub records
all three workflows as `disabled_manually`, set about an hour later and within
eleven minutes of each other - one deliberate, coordinated retirement, which the
September 17 owner instruction then wrote down (a retired autopilot remains
inactive and is a prerequisite for nothing). The law keeps four answers separate:
enabled, so the run conclusion means something; switched off by somebody, so it
does not; switched off by GitHub after 60 idle days, which nobody chose and which
is therefore raised; and a state that could not be read, which is COULD NOT TELL
and is never folded into the other three.
