#!/usr/bin/env node
/**
 * Phase 6C store row export (G4), for a host that has the engine's database
 * identity in its environment but no TypeScript toolchain (the engine
 * container). Plain JavaScript, supabase-js only, read-only.
 *
 *   docker exec -i club-arena-engine nice -n 19 node --input-type=module - chart_store < this-file > rows.json
 *   docker exec -i club-arena-engine nice -n 19 node --input-type=module - solver_store:postflop < this-file > rows.json
 *
 * The queries are the production loaders' queries, verbatim:
 * fetchGtoChartRows (services/GtoChartLoader.ts) and fetchGtoPostflopSnapshot
 * (services/GtoPostflopLoader.ts, the same 500-row pages in full unique-key
 * order, with the exact count and latest built_at read before and after).
 * The rows are not trusted here: scripts/phase6c-store-snapshot.mjs --from-rows
 * runs them through the loaders' completeness checks and the production store
 * modules, which compute the identity. Nothing is written anywhere but stdout.
 */
import { createClient } from '@supabase/supabase-js';

const store = process.argv[2];
if (store !== 'chart_store' && store !== 'solver_store:postflop')
  throw new Error('usage: phase6c-store-export-rows.mjs chart_store|solver_store:postflop');
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const fetchedFrom = new Date().toISOString();
let out;
if (store === 'chart_store') {
  const { data, error } = await supabase
    .from('memory_charts_gold')
    .select(
      'chart_id, game_type, stack_depth, hero_position, villain_action, hand_matrix, created_at'
    );
  if (error) throw new Error(error.message);
  out = { store, table: 'memory_charts_gold', rows: data ?? [], boundary: null };
} else {
  const boundary = async () => {
    const [count, latest] = await Promise.all([
      supabase.from('gto_postflop_compact').select('street', { count: 'exact', head: true }),
      supabase
        .from('gto_postflop_compact')
        .select('built_at')
        .order('built_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (count.error) throw new Error(count.error.message);
    if (latest.error) throw new Error(latest.error.message);
    return { count: count.count, latestBuiltAt: latest.data?.built_at ?? null };
  };
  const before = await boundary();
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase
      .from('gto_postflop_compact')
      .select('street, game_family, position, depth_bucket, texture_class, facing, hand_matrix')
      .order('street', { ascending: true })
      .order('game_family', { ascending: true })
      .order('position', { ascending: true })
      .order('depth_bucket', { ascending: true })
      .order('texture_class', { ascending: true })
      .order('facing', { ascending: true })
      .range(offset, offset + 499);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 500) break;
  }
  const after = await boundary();
  out = { store, table: 'gto_postflop_compact', rows, boundary: { before, after } };
}
process.stdout.write(
  JSON.stringify({
    version: 'phase6c-store-rows-v1',
    ...out,
    fetchedFrom,
    fetchedTo: new Date().toISOString(),
  }) + '\n'
);
