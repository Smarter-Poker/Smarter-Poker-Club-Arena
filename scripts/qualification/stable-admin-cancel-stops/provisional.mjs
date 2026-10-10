import fs from 'node:fs';
import { fixtureSql, migrationSql, refundTriggersSql } from './fixture.mjs';
import {qualify} from './assertions.mjs';
const { PGlite } = await import(process.env.PGLITE_MODULE);
const { pgcrypto } = await import(process.env.PGLITE_MODULE.replace('/index.js','/contrib/pgcrypto.js'));
const db = new PGlite({extensions:{pgcrypto}});
try {
 await db.exec(fixtureSql()); await db.exec(migrationSql());
 await db.exec(fs.readFileSync(new URL('./opening.sql',import.meta.url),'utf8'));
 await db.exec(refundTriggersSql());
 console.log(JSON.stringify({backend:'PGlite provisional; native concurrent gate required',...await qualify(async sql => (await db.exec(sql)).at(-1))}));
} catch(e) { console.error(e.message,e.where,e.detail); process.exitCode=1; }
finally { await db.close(); }
