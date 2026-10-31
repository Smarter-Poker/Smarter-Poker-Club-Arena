import { createHash } from 'node:crypto';

// Exactly six current application hooks on genuine service tables. These are
// not core service objects and must survive the source-bound composition. The
// diamonds trigger's historical CREATE is absent; its protected function repair
// and independently captured trigger declaration are stated explicitly.
const witnesses = [
  {
    "schema_name": "auth",
    "relation_name": "users",
    "trigger_name": "on_auth_user_created",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "handle_new_user",
    "definition": "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()",
    "source": {
      "path": "supabase/migrations/20260126200_auto_init_users.sql",
      "sha256": "50ee9dd57393be1fe97dbf07b1a31df572f32c73bec38b182aec86aa5d4bf901",
      "kind": "protected-migration-creation"
    },
    "definition_sha256": "ab9bf2a610d02b1236cfdbe1b6f7aef91ea6571808059d799b60781c15ee10fe"
  },
  {
    "schema_name": "auth",
    "relation_name": "users",
    "trigger_name": "on_auth_user_created_diamonds",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "initialize_user_diamonds",
    "definition": "CREATE TRIGGER on_auth_user_created_diamonds AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.initialize_user_diamonds()",
    "source": {
      "path": "supabase/migrations/20260503055427_fix_initialize_user_diamonds_security_definer.sql",
      "sha256": "89b66d8508a48c9b54a98c0780144b7b8c91fc2f271ba82899f1166a3fd1c3da",
      "kind": "protected-function-repair-and-live-trigger-metadata"
    },
    "definition_sha256": "472e74c74c7b4b9468b3a8f4bead8d9657bb96b59ac895cc6b95e679008e49a6"
  },
  {
    "schema_name": "auth",
    "relation_name": "users",
    "trigger_name": "on_auth_user_created_wallet",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "handle_new_user_v2_create_wallet",
    "definition": "CREATE TRIGGER on_auth_user_created_wallet AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_v2_create_wallet()",
    "source": {
      "path": "supabase/migrations/20260429144231_x35_signup_trigger_creates_wallet_plus_backfill.sql",
      "sha256": "173fa5b25fd367b0008a01f019414524ae36ead42b252f98f66d4fee12cce0d0",
      "kind": "protected-migration-creation"
    },
    "definition_sha256": "6571d508a8d0eef43f4ff9d02d1e094c293257e9d660797c0e0ca1abe8cb3b48"
  },
  {
    "schema_name": "auth",
    "relation_name": "users",
    "trigger_name": "on_auth_user_email_confirmed_referral",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "tr_auth_user_confirmed_settles_referral",
    "definition": "CREATE TRIGGER on_auth_user_email_confirmed_referral AFTER UPDATE OF email_confirmed_at ON auth.users FOR EACH ROW WHEN (((old.email_confirmed_at IS NULL) AND (new.email_confirmed_at IS NOT NULL))) EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral()",
    "source": {
      "path": "supabase/migrations/20261019092248_every_confirmed_referral_is_paid_once_and_the_pending_one_co.sql",
      "sha256": "d27dd34c735ab8a7909eff875f9a9a127e9ea6111e174227a2eaddbc96c46d53",
      "kind": "protected-migration-creation"
    },
    "definition_sha256": "ef0b065496ebb81d773dcab6d4283a8d9cb7c271aedb3bb12c04d835ab35193b"
  },
  {
    "schema_name": "auth",
    "relation_name": "users",
    "trigger_name": "on_auth_user_inserted_confirmed_referral",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "tr_auth_user_confirmed_settles_referral",
    "definition": "CREATE TRIGGER on_auth_user_inserted_confirmed_referral AFTER INSERT ON auth.users FOR EACH ROW WHEN ((new.email_confirmed_at IS NOT NULL)) EXECUTE FUNCTION public.tr_auth_user_confirmed_settles_referral()",
    "source": {
      "path": "supabase/migrations/20261019092248_every_confirmed_referral_is_paid_once_and_the_pending_one_co.sql",
      "sha256": "d27dd34c735ab8a7909eff875f9a9a127e9ea6111e174227a2eaddbc96c46d53",
      "kind": "protected-migration-creation"
    },
    "definition_sha256": "c738784db19ad5423113afe729ec63ea0cc77de32cdac2c25961859b66fc6b32"
  },
  {
    "schema_name": "cron",
    "relation_name": "job_run_details",
    "trigger_name": "ca_cash_failed_run_intake",
    "enabled": "O",
    "function_schema": "public",
    "function_name": "fn_ca_cash_failed_run_intake",
    "definition": "CREATE TRIGGER ca_cash_failed_run_intake AFTER INSERT OR UPDATE ON cron.job_run_details FOR EACH ROW WHEN (((new.jobid = 259) AND (new.status = 'failed'::text))) EXECUTE FUNCTION public.fn_ca_cash_failed_run_intake()",
    "source": {
      "path": "supabase/migrations/20260917054616_cash_pot_check_evidence_and_failed_run_intake.sql",
      "sha256": "fc57b49e1141f69327be9cca1763c353ebaaa3d74e33d983920bcb3565c0bf2a",
      "kind": "protected-migration-creation"
    },
    "definition_sha256": "d9290996d4e0b26adea089c8d6394f433478905ecc697aedc97512286464f7ad"
  }
];
export const APPLICATION_TRIGGER_WITNESSES = Object.freeze(witnesses.map((item) =>
  Object.freeze({ ...item, source: Object.freeze(item.source) })));

// Only this fixed trigger grammar is accepted. Identifier quoting and SQL case
// fold canonically; string literals/operators/conditions remain exact. There is
// no caller whitelist, arbitrary replacement DDL or unknown managed fallback.
function tokens(sql) {
  const result = [];
  const token = /(?:\s+|--[^\n]*(?:\n|$))|"(?:[^"]|"")*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|::|[().,;=]/y;
  let offset = 0;
  while (offset < sql.length) {
    token.lastIndex = offset;
    const match = token.exec(sql);
    if (!match) throw new Error('SCHEMA_APPLICATION_TRIGGER_REFUSED');
    const value = match[0]; offset = token.lastIndex;
    if (/^\s|^--/.test(value)) continue;
    result.push(value.startsWith('"') ? ['word', value.slice(1,-1).replaceAll('""','"')] :
      value.startsWith("'") ? ['literal', value.slice(1,-1).replaceAll("''","'")] :
      /^[A-Za-z_]/.test(value) ? ['word',value.toLowerCase()] : ['symbol',value]);
  }
  if (result.at(-1)?.[1] === ';') result.pop();
  return JSON.stringify(result);
}

export function applicationTriggerWitness(item) {
  if (item.type !== 'TRIGGER') return null;
  const witness = APPLICATION_TRIGGER_WITNESSES.find((entry) => item.schema === entry.schema_name &&
    item.name === entry.relation_name + ' ' + entry.trigger_name);
  if (!witness) return null;
  if (witness.enabled !== 'O' || tokens(item.text) !== tokens(witness.definition))
    throw new Error('SCHEMA_APPLICATION_TRIGGER_REFUSED');
  return { key:item.key, block_sha256:createHash('sha256').update(item.text).digest('hex'),
    definition_sha256:witness.definition_sha256, enabled:witness.enabled,
    function_schema:witness.function_schema, function_name:witness.function_name, source:witness.source };
}
