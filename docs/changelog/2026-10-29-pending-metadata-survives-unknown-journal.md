# Pending metadata preserves an unavailable journal

The current release's exact request and unit checks passed, but its optional journal read refused. The former all-or-nothing observer discarded the validated metadata, preventing the operator from distinguishing pending state from unavailable diagnostics.

The v2 read keeps request/control/deadline/unit metadata only after both request and unit identity are rechecked. A journal refusal is explicitly `unavailable`, its signs are null, and a closed reason code identifies the failing boundary. It is never an empty successful journal, absence proof, readiness verdict or release authorization. Required metadata and recheck failures still refuse the whole read. Unexpected exceptions do not become partial success.

The existing journal command, strict parsing, byte/time limits and all production release guards are unchanged. Source review demonstrated that valid twelve-row output may exceed the existing byte limit and that systemd grep no-match exits nonzero; neither is claimed as the current host's causal branch. The partial read exposes that uncertainty without accepting a nonzero command or broadening log exports.

Regression: the original source fails the new partial-read case; the correction preserves metadata with null signs, rejects forged status/reasons and schema, and still rejects changed request/unit identity after a journal failure. All sixty native fixtures and the existing source law remain required. Source qualification and protected installation of this diagnostic are separate from engine adoption and original-hand recovery.
