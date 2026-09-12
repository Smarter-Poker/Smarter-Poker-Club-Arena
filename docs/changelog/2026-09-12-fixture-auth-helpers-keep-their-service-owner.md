# Fixture Auth helpers keep their service owner

The older application schema expected to create four Auth claim helpers as
postgres. GoTrue already supplies their current definitions under
supabase_auth_admin, and production does not grant postgres CREATE on Auth.
The disposable fixture now verifies GoTrue's exact definitions and attributes,
then aligns the three explicit postgres EXECUTE grants with the captured
production exception. The public EXECUTE grants remain unchanged. No function
is recreated and no Auth migration history is stamped.

The grant transaction refuses unexpected bodies, owners or grants and rolls
back on error. Native smoke verifies that the non-superuser application role
cannot replace a helper. Two real signed-in users, including MFA, exercise uid,
role, email and jwt through PostgREST; anonymous claims stay anonymous. The
full application entrypoint checks identities after schema restoration.
This prepares one part of full-schema qualification. It does not certify the
complete application schema or any funded route.
