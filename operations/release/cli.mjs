#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { call, configuration, connect, observe, sanitizedError } from './journal.mjs';

const specs = {
  enqueue: ['file', 'key', 'actor'], inspect: ['id', 'after', 'limit', 'after-event'],
  retry: ['id', 'version', 'after', 'class', 'actor', 'reason'],
  withdraw: ['id', 'version', 'actor', 'reason'],
  reconcile: ['file', 'epoch', 'observed-event', 'actor', 'reason'],
  reprioritize: ['id', 'before', 'version', 'actor', 'reason'],
  observe: ['once', 'actor'],
};
function parse(argv) {
  const [command, ...rest] = argv;
  if (!specs[command]) throw new Error('RELEASE_COMMAND_NOT_ALLOWED');
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!specs[command].includes(name) || Object.hasOwn(options, name)) throw new Error('RELEASE_ARGUMENT_INVALID');
    if (name === 'once') options[name] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('RELEASE_ARGUMENT_REQUIRED');
      options[name] = rest[++i];
    }
  }
  const optional = command === 'inspect' ? specs.inspect : command === 'observe' ? ['once', 'actor'] : [];
  for (const name of specs[command]) if (!optional.includes(name) && !options[name]) throw new Error('RELEASE_ARGUMENT_REQUIRED');
  return { command, options };
}
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let client;
try {
  const { command, options: o } = parse(process.argv.slice(2));
  const config = configuration();
  if (command === 'observe') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    await observe(config, { once: o.once, actor: o.actor, signal: controller.signal,
      emit: print, onReconnect: error => process.stderr.write(`${JSON.stringify(error)}\n`) });
  } else {
    let args;
    if (command === 'enqueue') args = [o.key, JSON.parse(await readFile(o.file, 'utf8')), o.actor];
    if (command === 'inspect') args = [o.id ?? null, o.after ?? 0, o.limit ?? 100, o['after-event'] ?? 0];
    if (command === 'retry') args = [o.id, o.version, o.after, o.class, o.actor, o.reason];
    if (command === 'withdraw') args = [o.id, o.version, o.actor, o.reason];
    if (command === 'reconcile') args = [o.epoch, o['observed-event'], JSON.parse(await readFile(o.file, 'utf8')), o.actor, o.reason];
    if (command === 'reprioritize') args = [o.id, o.before, o.version, o.actor, o.reason];
    client = await connect(config);
    print(await call(client, command, args));
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(sanitizedError(error))}\n`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
