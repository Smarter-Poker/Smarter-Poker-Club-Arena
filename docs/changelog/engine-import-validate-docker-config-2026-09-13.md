# Validate the exact private Docker configuration before startup

Docker 29.7.2 rejected the importer-authored `containerd-plugin-namespace` JSON directive before loading an image. Its source has that singular struct tag but registers only the plural `containerd-plugins-namespace` option, and checks JSON directives against the registered options before unmarshalling. The importer had followed the tag without checking the effective parser schema.

The importer now sets the namespace through the supported plural CLI flag, which directly assigns the intended field, and omits the inconsistent JSON directive. Inside the existing bounded unit, before either daemon starts, it runs the exact pinned Docker command with `--validate`. A rejected configuration, timeout or configuration-file change stops the proof. Validation output, exit status and configuration hash are retained. Intended native fault receipts must also show successful configuration validation.

The 512 MiB memory, zero-swap and one-CPU limits, private runtime ownership, cancellation, image/runtime verification and clean-shutdown requirements remain unchanged. The successful-preflight startup and refusal sequencing pass portable tests; actual native CI remains required.
