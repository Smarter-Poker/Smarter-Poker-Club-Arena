# Ordinary engine stop retains the original hand while joining its writers

A direct engine stop could cancel the cooperative hand safety timer and then
wait on the dealing loop whose active controller wait had no remaining release
edge. Shutdown after its bounded drain and tournament-manager stop both reach
this ordinary stop path.

Stop now releases only that exact controller-owned local wait after fencing
further input. It retains the controller through the existing final snapshot;
it does not complete a hand, invent an action, cancel its original permit, or
release process ownership early. The captured continuation lane physically
drains its accepted work before snapshot and cleanup. Its live publication
fences and failures still apply, and failures remain in the teardown result.

The existing terminal-boundary fixture exercises the actual controller wait
producer and verifies snapshot custody. A pending real continuation persistence
fixture verifies that ownership stays held through both the accepted write and
final snapshot, suppresses publication after the fence, and preserves its error.
The lane fixture distinguishes terminal physical drainage from live authority.

Source qualification is separate from engine activation and live behavior.
This change does not establish applicability to the historical serving EED
cutover: that guarded route excludes an active continuation lane.
