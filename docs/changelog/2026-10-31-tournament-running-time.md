# Tournament Running Time

Tournament Details now prints elapsed wall time from the actual started_at timestamp, including breaks, using the existing display clock. Completed events use ended_at; missing or invalid timestamps show Unavailable. Running sit-and-go events continue ticking after their start-when-full admission finishes. No additional database reads or repair timers.
