const { createClient } = require('@supabase/supabase-js');

const url = "https://kuklfnapbkmacvwxktbh.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt1a2xmbmFwYmttYWN2d3hrdGJoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzczMDg0NCwiZXhwIjoyMDgzMzA2ODQ0fQ.bbDqj-me78PID99npWCZ5qUuINSC1-eCBb1BVhgiSRs";

const supabase = createClient(url, key);

async function run() {
  console.log("Wiping...");
  
  // NOTE: If execute_sql is not defined, we'll try something else.
  // Actually, we can use the direct supabase JS client methods to update rows instead of raw SQL!
  
  // 1. UPDATE table_seats
  const res1 = await supabase
    .from('table_seats')
    .update({ left_at: new Date().toISOString(), leave_pending: false, is_sitting_out: true })
    .is('left_at', null)
    .or('user_id.not.is.null,horse_id.not.is.null');
  console.log("Seats Updated:", res1.error ? res1.error : res1.status);

  // 2. UPDATE tables
  const res2 = await supabase
    .from('tables')
    .update({ 
      status: 'closed', 
      is_deleted: true, 
      deleted_at: new Date().toISOString(),
      current_players: 0, 
      live_state: '{}', 
      updated_at: new Date().toISOString() 
    })
    .in('status', ['running','waiting','paused','active','live']);
  console.log("Tables Updated:", res2.error ? res2.error : res2.status);

  // 3. DELETE FROM table_hole_cards
  // supabase doesn't support DELETE without filters cleanly if no rows exist, but we can try ne id
  const res3 = await supabase.from('table_hole_cards').delete().neq('table_id', '00000000-0000-0000-0000-000000000000');
  console.log("Hole Cards Deleted:", res3.error ? res3.error : res3.status);

  // 4. UPDATE tournaments
  const res4 = await supabase
    .from('tournaments')
    .update({ status: 'CANCELLED' })
    .in('status', ['ANNOUNCED','REGISTERING','RUNNING']);
  console.log("Tournaments Updated:", res4.error ? res4.error : res4.status);

  // Verify counts
  const tables = await supabase.from('tables').select('id', {count: 'exact'}).neq('status', 'closed');
  const seats = await supabase.from('table_seats').select('id', {count: 'exact'}).is('left_at', null).or('user_id.not.is.null,horse_id.not.is.null');
  const cards = await supabase.from('table_hole_cards').select('id', {count: 'exact'});
  const tourns = await supabase.from('tournaments').select('id', {count: 'exact'}).in('status', ['RUNNING','REGISTERING','ANNOUNCED']);

  console.log(`Verify Stats:`);
  console.log(`non_closed_tables: ${tables.count}`);
  console.log(`active_seats: ${seats.count}`);
  console.log(`hole_cards: ${cards.count}`);
  console.log(`live_tournaments: ${tourns.count}`);
}

run();
