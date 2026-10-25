import { pathToFileURL } from 'node:url';
import { supabase } from '../services/supabase/client.js';
import {
  boardReplacementHorses,
  replacementBoardingAdapter,
} from '../services/HorseReplacementBoarding.js';
export function boardingMode(args: string[]) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--inspect')) return false;
  if (args.length === 1 && args[0] === '--execute') return true;
  throw Error('Use --inspect or --execute for the finite original DSS boarding operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const url = process.env.SUPABASE_URL,
      key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw Error('Configured Supabase service environment required');
    console.log(
      JSON.stringify(
        await boardReplacementHorses(
          boardingMode(process.argv.slice(2)),
          replacementBoardingAdapter(supabase, url)
        )
      )
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
