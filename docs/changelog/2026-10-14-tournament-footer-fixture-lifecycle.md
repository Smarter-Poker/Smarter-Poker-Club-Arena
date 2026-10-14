# Isolate the tournament footer CSS fixture

The tournament footer cases now navigate to a blank document before installing their isolated production-CSS fixture. `setContent` alone retained the previously mounted financial-decision app's ResizeObserver. Its detached footer could publish zero occupied height after the fixture published 132px, placing Register beneath the synthetic footer.

The correction disposes the previous application window callbacks without changing application CSS or behavior. The 132/0/66px footer heights, center-hit and clearance checks, five-second assertion deadline, real button activation and embedded 500px constraint remain unchanged.

A focused local lifecycle reproduction using the actual production stylesheets and the same observer write contract demonstrated zero published height and an intercepted Register; navigating first preserved 132px and an unobstructed button. This initial reproduction used the hook's equivalent observer contract rather than a mounted React hook. The maintained cases additionally boot the real financial-decision app before navigation.

The unchanged maintained footer cases passed at 375, 393 and 1280px against the actual local financial-decision dev harness using installed Google Chrome, one worker and zero retries (3/3). The prior hosted 375px failure supplies the actual mounted-app failure evidence; no claim is made that the local observer-contract reproduction mounted React.
