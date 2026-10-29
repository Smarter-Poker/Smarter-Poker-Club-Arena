# Mystery projections use the complete live field

The pending mystery ladder counted at most 1,000 roster rows, so a percent-of-field activation could advertise the wrong chest count. It waited for a 30-second polling interval to notice entries and rebuys, allowed overlapping refreshes, and retained the previous event's projection while a new event loaded.

The projection now uses the existing complete standings reader and shared tournament event/reconnect subscription. One in-flight read plus one trailing invalidation preserves response order and coalesces updates. Event changes clear the prior ladder; a failed refresh retains a verified current-event projection. Cleanup releases only this consumer. The authoritative inventory builder and money rules are unchanged; these separate reads remain a projection, not an atomic inventory snapshot.

Rendered-hook regression covers 1,001 entrants, a late-page failure, event-driven updates, changing events during loading, invalidations during an outstanding request, and retention on failed refresh. Hosted, publication and live verification remain pending.
