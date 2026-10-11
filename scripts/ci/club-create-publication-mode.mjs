#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublisherArtifactSha } from './production-e2e-provenance.mjs';
import { receiptArtifactId } from './client-runtime-retention.mjs';
export function publicationMode(raw, run, trigger, repository) {
  const payload = JSON.parse(String(raw));
  if (!Array.isArray(payload.artifacts) || payload.total_count !== payload.artifacts.length)
    throw new Error('Complete exact publisher artifact metadata required.');
  const bundles = payload.artifacts.filter(
    (a) => typeof a.name === 'string' && a.name.startsWith('club-arena-dist-')
  );
  const retained = payload.artifacts.filter((a) => a.name === 'club-arena-retained-runtime');
  if (bundles.length === 1 && retained.length === 0) {
    readPublisherArtifactSha(raw, run, trigger, repository);
    return 'published';
  }
  if (retained.length === 1 && bundles.length === 0) {
    receiptArtifactId(payload, run, trigger, repository);
    return 'retained';
  }
  throw new Error('Exactly one published bundle or one retained runtime receipt required.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(publicationMode(readFileSync(0, 'utf8'), ...process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
