# Qualify the gateway that is actually retained

The published client keeps an already acknowledged gateway through engine
reconnects. Its isolated proof must therefore accept the current READY state
of an open gateway, rather than demand a new READY frame after the fault.
Track socket identity and the latest status for the exact topic; closed sockets,
other topics, primary-engine frames and later refusals cannot qualify. Both
subsequent genuine record changes and visible reader updates remain required.
Retain bounded token-free record observations to explain any future refusal.

Run 41177101158 failed the old post-fault-only READY assertion before any
cosmetic writes. Its exact before/after pins and reserved-account cleanup passed.
This is a test observation correction, not a new runtime change or a claim that
the failed run passed. The corrected case must execute through the existing
protected provider workflow.
