# Profile isolation captures a ready theme

The production customization journey captured the other player's `data-theme` immediately after its profile heading appeared. The account settings read can still be pending then. Run36340911365/client108681400225 captured null and failed in Playwright's options overload at18:50:53, before finishing the intended isolation assertion.

The test now waits for the actual rendered light/dark mode within its existing response budget and captures that successful value. The final comparison remains exact. Missing or invalid modes fail; no default, extra budget or synthetic preference write supplies a baseline. Product theme, account transport, financial behavior and cleanup are unchanged.

The regression mounts a profile heading while its preference response is held, uses the real receiving settings store and actual document attribute, demonstrates the former null capture, and waits for each valid mode. Invalid/missing modes fail and a subsequent overwrite differs from the original captured value. The existing unit workflow enforces these cases; the maintained production journey retains actual two-device/account isolation proof.
