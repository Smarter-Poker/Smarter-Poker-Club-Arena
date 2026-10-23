# Tournament lobby hourly breaks

The shared Blinds tab searched blind levels for an `isBreak` row even though the engine schedules MTT breaks at :55 independently and skips legacy structure break rows. Every normal MTT structure therefore displayed "No Further Breaks Scheduled".

All club/union tournament lobbies now use the engine's recorded-format break eligibility and the next UTC :55 boundary. Registering events show the first boundary at or after their scheduled start. The panel explains that five minutes start after all hands finish. Finished and bagged events do not advertise a future break; explicit opt-outs and fixed short formats retain their existing runtime behavior. Missing format data remains visibly unknown.

A break announcement no longer fabricates an end time from its duration. Last-hand state waits for the real server deadline, and the later countdown event replaces that state. Duplicate announcement seeds cannot reset a live countdown. Reloads use persisted break state; expiry waits for authoritative resume.

Regression: actual BlindsTab rendering with fake clock and real format eligibility, including ordinary structures, future registration, legacy structure rows, row/bus last-hand state, full five minutes after delayed final hands, duplicate events, reload, finished/bagged/short formats and UTC day rollover. Baseline 15 failed / 1 passed; fixed focused suite 101 passed. No engine runtime or database change required.
