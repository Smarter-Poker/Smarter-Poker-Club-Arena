# An Existing Recovery Reason Retains Its Original Witness

The completed release audit retained an `engine-degraded` cause without the serving-engine signs that selected it. The successful observer short-circuits its journal read after a sealed attestation. Its original transaction already journals those signs, and its sealed result binds the original completion invocation.

The same explicit read-only Production Integrity Audit now selects only that validated original invocation, exact fixed release unit and the reservation's two-minute lead. It reads at most two literal producer reason rows, 8 KiB and five seconds. It exports only independently validated signs, invocation and time. Unknown ownership, another invocation/unit, malformed fields, out-of-window timestamps, ambiguous rows and unqualified signs refuse. Missing journal or unavailable transport remains unknown. No engine producer, runtime, publisher, arbitrary host command or financial state changes.

Observation schema v2 distinguishes retained exact producer signs from unknown basis. Retained signs are historical producer evidence; they do not certify every policy prerequisite or independently reconstruct the old health response. The original completion invocation must contain the reason line; later replays never substitute for it.

The previous no-journal assertion is intentionally replaced with stricter exact invocation/unit/time, bounded output and no arbitrary command assertions in the same native qualification. Twenty native scenarios execute the actual reader handler, filesystem guards, before-unknown/after-retained fixture, negative cases and bounded subprocess. Existing explicit workflow qualification and its law remain the enforcement route.

The JSON parser also accounts for systemd's mandatory cursor, monotonic time and boot fields, validates them and discards them. [The systemd journalctl source documentation](https://github.com/systemd/systemd/blob/main/man/journalctl.xml) specifies those always-present fields even with `--output-fields`.

Local qualification: native 20 scenarios PASS; diff whitespace check PASS. Protected checks, integration and the exact historical production read remain pending. No audit event or production action has been sent from this source branch.
