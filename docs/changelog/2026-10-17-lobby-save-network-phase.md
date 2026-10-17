# Give lobby saves their network phase after the click

Production run 39000685160 recorded a successful MTT restore click after 20.957 seconds. The old request timer had started before the click, leaving only nine seconds to observe its save. The tab was selected, enabled, visible and directly under the pointer; the failure was a request deadline, not an intercepted click.

Arm a matching request observer before the action, including fast writes before click completion. After the click succeeds, give the request and response their existing shared 30-second network budget. Keep the click's own 30-second actionability limit and the journey's 120-second limit. Preserve owner/club/tab matching, successful response and selected-state assertions, cold readback, original failure diagnostics, and listener cleanup. A failed click is reported immediately without waiting for a request from an unsuccessful action. No retries or product changes.

A regression with a 21-second click and a save 12 seconds later fails before and passes after. Missing or failed saves still fail within their network budget. This qualifies the timing correction; the complete hosted production journey remains required.
