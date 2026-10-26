# Browser Install Cannot Spend The Cleanup Budget

The client verification job now limits its existing Chromium/WebKit dependency-install step to ten minutes, before production readiness and both isolated-account creation paths. A stalled install fails visibly before any fixture exists. The existing primary Ubuntu mirror selection, 80-minute job ceiling, application assertions and cleanup steps remain intact.

The comparable successful install in job 121591382452 took 49 seconds. Job 121619175020 spent 49 minutes 32 seconds installing, created its account afterward, and reached the 80-minute job timeout before primary cleanup. Ten minutes provides more than twelve times the successful install duration while keeping dependency setup from consuming most of the certificate budget. This is a bounded setup safeguard; the unreadable failed-job log does not establish its precise download or operating-system cause.

The parsed-workflow regression fails without the bound and checks the positive finite cap, unchanged job ceiling, normal failure propagation, install-before-readiness ordering, and readiness guards on every production account creation path.
