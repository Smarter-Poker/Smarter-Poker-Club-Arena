# Bound fixture package transport retries

The provider build can fail when the dated Debian snapshot closes a connection during package download. Configure APT for three failed-file retries and 30-second HTTP/HTTPS connection and data timeouts in the shared fixture base, so its builder and final-image package downloads use the same bounded policy.

The dated repository URLs, package selection, TLS verification, repository signatures, provider hashes and final payload checks remain unchanged. APT update still fails on any unresolved acquisition error, and installation still stops on failure. A per-connection timeout is not a whole-build deadline; the existing outer CI limits remain in force.

The failed ff5918 native run and its cleanup receipt remain failure evidence. This source change requires a new native build; it does not prove successful package acquisition, provider loading or production readiness.
