# Accounting CI Package Sources

CI 34384429258, job 102579346549 failed before PostgreSQL tests ran because the hosted image's unrelated Google Chrome APT repository returned a package-index hash mismatch. No accounting assertion failed in that job.

The PostgreSQL installer now uses a temporary source directory containing only the runner's signed Ubuntu sources and the official signed PostgreSQL repository. Every update/install uses that same directory. Signature and hash verification remain enabled; no failure is ignored. Existing system sources remain unchanged. The required PostgreSQL test job and server dependency remain mandatory.

References: https://manpages.ubuntu.com/manpages/noble/man5/apt.conf.5.html and https://www.postgresql.org/download/linux/ubuntu/ .
Actual hosted execution is the remaining verification gate.
