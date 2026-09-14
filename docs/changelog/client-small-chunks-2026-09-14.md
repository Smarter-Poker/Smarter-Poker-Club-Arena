# Compress emitted client chunks without widening startup

The production client exceeded its total compressed JavaScript budget. The build now uses pinned Terser 5.51.2 with two compression passes and at most two workers to compress individual emitted chunks. Rollup retains its existing chunk graph and lazy-loading boundaries. Budget limits, startup module baselines, browser targets, legal comments and hidden source maps remain in effect.

CI executes two actual Vite-generated module graphs through the configured production minifier and compares their lazy side effects, cyclic live bindings and repeated-import caching with an unminified control. It also verifies retained license comments and hidden source maps. The full production build and entry-module gate remain required before this change can be accepted. No dependency was installed or full application built on the Mac; the local operation updated only package manifests, and CI installs the locked dependency.
