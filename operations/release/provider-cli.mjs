#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { configuration, connect, sanitizedError } from './journal.mjs';
import { providerCall } from './provider-journal.mjs';

let client;
try {
  const [command, filename, actor] = process.argv.slice(2);
  if (
    !['plan', 'register-installation', 'recheck'].includes(command) ||
    !filename ||
    !actor ||
    process.argv.length !== 5
  )
    throw new Error('RELEASE_ARGUMENT_INVALID');
  const value = JSON.parse(await readFile(filename, 'utf8'));
  client = await connect(configuration());
  const result =
    command === 'recheck'
      ? await providerCall(client, 'authorize_provider_readback', [
          value.operation_id,
          actor,
          value.reason,
        ])
      : command === 'plan'
        ? await providerCall(client, 'submit_provider_plan', [
            value.release_id,
            value.operation_key,
            value.adapter,
            value.request,
            actor,
          ])
        : await providerCall(client, 'register_provider_installation', [
            value.bundle_digest,
            value.binding,
            value.evidence,
            actor,
          ]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizedError(error))}\n`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
