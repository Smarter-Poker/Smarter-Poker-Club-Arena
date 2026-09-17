# Quiet tournament moves during a roster read

A tournament move requested while the quiet table loop awaited its roster could
miss the sleeper wake and then wait through a newly started roster sleep. The
existing recorded move owner now prevents that new sleep, returning the loop to
its actual pause gate. Physical parking, settlement barriers, exact owner release,
polling backoff, move deadlines and expiry rules remain unchanged.

Two connected loop regressions fail on the original source. Final verification
passes all nine quiet-loop cases and 41 related boundary/readiness checks, plus
the server compiler. The new cases cover an in-flight roster read with and without
pending settlement, no extra sleep, claimed-owner retention and exact release.
Existing server CI shards already include these tests.

This fixes a reproduced source ordering defect. It does not establish that this
race caused the specific 16:30 production late-park observation, or certify full
tournament recovery. Publication and live verification remain separate.
