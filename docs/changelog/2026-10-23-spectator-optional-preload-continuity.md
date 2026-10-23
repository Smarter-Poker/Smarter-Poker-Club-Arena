# Optional JavaScript preload failures preserve the active table

The global Vite preload listener previously cancelled a failed import and immediately replaced the document. That preempted the importing caller's retry handling, including optional startup and table warmers intended to leave a usable route running.

JavaScript preload errors now reject into their caller. Optional JavaScript warmers can retry or report failure without navigating away from a mounted table. Critical lazy routes retain their bounded retries and guarded recovery.

Stylesheet failures retain guarded document recovery and remove the failed link. Vite marks CSS dependencies seen before fetching, so deleting the link alone cannot make its next import fetch the stylesheet again. This preserves the existing protection against an unstyled page.

Regression coverage exercises Safari's module-error wording through the Vite event and the real importWithRetry function, asserting no document replacement or spent recovery budget. A separate regression preserves critical recovery after its retry budget.

This repairs a demonstrated reload path. It does not establish that every reported periodic Safari white screen came from that path. Device continuity and publication evidence remain in the task checkpoint.
