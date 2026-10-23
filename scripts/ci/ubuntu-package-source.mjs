import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep Ubuntu's signed suites and package versions, avoiding the slow Azure mirror. */
export function preferOfficialUbuntuSource(source) {
  const result = source.replace(
    /^URIs:[\t ]*(?:mirror\+file:\/etc\/apt\/apt-mirrors\.txt|https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?|http:\/\/archive\.ubuntu\.com\/ubuntu\/?)[\t ]*(?=\r?$)/gm,
    'URIs: https://archive.ubuntu.com/ubuntu'
  );
  if (/^URIs:.*(?:azure\.archive\.ubuntu\.com|mirror\+file:)/m.test(result)) {
    throw new Error('Unsupported Ubuntu mirror list; refusing an unverified source rewrite');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path || basename(path) !== 'ubuntu.sources' || process.argv.length !== 3) {
    throw new Error('Expected the private copied ubuntu.sources file');
  }
  writeFileSync(path, preferOfficialUbuntuSource(readFileSync(path, 'utf8')));
  console.log('Ubuntu package downloads use the official signed archive.');
}
