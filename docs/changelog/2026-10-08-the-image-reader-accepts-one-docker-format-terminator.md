# One Docker formatter terminator is not an environment variable

Docker adds one terminal newline after the names-only template, which already ends each name with a newline. The image reader rejected the resulting final empty split line even when all seven baked environment names were allowed.

The reader removes exactly that one final empty line when the input ends in two LF bytes. Interior empty lines, additional empty lines, duplicate names, unknown names and empty input still refuse. It never reads environment values. The same maintained reader serves host preflight and export admission; private-repository and immutable-image guards are unchanged.

The actual seven-name formatting regression failed before the correction. All 20 focused image-reader tests passed afterward, including the new refusal boundaries. No native image export, provider operation or production release was performed by these tests.

The next real preflight exposed modern OCI gzip blobs being treated as graph JSON: compressed blob digests differ from RootFS uncompressed diff IDs. The reader now stream-decompresses exactly one bounded gzip member, checks the compressed filename digest and decoded RootFS identity, and applies the existing resolved historical credential-header scan before any archive egress. Typed OCI graph admission uses the verified compressed-to-decoded mapping and permits the exact gzip media type. Truncation, extra members, foreign digests, credential headers, expansion and time limits still refuse.

The canonical normalizer now writes the verified uncompressed layers while preserving the original configuration bytes and image ID. Compressed and uncompressed synthetic forms produce the same canonical archive hash. Original scanner/normalizer regressions failed before; 22 reader tests and 21 normalizer tests passed after. These are synthetic source qualification, not a native export or isolated-runtime acceptance claim.
