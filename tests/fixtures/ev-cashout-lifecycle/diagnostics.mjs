// Safe failure metadata only. Never retain a raw provider line or SQL payload.
export function schemaCacheDiagnostics(log, allowedObjects = []) {
  const allowed = new Set(allowedObjects);
  const records = [];
  const categories = [
    ['permission-denied', /permission denied/i],
    ['missing-relation', /relation .+ does not exist/i],
    ['missing-column', /column .+ does not exist/i],
    ['missing-function', /function .+ does not exist/i],
    ['missing-type', /type .+ does not exist/i],
    ['statement-timeout', /canceling statement due to statement timeout/i],
    ['connection-refused', /connection refused/i],
    ['authentication-failed', /password authentication failed/i],
  ];
  for (const line of String(log).slice(-65536).split('\n')) {
    const codes = [
      ...line.matchAll(/"(?:code|sqlstate)"\s*:\s*"([A-Z0-9]{5}|PGRST[0-9]{3})"/g),
    ].map((m) => m[1]);
    const category = categories.find(([, pattern]) => pattern.test(line))?.[0];
    if (!codes.length && !category) continue;
    const objects = [
      ...line.matchAll(
        /(?:relation|schema|function|column|type) (?:\\?")?([A-Za-z_][A-Za-z0-9_.]{0,119})(?:\\?")?/g
      ),
    ]
      .map((m) => m[1])
      .filter((name) => allowed.has(name));
    const record = {
      codes: [...new Set(codes)].slice(0, 4),
      category: category ?? 'provider-error',
      objects: [...new Set(objects)].slice(0, 4),
    };
    if (!records.some((old) => JSON.stringify(old) === JSON.stringify(record)))
      records.push(record);
  }
  return records.slice(-8);
}
