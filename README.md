# Albi HubSpot Importer

Vite and Netlify application for the existing Albi-to-HubSpot importer and the separate, tenant-scoped HubSpot-to-Albi (H2A) sync module. H2A uses the [Albi Public API](https://albi-public.readme.io/docs/getting-started) at `https://publicapi.albiware.com/api/v1` with a company key (issued by Albi support, `albi_...`) sent only as `Authorization: Bearer`. While that key lacks `Permissions.Activities.View`, an optional Guardian wrapper key (`X-API-Key`, requires [h2a-albi-wrapper-credential.sql](supabase/h2a-albi-wrapper-credential.sql)) reads activities for the duplicate check only. H2A credentials and scheduled-job secrets are server-side only (`H2A_CREDENTIAL_KEY_V1`, `SUPABASE_SERVICE_ROLE_KEY`, and `INTERNAL_CRON_SECRET`); never add them to browser/Vite variables.

## Local development

Install dependencies with `npm install`, then run `npm run dev:local` to start Vite and the Netlify Functions emulator. Use non-production Supabase settings in the local environment. Do not put `SUPABASE_SERVICE_ROLE_KEY` or H2A provider credentials in browser variables.

## H2A verification

Run the deterministic, credential-free self-test with `npm run test:h2a:e2e`. It covers smoke orchestration plus admin-only sample review, safe projections, read-only recheck, and the fresh zero-row sample gate for full dry runs using local fixtures. The complete local H2A and schema contract suites are `npm run test:h2a` and `npm run test:h2a:schema`.

Sample Review requires [the review-workflow migration](supabase/h2a-dry-run-review-workflow.sql) before deployment and one new bounded sample afterward. Follow [the sample-review rollout in the pilot runbook](docs/hubspot-to-albi-pilot-runbook.md#sample-review-rollout-after-separate-deployment-approval): external correction, individual recheck, fresh zero-row verification sample, then full dry-run review before live activation. Migration, deployment, and authenticated browser smoke remain deferred pending separate approval.

The provider smoke script is read-only by default. When write mode is enabled, all isolation, marker-readback, run-ID, and URL-override guards are validated before any provider request, including HubSpot read-semantics POSTs. Its test environment variables, exact verification limits, Albi scopes, schema deployment procedure, safe manual key rotation, security race checklist, and pilot gates are documented in [the H2A pilot runbook](docs/hubspot-to-albi-pilot-runbook.md). Existing-record field or association changes are handled through Conflicts rather than blocking activation.

## Albi Projects deal import

Allied users can import deals from Albi's Projects API instead of the Google Sheet (Import page, **Albi API Import**). It uses the company's Albi key saved in H2A Settings, needs `Permissions.Projects.ViewAllProjects` and `Permissions.Projects.ManageFinancial`, and runs the same filters and import as the sheet. Each run reads only projects changed since the last run (the first looks back 30 days); each changed project costs two Albi reads. **Use Albi for the nightly 8pm import** switches the nightly run per user (requires [hs-albi-project-import.sql](supabase/hs-albi-project-import.sql)). Code: `netlify/functions/albi-project-import.js`, `netlify/functions/_albiProjectSource.js`.
