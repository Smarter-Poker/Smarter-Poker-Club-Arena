# Private record fallback loads with its consumer

The broadcast hook now loads the independent record transport when its effect mounts. The shared identity service no longer eagerly imports that transport or its failover implementation, so neither module enters the application startup chunk. The reviewed entry baseline is unchanged.

Lazy completion is fenced by mount and authenticated identity state. Load errors remain visible while the existing paid subscription continues. Once loaded, the fallback registers with the primary socket's synchronous identity reset boundary. Primary identity intent is discarded before dependent reset callbacks run, so a dependent failure cannot preserve the previous account's socket intent.

Focused lifecycle tests cover logout and unmount during loading, consumer teardown, synchronous fallback retirement and a throwing reset callback. The production Vite build and unchanged entry-module gate pass locally; hosted checks and live publication remain separate delivery gates.
