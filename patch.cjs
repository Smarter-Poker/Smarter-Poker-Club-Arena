const fs = require('fs');
const path = './scripts/ci/supabase-invariants.allowlist.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
data.unbuiltFeatureTables.commission_records = "NOT an unbuilt feature: a REMOVED one. Dropped from the database, surfaced 2026-09-01 by regenerating the manifest truthfully. UI cleanup pending.";
data.unbuiltFeatureTables.commission_history = "NOT an unbuilt feature: a REMOVED one. Dropped from the database, surfaced 2026-09-01 by regenerating the manifest truthfully. UI cleanup pending.";
fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
