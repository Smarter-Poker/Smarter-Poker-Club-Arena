// Supavisor can replace startup application_name. Bind the existing installer
// identity on the backend that owns this transaction, without changing source
// bytes recorded in migration history or exempting any other session.
export function bindMigrationSession(sql) {
  const bound = sql.replace(
    /^([ \t]*BEGIN[ \t]*;)/im,
    "$1\nSET LOCAL application_name = 'apply-recorded-migration';"
  );
  if (bound === sql) throw new Error('Migration transaction has no initial BEGIN statement');
  return bound;
}
