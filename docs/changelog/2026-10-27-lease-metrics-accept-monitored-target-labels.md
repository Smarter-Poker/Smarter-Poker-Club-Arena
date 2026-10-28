# Lease incident metrics accept the configured scrape labels

The bounded historical lease reader rejected the fixed `host`, `role`, and
`app` labels that the maintained Prometheus engine target attaches to every
sample. A valid production-shaped matrix therefore became an unavailable
observation before any lease evidence could be inspected.

The reader now accepts only those three configured label/value pairs and
continues to omit them from its output. Unknown labels and different target
values remain refused. The native fixture derives the target labels from the
maintained monitoring configuration, reproduces the prior rejection, and
checks accepted evidence plus wrong and arbitrary label rejection. This fixes
the evidence reader; it does not establish the original lease-loss cause.
