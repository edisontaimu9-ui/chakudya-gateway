# chakudya-gateway

One Worker in front of chakudya-api.

- `/p/<api path>` public docs traffic. Allowlisted routes only; the docs site consumer key stays server-side. 60 req/min per IP, GETs cached 60s at the edge.
- `/a/<api path>` admin monitor. Supabase login token + `ADMIN_EMAILS` allowlist, GETs only on paths in `ADMIN_GET_PATHS` (overview, activity, monitoring, usage, keys, health, packaged review queue, `/rag/jobs` ingest jobs, `/fhir/AuditEvent` audit log). Writes (while `ADMIN_WRITES=true`): create/revoke keys, approve/reject packaged-food submissions (`reviewed_by` is set to the verified admin email).

Secrets (dashboard -> chakudya-gateway -> Settings -> Variables and Secrets): `DOCS_SITE_KEY`, `ADMIN_API_KEY`, `ADMIN_EMAILS`.
Repo secret for deploy: `CLOUDFLARE_API_TOKEN`.

Test: `curl -H "Origin: https://edisontaimu9-ui.github.io" "https://chakudya-gateway.edisontaimu9.workers.dev/p/health"`
