#!/usr/bin/env python3
"""Fail closed on baseline provenance drift and recognizable secret literals."""
import hashlib,json,re
from pathlib import Path
BASE=Path(__file__).resolve().parents[2]/'supabase/bootstrap'
def main():
 manifest=json.loads((BASE/'pokeriq-baseline.json').read_text());source=(BASE/manifest['schemaFile']).read_bytes()
 if len(source)!=manifest['bytes'] or hashlib.sha256(source).hexdigest()!=manifest['schemaSHA256']:raise ValueError('Native baseline bytes differ from provenance')
 for name,expected in [('pokeriq-catalog-reference.json',manifest['catalogSHA256']),('source-history.json',manifest['sourceHistorySHA256']),('pokeriq-platform-contract.json',manifest['platformContractSHA256'])]:
  if hashlib.sha256((BASE/name).read_bytes()).hexdigest()!=expected:raise ValueError('Baseline evidence checksum differs: '+name)
 if hashlib.sha256((BASE.parents[1]/'scripts/schema-rebuild/catalog.sql').read_bytes()).hexdigest()!=manifest['catalogQuerySHA256']:raise ValueError('Catalog comparison query differs from captured source contract')
 if not manifest['allSchemas'] or manifest['dataIncluded']:raise ValueError('Complete schema-only export required')
 patterns={
 'jwt':rb'(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}',
 'private_key':rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'password_url':rb'(?i)postgres(?:ql)?://[^\s:/]+:[^\s@]+@',
 'provider_token':rb'(?<![A-Za-z0-9_])(?:sbp_|sb_secret_|sk_live_|sk_test_|ghp_|github_pat_)[A-Za-z0-9_]{20,}',
 'assigned_secret':rb'''(?i)(?:api_key|access_token|service_role_key|client_secret)\s*[:=]\s*['"][A-Za-z0-9_/-]{24,}''',
 'psql_shell':rb'(?m)^\\!',
 'data_copy':rb'(?m)^COPY [^\n]+ FROM stdin;'}
 findings={name:len(re.findall(pattern,source)) for name,pattern in patterns.items()}
 if any(findings.values()):raise ValueError('Baseline literal review required: '+json.dumps(findings))
 contract=json.loads((BASE/'pokeriq-role-contract.json').read_text());allowed={'default_transaction_read_only','idle_in_transaction_session_timeout','lock_timeout','log_statement','pgrst.db_pre_request','search_path','session_preload_libraries','statement_timeout','synchronous_commit'}
 for role in contract['roles']:
  if any(x.split('=',1)[0] not in allowed for x in role.get('config') or []):raise ValueError('Unreviewed role configuration key')
 print(json.dumps({'nativeSHA256Verified':True,'recognizedSecretLiterals':findings,'roleSettingKeysReviewed':True,'limitation':'Pattern scanning complements source review; it is not a universal secret detector.'}))
if __name__=='__main__':main()
