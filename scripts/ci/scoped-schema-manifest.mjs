import { qualifiedInSchema } from "./sql-manifest-identifiers.mjs";
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function names(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string" || !x.length || x.includes("\0"))
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
function columns(value, label) {
  if (!object(value)) throw new Error(`Invalid ${label}`);
  for (const [key, vals] of Object.entries(value)) {
    if (!key.length || key.includes("\0"))
      throw new Error(`Invalid ${label} relation`);
    names(vals, `${label}.${key}`);
  }
  return value;
}
export function mergeSchemaResponses(
  publicSchema,
  publicColumns,
  privateSchema,
  required,
) {
  if (!object(publicSchema)) throw new Error("Invalid public schema");
  const tables = names(publicSchema.tables, "public tables");
  const functions = names(publicSchema.functions, "public functions");
  columns(publicColumns, "public columns");
  columns(required, "required columns");
  if (
    !object(privateSchema) ||
    privateSchema.version !== 1 ||
    privateSchema.schema !== "smarter_private" ||
    privateSchema.complete !== true
  )
    throw new Error("Missing complete smarter_private scope");
  const pt = names(privateSchema.tables, "private tables");
  const pf = names(privateSchema.functions, "private functions");
  const pc = columns(privateSchema.columns, "private columns");
  for (const group of [pt, pf, Object.keys(pc)]) {
    if (
      new Set(group).size !== group.length ||
      group.some((n) => !qualifiedInSchema(n, "smarter_private"))
    )
      throw new Error("Invalid qualified smarter_private identity");
  }
  if (
    pt.some((t) => !Object.hasOwn(pc, t)) ||
    Object.keys(pc).some((t) => !pt.includes(t))
  )
    throw new Error("Incomplete private relation column coverage");
  if (
    pt.some((t) => tables.includes(t) || Object.hasOwn(publicColumns, t)) ||
    pf.some((f) => functions.includes(f))
  )
    throw new Error("Ambiguous public/private manifest identity");
  return {
    tables: [...new Set([...tables, ...pt])].sort(),
    functions: [...new Set([...functions, ...pf])].sort(),
    columns: Object.fromEntries(
      Object.entries({ ...publicColumns, ...pc }).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  };
}
