import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runV56PrivateReplay } from '../services/horseCorrectiveReview/v56PrivateReplay.js';
export async function runHorseV56PrivateReplay(args: readonly string[]) {
  if (
    args.length !== 3 ||
    !['context', 'replay', 'finalize'].includes(args[0]!) ||
    !isAbsolute(args[1]!) ||
    !isAbsolute(args[2]!)
  )
    return {
      code: 64,
      output:
        'Usage: horseV56PrivateReplay context|replay|finalize <absolute-private-input> <new-private-output>\n',
    };
  return runV56PrivateReplay(args[0]!, args[1]!, args[2]!);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await runHorseV56PrivateReplay(process.argv.slice(2));
  process.stdout.write(r.output);
  process.exitCode = r.code;
}
