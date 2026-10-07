# Albi HubSpot Importer

Vite and Netlify application for the existing Albi-to-HubSpot importer and the separate, tenant-scoped HubSpot-to-Albi (H2A) sync module. H2A credentials and scheduled-job secrets are server-side only (`H2A_CREDENTIAL_KEY_V1`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_CRON_SECRET`); never add them to browser/Vite variables.

## Local development

Install dependencies with `npm install`, then run `npm run dev:local` to start Vite and the Netlify Functions emulator. Use non-production Supabase settings in the local environment. Do not put `SUPABASE_SERVICE_ROLE_KEY` or H2A provider credentials in browser variables.

## H2A verification

Run the deterministic, credential-free smoke-orchestration self-test with `npm run test:h2a:e2e`. It covers a read-only plan, guarded create/rerun exactly-once behavior using fake adapters, and zero transport calls when any write acknowledgement is missing. The complete local H2A and schema contract suites are `npm run test:h2a` and `npm run test:h2a:schema`.

The provider smoke script is read-only by default. When write mode is enabled, all isolation, marker-readback, run-ID, and URL-override guards are validated before any provider request, including HubSpot read-semantics POSTs. Its test environment variables, exact verification limits, schema deployment procedure, safe manual key rotation, security race checklist, and pilot gates are documented in [the H2A pilot runbook](docs/hubspot-to-albi-pilot-runbook.md). Live activation stays blocked until the outstanding Albi contracts and disposable Supabase checks are complete.
