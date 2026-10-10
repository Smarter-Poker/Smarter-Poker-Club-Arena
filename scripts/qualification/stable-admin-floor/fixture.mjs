import fs from 'node:fs';
import path from 'node:path';
export const root = path.resolve(import.meta.dirname, '../../..');
export function original(relative, name, owner = root) {
  const source = fs.readFileSync(path.join(owner, relative), 'utf8');
  const pattern = new RegExp(`create(?: or replace)? function public\\.${name}\\s*\\(`, 'i');
  const match = pattern.exec(source);
  if (!match) throw Error(`Original function absent: ${name}`);
  const rest = source.slice(match.index);
  const delimiter = /\bas\s+(\$\w*\$)/i.exec(rest);
  if (!delimiter) throw Error(`Function delimiter absent: ${name}`);
  const end = rest.indexOf(delimiter[1], delimiter.index + delimiter[0].length);
  if (end < 0) throw Error(`Function body end absent: ${name}`);
  return rest.slice(0, end + delimiter[1].length) + ';';
}
export function fixtureSql() {
  const functions = [
    ['supabase/migrations/20260420013503_phase6_1_8_admin_audit_log.sql','fn_log_admin_action'],
    [
      'supabase/migrations/20260828090000_the_engine_is_a_role_not_the_absence_of_a_user.sql',
      'fn_caller_is_engine',
    ],
    [
      'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql',
      'fn_ensure_club_wallet',
    ],
    [
      'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql',
      'fn_player_home_club',
    ],
    [
      'supabase/migrations/20260905064000_booted_for_low_vpip_is_barred_for_two_hours.sql',
      'fn_cash_session_close',
    ],
    [
      'supabase/migrations/20260909031958_club_credit_requires_an_actual_destination_wallet_write.sql',
      'atomic_credit_wallet_and_log',
    ],
    [
      'supabase/migrations/20260908021452_diamond_rules_wired_for_refusal_and_the_money_paths_finished.sql',
      'fn_ca_diamond_rule_mode',
    ],
    ['supabase/migrations/20260909065458_poker_diamond_custody.sql', 'add_diamonds_to_balance'],
    [
      'supabase/migrations/20260911151623_a_diamond_transfer_names_both_sides_and_never_burns_what_it.sql',
      'fn_ca_diamond_journal_is_transfer',
    ],
    [
      'supabase/migrations/20260930055147_the_journal_explains_the_balance.sql',
      'fn_ca_diamond_journal_origin',
    ],
    [
      'supabase/migrations/20260908060643_the_register_lost_a_movement.sql',
      'fn_ca_register_diamond_journal_row',
    ],
    [
      'supabase/migrations/20260910022036_diamond_cash_custody_settles_exact_seat_generations.sql',
      'fn_poker_diamond_release',
    ],
    [
      'supabase/migrations/20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql',
      'fn_poker_diamond_cashout',
    ],
    [
      'supabase/migrations/20260908220604_bind_cashout_requests_to_seat_occupancy.sql',
      'fn_request_seat_departure',
    ],
    [
      'supabase/migrations/20260909040806_admin_departure_authority_is_recorded_before_cashout.sql',
      'fn_request_admin_seat_departure',
    ],
    [
      'supabase/migrations/20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql',
      'atomic_seat_cashout_locked',
    ],
    [
      'supabase/migrations/20260910023541_diamond_cash_admission_binds_existing_purchase_receipts.sql',
      'fn_cashout_seat_occupancy',
    ],
  ];
  return (
    fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(import.meta.dirname, 'operator-permissions-original.sql'), 'utf8') +
    '\n' +
    functions.map(([file, name, owner]) => original(file, name, owner)).join('\n') +
    '\n' +
    fs.readFileSync(
      path.join(
        root,
        'supabase/migrations/20261010035502_stable_admin_engine_operator_commands.sql'
      ),
      'utf8'
    )
  );
}
