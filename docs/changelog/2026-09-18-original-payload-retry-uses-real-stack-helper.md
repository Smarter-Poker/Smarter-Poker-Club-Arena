# Original payload retry fixture uses the real stack helper

The integrated retry probe extracts the current settlement method into a VM. Original cash provenance added a `handStackBefore` dependency to that method, but the probe did not provide it, so 19 of its 21 cases stopped before the first RPC.

The VM now receives the actual imported `handStackBefore` and `requireHandSeatGeneration` functions. All 21 existing retry, unknown-outcome, lease and F06 acceptance assertions pass without changes. No production behavior or financial authority changed.
