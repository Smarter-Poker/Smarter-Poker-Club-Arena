# Small automatic client chunks

The AutoSeat candidate produced 520 script/style files and exceeded the unchanged 2600 KiB total gzip limit by 1 KiB. Let Rollup combine automatic chunks smaller than 4096 bytes before minification, preserving the side effects associated with each entry. No application module is assigned to a manual chunk and no feature is removed.

The production-build job executes real generated modules in both lazy-loading orders, including a cyclic live binding and repeated cached imports. The existing initial-load, entry-module, total-size and browser gates remain mandatory. Only the complete CI build can establish the actual size improvement.

This uses Rollup's experimental minimum-chunk option, so the locked Rollup version and the execution test must be retained when upgrading the bundler. Merging may load some additional otherwise unused code with an entry; the initial-load gate still bounds the result.
