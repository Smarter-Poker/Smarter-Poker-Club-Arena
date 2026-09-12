// PostgreSQL 17 quote_identifier keyword categories from parser/kwlist.h.
// Portions Copyright (c) 1996-2024 PostgreSQL Global Development Group;
// Portions Copyright (c) 1994 Regents of the University of California.
const quotedKeywords = new Set(
  "all analyse analyze and any array as asc asymmetric authorization between bigint binary bit boolean both case cast char character check coalesce collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user dec decimal default deferrable desc distinct do else end except exists extract false fetch float for foreign freeze from full grant greatest group grouping having ilike in initially inner inout int integer intersect interval into is isnull join json json_array json_arrayagg json_exists json_object json_objectagg json_query json_scalar json_serialize json_table json_value lateral leading least left like limit localtime localtimestamp merge_action national natural nchar none normalize not notnull null nullif numeric offset on only or order out outer overlaps overlay placing position precision primary real references returning right row select session_user setof similar smallint some substring symmetric system_user table tablesample then time timestamp to trailing treat trim true union unique user using values varchar variadic verbose when where window with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable".split(
    " ",
  ),
);
export const SQL_IDENTIFIER =
  '(?:"(?:[^"\\x00]|"")+"|[a-z_\\u0080-\\uffff][a-z0-9_$\\u0080-\\uffff]*)';
export const SQL_QUALIFIED = `(${SQL_IDENTIFIER}(?:\\s*\\.\\s*${SQL_IDENTIFIER})*)`;
export function identifierParts(raw) {
  if (!new RegExp(`^${SQL_QUALIFIED}$`, "i").test(raw))
    throw new Error(`Unsupported SQL identity: ${raw}`);
  const parts = raw.match(new RegExp(SQL_IDENTIFIER, "gi")) || [];
  if (!parts.length || parts.length > 2)
    throw new Error(`Unsupported SQL identity: ${raw}`);
  // PostgreSQL UTF-8 folds ASCII letters only; high-bit characters retain identity.
  return parts.map((p) =>
    p.startsWith('"')
      ? p.slice(1, -1).replace(/""/g, '"')
      : p.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  );
}
export function quoteIdentifier(name) {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !quotedKeywords.has(name)
    ? name
    : '"' + name.replace(/"/g, '""') + '"';
}
export function manifestIdentity(raw) {
  const p = identifierParts(raw);
  if (p.length === 2 && !["public", "smarter_private"].includes(p[0]))
    throw new Error(`Unsupported manifest schema: ${p[0]}`);
  return p.length === 1 || p[0] === "public"
    ? p.at(-1)
    : p.map(quoteIdentifier).join(".");
}
export function qualifiedInSchema(raw, schema) {
  if (typeof raw !== "string") return false;
  const exact = new RegExp(`^${SQL_QUALIFIED}$`, "i");
  if (!exact.test(raw)) return false;
  const parts = identifierParts(raw);
  return (
    parts.length === 2 &&
    parts[0] === schema &&
    parts.map(quoteIdentifier).join(".") === raw
  );
}
