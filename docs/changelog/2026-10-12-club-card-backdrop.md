# Club Cards Without A Rectangular Backdrop

Removed the shared carousel wrapper's prismatic gradient, dormant shine overlay and rectangular box shadow. Club, union and Diamond Arena cards now expose the page background outside their painted frames. Card artwork, live figures, swipe, entrance animation, tap feedback and keyboard focus remain unchanged.

This is client-only presentation using existing APIs; no engine or database change is required. Validation and publication evidence is recorded in the task checkpoint under /Volumes/SmarterArchives/agent-evidence/club-card-backdrop-20261012/.

The first hosted Production Build passed compilation but failed the route performance check because the desktop health route had no FCP entry at the fixed 500ms sample. The performance observer now brings the page to the foreground and waits for its real first contentful paint. Missing paint remains a failure; FCP, LCP, CLS, transfer and overflow budgets are unchanged. This directly supports delivery of the assigned card correction.
