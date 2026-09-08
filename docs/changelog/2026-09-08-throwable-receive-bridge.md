# Preserve incoming throwable delivery

The table bridge discarded the fourth callback argument, losing the receipt identity before playback. It now forwards that identity to the animation queue.

Twenty active chat reactions also prevented incoming throws from reaching playback. Reaction timers no longer gate throws; the animation queue owns its active limit and pending backlog. Sender echo suppression remains in place.

Regression checks cover receipt forwarding and incoming throws while all twenty reaction slots are occupied.

Validation: 81 focused tests pass. TypeScript and production compilation pass with Sentry source-map upload disabled locally. Publishing uses the existing main-branch pipeline.
