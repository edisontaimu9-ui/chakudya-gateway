# chakudya-gateway

One Worker in front of chakudya-api.

- `/p/<api path>` public docs traffic. Allowlisted routes only; the docs site consumer key stays server-side. 60 req/min per IP, GETs cached 60s at the edge.
- `/a/<api path>` admin monitor. Supabase login token + `ADMIN_EMAILS` allowlist, GET only, only paths in `ADMIN_GET_PATHS`.

Secrets (dashboard -> chakudya-gateway -> Settings -> Variables and Secrets): `DOCS_SITE_KEY`, `ADMIN_API_KEY`, `ADMIN_EMAILS`.
Repo secret for deploy: `CLOUDFLARE_API_TOKEN`.

Test: `curl -H "Origin: https://edisontaimu9-ui.github.io" "https://chakudya-gateway.edisontaimu9.workers.dev/p/health"`
