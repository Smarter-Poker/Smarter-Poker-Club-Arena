# The September 8 Games' Finish-Refused Alerts Close (2026-10-02)

## What Happened

The 26 September 8 Spins and heads-up Sit & Gos each raised one CRITICAL
`Tournament.atomic_finish_refused` alert at about 00:21 UTC, when the engine
tried to finish them while they were still REGISTERING. They were launched by
20261001225325 and finished by their terminal authority at 02:16-02:22 UTC:
COMPLETED, one payout equal to the whole pool (1,223.10 in all), prize and
bounty escrow at zero. Their outcome-unknown alerts were closed by
20261002034540; the 26 refusal alerts stayed open.

## Fix

Migration 20261002061026 resolves exactly those 26 alerts, each only after its
event is proven settled, with a resolution note. The alert trigger closes each
mirrored drift incident. No money row, function or closer changes; held PR
#5723 is untouched.
