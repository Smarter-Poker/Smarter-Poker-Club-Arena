# Cancel delayed throwable voice and retain the starting animation speed

Legacy voice delays were not retained, so cancellation could not stop a pending line. Playback also failed to recheck mute after waiting. Newer throws now replace pending older lines, playback rechecks sound enablement, and each returned cleanup only cancels its own generation. ThrowAnimation invokes that cleanup on removal, so an old component cannot cancel a newer throw's speech.

The legacy player also re-read animation speed on rerender while its effect timers retained the old value. It now captures speed on mount and provides the same value to its CSS custom property.

Verification: six service regression tests, three mounted component tests and 27 existing measured-grammar checks pass (36 total). Scoped strict TypeScript passes. Tests cover pending cancellation, mute during delay, replacement, stale teardown, active cancellation, unsupported speech, removal before/after landing and mid-throw speed changes.

This repairs existing browser speech lifecycle. It does not supply the remaining recorded voice assets or claim the legacy artwork replacement is finished.
