# Isolated REST Startup Uses Its Actual Readiness Endpoint

Actual qualification37892962672 reports Auth200, REST root-request timeout and both containers running. The root request asks PostgREST to generate the full OpenAPI schema description; it is not a dedicated startup-health request. The precise internal cause of that timeout is not observed.

Enable only the disposable container's internal admin port3001 and require its `/ready` response. The pinned PostgREST14.5 source checks the main API socket and loaded/non-pending schema cache there. HTTP503 still refuses readiness. Original50 attempts, one-second requests,100ms pauses, pinned images, catalog/grant comparisons, actual authorization cases and owning cleanup remain intact. No published port, production configuration or timeout change.

Official sources: [PostgREST14 OpenAPI](https://docs.postgrest.org/en/v14/references/api/openapi.html), [admin configuration](https://docs.postgrest.org/en/v14/references/configuration.html#admin-server-port), and [exact14.5 admin implementation](https://github.com/PostgREST/postgrest/blob/v14.5/src/PostgREST/Admin.hs).

Regression verifies the exact endpoint/configuration and that an unloaded-cache503 cannot qualify startup. Full actual Auth qualification remains required after protected merge.
