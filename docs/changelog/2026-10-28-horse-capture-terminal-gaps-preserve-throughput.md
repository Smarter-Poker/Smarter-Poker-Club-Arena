# Terminal horse capture gaps preserve throughput

The isolated public-observation capture consumer treated a durably expired source request as a transport failure. Consecutive terminal gaps increased its backoff to one minute per request, leaving still-readable requests behind expired work until their source windows expired too.

Terminal `gap` receipts now reset capture error backoff while retaining the ordinary bounded fairness pause. Gaps remain visible as gaps, journal and maintenance work still get their turns, and deferred, unknown and unavailable failures retain exponential backoff. This changes neither strategy qualification nor source horizon, and does not reconstruct expired observations.

Focused regression fails against the previous loop: four gaps consume the thirty-second test budget and readable capture is never reached. With the repair, eight terminal gaps and the next admitted capture finish within seventeen seconds with journal turns between claims. The six connected journal/capture/discovery/model/commitment loop suites pass; required protected delivery and affected live proof are recorded separately by the owning task.
