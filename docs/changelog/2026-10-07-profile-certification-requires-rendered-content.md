# Profile certification requires rendered content

Post-deploy run37565880099 timed out in the customization realtime profile-navigation stage while its retained desktop screenshot already showed the complete profile. The test waited for DOMContentLoaded instead of proving the rendered route. The separate gameplay customization runtime case passed; its assertions are unchanged.

The maintained realtime check now waits for committed navigation, rejects a wrong origin/path, and requires the actual visible profile heading within the remaining original60-second deadline. It performs one navigation with no retry. Document failures, redirects, missing content and exhausted deadlines still fail. Account isolation, persistence, profile metadata/settings updates and authenticated realtime signals retain their existing assertions.

The original lifecycle behavior fails the regression; committed/rendered readiness passes. Current protected integration and actual post-deploy execution remain required before this correction is considered delivered.
