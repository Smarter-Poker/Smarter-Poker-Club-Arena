# Profile Verification Uses The Existing User Gesture

The browser acceptance journey now closes an open Table Studio through its existing close control, positively waits for it to disappear, then clicks GlobalHeader's My Profile once. It requires the exact protected profile route and visible profile heading within the original single 60-second deadline. It no longer reloads the document or waits for whole-document load readiness after the profile has already rendered. The URL/history boundary uses `waitUntil: 'commit'`; the visible heading proves content readiness.

Six focused regressions cover the gesture, studio ordering, failed control, wrong route, missing heading and remaining deadline. The real GlobalHeader/React Router regression proves the existing profile wiring. A separate real-browser history fixture proves one gesture and no new document request; it uses no application, authentication or financial backend. Actual deployed acceptance remains a separate required proof.
