# Albi HubSpot Importer

Vite and Netlify application for the existing Albi-to-HubSpot importer and the separate, tenant-scoped HubSpot-to-Albi (H2A) sync module. H2A uses the Guardian Albi Wrapper at `https://albi.guardianrestoration.com` with a company-scoped key sent only as `X-API-Key`. H2A credentials and scheduled-job secrets are server-side only (`H2A_CREDENTIAL_KEY_V1`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_CRON_SECRET`); never add them to browser/Vite variables.

## Local development

Install dependencies with `npm install`, then run `npm run dev:local` to start Vite and the Netlify Functions emulator. Use non-production Supabase settings in the local environment. Do not put `SUPABASE_SERVICE_ROLE_KEY` or H2A provider credentials in browser variables.

## H2A verification

Run the deterministic, credential-free self-test with `npm run test:h2a:e2e`. It covers smoke orchestration plus admin-only sample review, safe projections, read-only recheck, and the fresh zero-row sample gate for full dry runs using local fixtures. The complete local H2A and schema contract suites are `npm run test:h2a` and `npm run test:h2a:schema`.

Sample Review requires [the review-workflow migration](supabase/h2a-dry-run-review-workflow.sql) before deployment and one new bounded sample afterward. Follow [the sample-review rollout in the pilot runbook](docs/hubspot-to-albi-pilot-runbook.md#sample-review-rollout-after-separate-deployment-approval): external correction, individual recheck, fresh zero-row verification sample, then full dry-run review before live activation. Migration, deployment, and authenticated browser smoke remain deferred pending separate approval.

The provider smoke script is read-only by default. When write mode is enabled, all isolation, marker-readback, run-ID, and URL-override guards are validated before any provider request, including HubSpot read-semantics POSTs. Its test environment variables, exact verification limits, wrapper scopes, schema deployment procedure, safe manual key rotation, security race checklist, and pilot gates are documented in [the H2A pilot runbook](docs/hubspot-to-albi-pilot-runbook.md). Existing-record field or association changes are handled through Conflicts rather than blocking activation.
