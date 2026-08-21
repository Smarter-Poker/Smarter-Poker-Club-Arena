const fs = require('fs');
const file = 'src/pages/UnionDashboardPage.tsx';
let content = fs.readFileSync(file, 'utf8');

const originalQuery = `const { data: poolRow } = await supabase
      .from('bbj_pools')
      .select(
        'id, main_balance, backup_balance, promo_balance, total_contributed, total_paid_out, hit_count, last_hit_at, last_hit_amount'
      )
      .eq('union_id', uid)
      .eq('status', 'active')
      .maybeSingle();`;

const newQuery = `const { data: poolRows } = await supabase
      .from('bbj_pools')
      .select(
        'id, main_balance, backup_balance, promo_balance, total_contributed, total_paid_out, hit_count, last_hit_at, last_hit_amount'
      )
      .eq('status', 'active')
      .or(\`union_id.eq.\${uid},club_id.in.(\${clubIds.length ? clubIds.join(',') : '00000000-0000-0000-0000-000000000000'})\`);
      
    let poolRow = null;
    if (poolRows && poolRows.length > 0) {
      poolRow = { ...poolRows[0] };
      poolRow.main_balance = 0;
      poolRow.backup_balance = 0;
      poolRow.promo_balance = 0;
      poolRow.hit_count = 0;
      for (const row of poolRows) {
        poolRow.main_balance += Number(row.main_balance) || 0;
        poolRow.backup_balance += Number(row.backup_balance) || 0;
        poolRow.promo_balance += Number(row.promo_balance) || 0;
        poolRow.hit_count += Number(row.hit_count) || 0;
      }
    }`;

content = content.replace(originalQuery, newQuery);

fs.writeFileSync(file, content);
