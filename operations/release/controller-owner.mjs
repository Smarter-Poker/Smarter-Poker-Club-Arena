import { configuration } from './journal.mjs';
import { rootOwnedFile } from './installed-bundle.mjs';

const need = (value) => {
  if (!value) throw new Error('RELEASE_CONTROLLER_IDENTITY_REQUIRED');
};

// Installed controller/upgrade entrypoints require an exact narrow owner before
// LISTEN or acquire_owner. An environment label alone is not TLS evidence.
export async function controllerDatabase(config, environment = process.env, read = rootOwnedFile) {
  const owner = config.journal;
  need(/^[a-z_][a-z0-9_]{0,62}$/.test(owner?.database_principal ?? ''));
  const database = configuration({ ...environment, RELEASE_JOURNAL_MODE: 'OBSERVE' });
  const url = new URL(database.connectionString);
  const login = owner.database_username ?? owner.database_principal;
  need(
    login === owner.database_principal ||
      (environment.RELEASE_JOURNAL_CONNECTION_MODE === 'session' &&
        new RegExp(`^${owner.database_principal}\\.[a-z]{20}$`).test(login))
  );
  need(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.hostname &&
      decodeURIComponent(url.username) === login
  );
  // pg's URL SSL parameters can replace the supplied CA options. Require the
  // root-owned CA below to be the sole TLS configuration source.
  need(![...url.searchParams.keys()].some((key) => /^ssl/i.test(key)));
  const ca = await read(owner.database_ca_path);
  need(ca.length > 0);
  return {
    ...database,
    ssl: { ca, rejectUnauthorized: true },
    application_name: 'club-arena-release-controller',
    ownerPrincipal: owner.database_principal,
  };
}

export async function verifyControllerPrincipal(client, principal) {
  need(
    /^[a-z_][a-z0-9_]{0,62}$/.test(principal ?? '') &&
      client.connection?.stream?.encrypted === true &&
      client.connection.stream.authorized === true
  );
  const result = await client.query(`SELECT rolname,
    rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND NOT rolbypassrls
    AND pg_has_role(oid,'release_journal_controller','MEMBER')
    AND NOT EXISTS (SELECT 1 FROM pg_roles authority WHERE authority.rolname IN
      ('release_journal_operator','release_journal_verifier','release_journal_submitter','release_certification_callback')
      AND pg_has_role(session_user,authority.oid,'MEMBER')) AS allowed
    FROM pg_roles WHERE rolname=session_user`);
  need(
    result.rows.length === 1 &&
      result.rows[0].rolname === principal &&
      result.rows[0].allowed === true
  );
}
