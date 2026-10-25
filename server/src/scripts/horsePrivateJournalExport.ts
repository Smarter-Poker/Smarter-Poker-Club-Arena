/** Compiled, stdin-only private transport endpoint. Its stdout is private SSH
 * payload and must be captured, never written into an Actions log/artifact. */
import { pathToFileURL } from 'node:url';
import {
  exportCanonicalHorseJournalBatch,
  JOURNAL_EXPORT_MAX_BYTES,
} from '../services/horseCorrectiveReview/journalTransport.js';
export async function runHorsePrivateJournalExport(
  args: readonly string[],
  input: AsyncIterable<Uint8Array | string>,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ code: number; output: string }> {
  if (args.length) return { code: 64, output: '' };
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      const b = Buffer.from(chunk);
      bytes += b.length;
      if (bytes > 65536) throw Error();
      chunks.push(b);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'handKeys,version' ||
      (value as { version?: unknown }).version !== 1
    )
      throw Error();
    const result = exportCanonicalHorseJournalBatch(
      (value as { handKeys: readonly string[] }).handKeys,
      environment
    );
    if (!result) throw Error();
    const output = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(output) > JOURNAL_EXPORT_MAX_BYTES) throw Error();
    return { code: 0, output };
  } catch {
    return { code: 3, output: '' };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A finite operator command does not own the engine's lobby publisher.
  // Keep cleanup inside direct execution so importing helpers leaves it live.
  const { channelHub } = await import('../hub/ChannelHub.js');
  channelHub.close();
  const result = await runHorsePrivateJournalExport(process.argv.slice(2), process.stdin);
  process.stdout.write(result.output);
  process.exitCode = result.code;
}
