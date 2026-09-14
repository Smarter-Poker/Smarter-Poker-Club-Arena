# Preserve the cause of refused and uncertain tournament finishes

The engine sent the actual terminal exception to process logs and Sentry, but saved only a generic message in its durable financial alert. After a container was replaced, the alert inbox could identify the tournament and winner without explaining why completion failed.

The financial alert now carries the original exception message and type. The existing source, tournament and winner identities, refusal certainty, retry guard, unknown-outcome fence, and awaited persistence call remain intact. This improves investigation evidence; it neither changes settlement authority nor repairs missing historical elimination witnesses.

Six manager tests exercise the real financial-alert request boundary: four exception forms, a delayed acknowledgement, and an unavailable alert store. The four diagnostic assertions fail on the preceding source because both cause fields are absent.
