# Phase Three Create Configuration Capture

The original capture test is preserved byte for byte as a `.ts.template` file so ordinary test discovery does not repeat the 31 imported client tests. Its SHA-256 is recorded in `manifest.json`.

Run the explicit capture only when regenerating option evidence:

```sh
python3 scripts/dev/fixtures/phase-three-create-options/generate.py --output /tmp/codex-phase-three-create-client-configs.json
python3 scripts/ci/probes/tournament-create-options-matrix.py
```

The generator recreates the original test at its original relative-import location, runs only that test entry point, and removes only its own unchanged temporary copy. It refuses to overwrite an existing test. No database connection is used.
