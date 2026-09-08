# Foreground Connection Recovery

The iPad Home Screen report includes an approximately 30-second delay before
live table action. Code inspection found that online events could bypass the
retry ladder, but returning to the app without an online event could not.
The visibility handler only resynchronized already-connected tables; it did
nothing for a disconnected table sleeping on the up-to-30-second retry.
There was no pageshow recovery listener on either engine client.

Both EngineStateClient and EngineChannelClient now register lifecycle-owned
pageshow and visibilitychange recovery at connect, before the first successful
socket is required. A visible disconnected client invokes the existing online
recovery path, preserving authenticated single-flight opening. Healthy links
stay open; pageshow invokes their existing bounded wake handling. Explicit
disconnect removes both listeners. Hidden pages do not trigger a new attempt.

93 focused tests passed across recovery, event ordering and session revocation;
client tsc --noEmit passed. New tests use the actual clients with a 30-second
retry and prove both wake events initiate a new attempt immediately, while
hidden, healthy and permanently disconnected clients retain their behavior.

This fixes that specific retry-delay path. It does not guarantee every table
is preloaded, eliminate server settlement waits, or prove the physical iPad's
entire incident resolved. Publication and device behavior need separate checks.
