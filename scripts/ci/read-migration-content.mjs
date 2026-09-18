import { createHash } from 'node:crypto';

// Bounded complete SQL data for the trusted verifier, never executable code.
// A recorded migration reached 1,000,956 bytes; Contents omits inline content
// above 1 MiB. Keep a finite 5 MB budget and bind any blob read to captured HEAD.
export async function readMigrationContent(gh, file, headSha) {
  if (!/^supabase\/migrations\/[^/]+\.sql$/.test(file) || !/^[a-f0-9]{40}$/.test(headSha)) {
    throw Error('invalid migration identity');
  }
  const data = await gh(`contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${headSha}`, 'application/vnd.github.object+json');
  if (data.type !== 'file' || !Number.isSafeInteger(data.size) || data.size < 0 || data.size > 5000000 || !/^[a-f0-9]{40}$/.test(data.sha)) {
    throw Error('invalid migration metadata or size limit');
  }
  let blob = data;
  if (data.encoding === 'none' && data.content === '') {
    // Never follow a candidate-provided download_url or another repository.
    blob = await gh(`git/blobs/${data.sha}`);
  }
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size !== data.size || blob.sha !== data.sha || blob.content.length > 7000000) {
    throw Error('invalid migration blob');
  }
  const encoded = blob.content.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length !== data.size) {
    throw Error('migration content size or encoding mismatch');
  }
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (sha !== data.sha) throw Error('migration content hash mismatch');
  const sql = bytes.toString('utf8');
  if (!Buffer.from(sql).equals(bytes)) throw Error('invalid migration UTF-8');
  return sql;
}
