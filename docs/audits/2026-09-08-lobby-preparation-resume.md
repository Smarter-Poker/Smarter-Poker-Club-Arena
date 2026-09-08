# Lobby preparation resumes immediately

The visible-table observer previously refreshed only after an intersection
change or its 15-second interval. Safari can resume the Home Screen app with
unchanged intersections after speculative entries expired in the background.
That left preparation waiting for the next periodic tick.

Visibility, pageshow and online events now retry the known visible tables
immediately. Hidden events do nothing. Fresh roster reads and healthy facade
owners remain shared; the existing three-table speculation limit and live-table
priority are unchanged. All listeners are removed on cleanup.

Behavioral tests exercise expiration while hidden, immediate resume through
all three events, duplicate wake coalescing, disposal, and retrying a previously
unavailable slot without rereading a fresh roster. Existing mux tests cover
active-table ownership. This is not a claim that every lobby table has a live
subscription or that a physical iPad has been verified.
