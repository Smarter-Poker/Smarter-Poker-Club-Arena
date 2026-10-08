# One Docker formatter terminator is not an environment variable

Docker adds one terminal newline after the names-only template, which already ends each name with a newline. The image reader rejected the resulting final empty split line even when all seven baked environment names were allowed.

The reader removes exactly that one final empty line when the input ends in two LF bytes. Interior empty lines, additional empty lines, duplicate names, unknown names and empty input still refuse. It never reads environment values. The same maintained reader serves host preflight and export admission; private-repository and immutable-image guards are unchanged.

The actual seven-name formatting regression failed before the correction. All 20 focused image-reader tests passed afterward, including the new refusal boundaries. No native image export, provider operation or production release was performed by these tests.
