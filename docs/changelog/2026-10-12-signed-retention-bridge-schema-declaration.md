# Signed retained-request bridge schema declaration

The schema reader represents public functions without a schema prefix. The new bridge fragment used a public-qualified name, so the required migration guard refused the declaration despite exact installed function readback. The fragment now uses the reader's established public-function name. Installed SQL, database permissions and accounting behavior remain unchanged. The original failed pre-push is retained; the corrected declaration must pass the same guard and normal submission checks.
