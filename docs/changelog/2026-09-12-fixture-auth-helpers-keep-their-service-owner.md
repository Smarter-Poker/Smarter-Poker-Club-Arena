# Fixture Auth helpers keep their service owner

The application fixture previously expected its schema to create four Auth
claim helpers as postgres. Production assigns them to supabase_auth_admin and
does not grant postgres CREATE on the Auth schema. The disposable fixture now
installs their captured definitions through the original socket bootstrap,
using the Auth role after genuine GoTrue migrations. It refuses existing
helpers, verifies bodies, attributes and direct grants, and rolls back errors.

The native smoke verifies that the non-superuser application role cannot replace
a helper. Two real signed-in users, including the MFA user, then exercise uid,
role, email and jwt through PostgREST; anonymous claims remain anonymous. The
full application entrypoint checks the helpers again after schema restoration.
This prepares the service-owned portion of full-schema qualification. It does
not certify the complete application schema or any funded route.
