# Bind native import manifests to the exact image configuration

Native run 34779076181 built and loaded the engine archive, passed Docker configuration validation, proved its private containerd process and socket ownership, and then refused image identity. Its isolated importer recorded no OOM event and completed all owned cleanup checks.

The pinned Docker containerd implementation returns the image manifest digest in `image inspect`'s `Id`. The normalized archive's image identity is the digest of its raw configuration. Comparing those distinct values directly refused the imported image. The importer now verifies the inspected descriptor, hashes bounded manifest and configuration bytes from its private content store, and requires the manifest's configuration digest to equal the exact independently supplied image identity. It also binds source labels, baked revision, platform, tag, and root filesystem. Runtime extraction uses the verified manifest digest. The receipt keeps the configuration identity and records the manifest digest separately.

Portable tests use real content-addressed metadata files and refuse altered bytes, wrong identities, wrong platform or source, symlinks, oversized descriptors, and image indexes. The exact old comparison fails the valid manifest/configuration case. Native Docker import and its refusal matrix remain required.

The new build-provenance regression test also now resolves its source from Vitest's project working directory. This avoids Vite rewriting `new URL(..., import.meta.url)` into a browser asset URL; its six assertions pass using the repository's normal test configuration.

Primary source: [pinned Docker image inspection](https://github.com/moby/moby/blob/6a43e3d5afddf4111da0f864bbc7cae5d7e95001/daemon/containerd/image_inspect.go#L85-L117).
