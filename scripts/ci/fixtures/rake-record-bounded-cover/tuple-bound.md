# Native-only fast cover and complementary fallback feasibility

This proof supports the maintained private helper and two physical indexes. The finite native evidence does not prove production build latency, consumer capacity or financial completion. No payout eligibility restriction is introduced.

The three JSONB `jsonb_send` lengths totaling at most448 are NOT used as a proven bound on binary JSONB representation. The predicate additionally requires the sum of exact decompressed JSONB sizes to be at most1864. An exceptional JSON shape or value simply enters the original fallback. The other bounds are source/rake_method UTF8 octet lengths totaling128 and three numeric_send lengths totaling128. Each component uses COALESCE(NULL,0), so the predicate is always TRUE or FALSE and its complement partitions every is_tournament row, including SQL NULLs. JSON null remains a JSON value.

The native helper is narrowly typed, STRICT, and IMMUTABLE: it applies `jsonb_extract_path(value, VARIADIC '{}'::text[])` before `pg_column_size`. This is not a relabeling of generic pg_column_size. Native catalog confirms pg_column_size is STABLE. PostgreSQL17 `get_jsonb_path_all` obtains its input with PG_GETARG_JSONB_P, which deTOASTs and decompresses; empty-path extraction returns the complete decompressed object/array or reconstructs the complete scalar. The measured result has an inline, decompressed representation, so the size no longer depends on external storage/compression. The helper preserves identity and only returns an integer size. Native NULL, JSON null, scalar, array, object, UTF8, depth128 and physically compressed data controls verify those directly relevant branches. The scope of this proof is this exact helper body and PostgreSQL17 implementation, not arbitrary STABLE calls inside IMMUTABLE wrappers.

## Universal tuple bound for the guarded actual17 types

The tuple includes exactly all17 fingerprint fields. Exact actual column names/types/typmods were used to generate the native table; global_hand_id is BIGINT and returned_uncalled is JSONB.

- Three JSONB datums, including their varlena headers: at most1864 by the exact decompressed-size predicate, independent of nesting, string escaping or numeric values inside JSON.
- Two text datums: content at most128 octets plus at most8 bytes of varlena headers =136. UTF8 is bounded in bytes.
- Three numeric datums: numeric_send contains eight header bytes plus two bytes per base10000 digit. Internal numeric has a maximum eight-byte header plus the same digit bytes. Allowing a further four bytes per datum conservatively gives at most140. This includes NaN and old special representations; actual NUMERIC(18,4) imposes additional bounds that are not needed here.
- Fixed fields: five UUIDs80 bytes, timestamp8, BIGINT8, INTEGER4, BOOLEAN1 =101.
- Conservatively allow seven alignment bytes before EACH of17 attributes =119, even though most need less.
- Eight-byte index header plus INDEX_MAX_KEYS32 null bitmap, rounded to MAXALIGN8:16.
- Final MAXALIGN padding: at most7.

Total upper bound:1864+136+140+101+119+16+7=2383, rounded conservatively to2384. This is below the PG17 eight-kilobyte B-tree version4 limit2704. Index tuple construction fetches external values and retains/compresses only when useful; storage packing can reduce this bound. The complementary key-only index contains only tournament_id/id UUIDs, so it has no wide-value hazard. No oversized legal input is refused.

Sources inspected:

- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/jsonfuncs.c — get_jsonb_path_all/jsonb_get_element, especially lines1400–1469.
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/access/common/indextuple.c — index_form_tuple, lines85–152.
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/include/access/itup.h — tuple header, fixed null bitmap, alignment.
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/include/access/nbtree.h — BTMaxItemSize.
- https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/utils/adt/numeric.c — NumericShort/Long and numeric_send.

## Observed finite native result and limits

The private12000-row fixture generated from actual17DDL partitions10800fast/1200fallback, preserves the full original17-field fingerprint query bag by EXCEPT ALL, and naturally plans Append with fast Index Only Scan plus fallback Bitmap Index Scan/Heap Scan using the complementary narrow index. No planner flags were forced. The corrected target set includes a fallback event. No runtime benchmark or production population extrapolation is claimed. Private cluster/socket were removed.

Production applicability still requires maintained helper authority/source review, actual predicate selectivity, actual natural plans, installation safeguards and a full affected-flow capacity/quality result. This evidence alone does not authorize live indexes or prove weekly Scope can finish.

## Final arithmetic correction

Use only `predicate.sql` and the v2-bigint native result for a future predicate. Each COALESCE length/size component is cast to BIGINT **before** any addition. A cast on the final sum would be too late. The old prototypes used INT4 arithmetic and are retained solely as history. Native allocation-free controls catch the old22003 overflow and verify three INT4_MAX components produce6442450941, two produce4294967294, and oversized eligibility is FALSE rather than an arithmetic error. Three nonnegative INT4 length results fit safely within BIGINT. This correction preserves two-valued NULL handling, complementary fallback and original fingerprint bag. The final native result again naturally selects fast Index Only Scan plus the narrow fallback index, with no planner flags.
