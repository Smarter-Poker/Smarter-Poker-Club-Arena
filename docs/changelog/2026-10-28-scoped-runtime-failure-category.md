# Bounded runtime reads retain a safe failure category

The Oct27 lease observation run40744493431 failed its read step after three seconds and retained no artifact. Its catch reported only unavailable, so transport, input-bound and identity refusals could not be distinguished. The previous successful equivalent40568571859 scoped job122421296046 completed the same pinned route on Oct27; configured Hetzner secret names remain present with unchanged August metadata. Neither comparison proves the new failure cause.

The maintained reader now emits only a fixed stage/category JSON diagnostic on failure. An exact bounded remote diagnostic may cross the SSH boundary; arbitrary SSH stderr, exception text, URLs, keys, pin values, request data and engine logs never do. Exit255 remains an SSH exit category, not an invented authentication diagnosis. All input/output/time/privacy bounds and identity refusal behavior remain unchanged. No failed read is retried automatically.

Native regression coverage verifies category separation, unknown/arbitrary/oversized diagnostic refusal, secret redaction and the real failed process entry. The original historical lease cause remains unknown until the corrected qualified read returns actual evidence.
