# Managed native fixture is an independent prerequisite

The complete isolated service fixture and its trusted controls now have a
separate source package from the draft release journal. It runs genuine Auth,
PostgREST, Realtime, PostgreSQL and Chromium, keeping the application database
owner restricted and service bootstrap connections separately owned.

The existing smoke tests remain, with additional service ownership, shutdown,
gateway and Realtime boundary checks. CI must prove the exact committed image,
managed event-trigger behavior, authenticated isolation and complete cleanup.
No dependency installation runs on the Mac.

The six draft journal migrations remain on their original branch. This package
does not install a journal, activate a controller or certify a funded route.
Complete application schema and privilege readiness remain mandatory before
the full product or financial-route runner accepts a fixture.
