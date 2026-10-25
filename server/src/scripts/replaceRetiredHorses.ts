import { pathToFileURL } from 'node:url';
import { replacePatternedHorses } from '../services/HorseReplacementBatch.js';

export function replacementExecutionMode(args: string[]): boolean {
  if (args.length === 0 || (args.length === 1 && args[0] === '--inspect')) return false;
  if (args.length === 1 && args[0] === '--execute') return true;
  throw new Error('Use --inspect or --execute for the original 62-horse replacement batch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error('Configured Supabase service environment is required');
    console.log(
      JSON.stringify(await replacePatternedHorses(replacementExecutionMode(process.argv.slice(2))))
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
