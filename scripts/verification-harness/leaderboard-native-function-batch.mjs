// Exact PG17.11 source transformation for isolated schema qualification only.
// Native selection, serialization, dependencies and archive handling remain upstream.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const upstreamSHA256 = '8576b36741608e0a956b51e98e1b41b76877a95eb9091300b66c2eaa0faf78f8';
export function batchNativeFunctions(source) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    upstreamSHA256,
    'Unsupported native source bytes'
  );
  const begin = source.indexOf('static void\ndumpFunc(Archive *fout, const FuncInfo *finfo)\n');
  const end = source.indexOf('\nstatic void\ndumpCast(', begin);
  assert.ok(begin > 0 && end > begin);
  let fn = source.slice(begin, end);
  const replace = (old, next) => {
    assert.equal(fn.split(old).length, 2, 'Native source anchor changed');
    fn = fn.replace(old, next);
  };
  replace(
    '\tPGresult   *res;',
    '\tPGresult   *res;\n\tstatic PGresult *batch_result = NULL;\n\tint batch_row = -1;'
  );
  replace(
    '\tif (!fout->is_prepared[PREPQUERY_DUMPFUNC])',
    '\tif (fout->remoteVersion < 170000 || fout->remoteVersion >= 180000)\n\t\tpg_fatal("batched function metadata requires PostgreSQL 17");\n\n\tif (batch_result == NULL)'
  );
  replace(
    '\t\t/* Set up query for function-specific details */\n\t\tappendPQExpBufferStr(query,\n\t\t\t\t\t\t\t "PREPARE dumpFunc(pg_catalog.oid) AS\\n");',
    '\t\tDumpableObject **objects;\n\t\tint object_count;\n\t\tint selected_count = 0;\n\t\tgetDumpableObjects(&objects, &object_count);'
  );
  replace('"SELECT\\n"', '"SELECT p.oid AS lb_oid,\\n"');
  replace(
    '"WHERE p.oid = $1 "\n\t\t\t\t\t\t\t "AND l.oid = p.prolang");\n\n\t\tExecuteSqlStatement(fout, query->data);\n\n\t\tfout->is_prepared[PREPQUERY_DUMPFUNC] = true;',
    `"WHERE l.oid = p.prolang AND p.oid IN (0");
        for (int i = 0; i < object_count; i++)
        {
            if (objects[i]->objType == DO_FUNC && objects[i]->dump)
            {
                appendPQExpBuffer(query, ",%u", objects[i]->catId.oid);
                selected_count++;
            }
        }
        appendPQExpBufferStr(query, ") ORDER BY p.oid");
        pg_free(objects);
        batch_result = ExecuteSqlQuery(fout, query->data, PGRES_TUPLES_OK);
        if (PQntuples(batch_result) != selected_count)
            pg_fatal("batched function metadata count differs from native selection");`
  );
  replace(
    '\tprintfPQExpBuffer(query,\n\t\t\t\t\t  "EXECUTE dumpFunc(\'%u\')",\n\t\t\t\t\t  finfo->dobj.catId.oid);\n\n\tres = ExecuteSqlQueryForSingleRow(fout, query->data);',
    `    /* Ordered OIDs map each exact native function to one cached result row. */
    {
        int lower = 0;
        int upper = PQntuples(batch_result) - 1;
        while (lower <= upper)
        {
            int middle = lower + (upper - lower) / 2;
            Oid found = atooid(PQgetvalue(batch_result, middle, 0));
            if (found == finfo->dobj.catId.oid) { batch_row = middle; break; }
            if (found < finfo->dobj.catId.oid) lower = middle + 1;
            else upper = middle - 1;
        }
    }
    if (batch_row < 0)
        pg_fatal("native function missing from batched metadata");
    res = PQcopyResult(batch_result, PG_COPYRES_ATTRS | PG_COPYRES_NOTICEHOOKS);
    if (res == NULL)
        pg_fatal("cannot allocate native function metadata result");
    for (int column = 0; column < PQnfields(batch_result); column++)
    {
        bool missing = PQgetisnull(batch_result, batch_row, column);
        if (!PQsetvalue(res, 0, column,
                        missing ? NULL : PQgetvalue(batch_result, batch_row, column),
                        missing ? -1 : PQgetlength(batch_result, batch_row, column)))
            pg_fatal("cannot copy native function metadata result");
    }`
  );
  assert.ok(!fn.includes('PREPARE dumpFunc') && !fn.includes('EXECUTE dumpFunc'));
  return source.slice(0, begin) + fn + source.slice(end);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 4);
    writeFileSync(process.argv[3], batchNativeFunctions(readFileSync(process.argv[2], 'utf8')));
    console.log(
      'Pinned native function batching prepared. Runtime qualification remains required.'
    );
  } catch {
    console.error('Native batch transformation refused. Private source omitted.');
    process.exitCode = 1;
  }
}
