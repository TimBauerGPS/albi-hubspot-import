# Mother Brain Columns Needed

App name: HubSpot Importer (`albi-hubspot-import`)
Purpose: The nightly Albi-to-HubSpot deal import.

## Required Columns

Copy this list into the Mother Brain API key generator:

```text
Name,
Link to Project,
Customer,
Status,
Estimated Revenue,
Accrual Revenue,
Sales Person,
Created At,
Customer Email,
Address 1,
City,
State,
Zip Code,
Insurance Company,
Insurance Claim Number,
Property Type,
Referrer,
Project Manager,
Deductible
```

## Why These Columns Are Needed

- `Name`: Albi job number, the deal's `project_id` and upsert key; its suffix picks the pipeline and exclusions
- `Link to Project`: link back to the Albi project on the deal
- `Customer`: deal name
- `Status`: deal stage
- `Estimated Revenue`, `Accrual Revenue`: deal amounts
- `Sales Person`: deal owner and the sales-team filter
- `Created At`: Albi creation date
- `Customer Email`, `Address 1`, `City`, `State`, `Zip Code`: customer details on the deal
- `Insurance Company`, `Insurance Claim Number`, `Deductible`, `Property Type`, `Project Manager`: deal properties
- `Referrer`: matches the HubSpot contact or company; a job without one is skipped

Update this file and `MOTHER_BRAIN_COLUMNS` in `netlify/functions/_motherBrain.js` together.
