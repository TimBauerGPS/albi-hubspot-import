# Albi HubSpot Importer

Vite and Netlify application for the existing Albi-to-HubSpot importer and the separate, tenant-scoped HubSpot-to-Albi (H2A) sync module.

## Local development

Install dependencies with `npm install`, then run `npm run dev:local` to start Vite and the Netlify Functions emulator. Use non-production Supabase settings in the local environment. Do not put `SUPABASE_SERVICE_ROLE_KEY` or H2A provider credentials in browser variables.

## H2A verification

Run the deterministic, credential-free smoke self-test with `npm run test:h2a:e2e`. The complete local H2A and schema contract suites are `npm run test:h2a` and `npm run test:h2a:schema`.

The provider smoke script is read-only by default. Its environment variables, write acknowledgements, exact verification limits, schema deployment procedure, security race checklist, and pilot gates are documented in [the H2A pilot runbook](docs/hubspot-to-albi-pilot-runbook.md). Live activation stays blocked until the outstanding Albi contracts and disposable Supabase checks are complete.
