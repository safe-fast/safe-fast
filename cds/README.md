# SafeFast Rx: CDS Hooks service

HL7 CDS Hooks 1.0 service, deployable as a free Cloudflare Worker (`worker.js`).

- `GET /cds-services` returns the discovery document
- `POST /cds-services/safefast-ramadan` (hook `patient-view`): within 90 days before Ramadan, a card listing the suggested fasting schedule per active medicine, which ones need the doctor's dose decision, plus interaction cards
- `POST /cds-services/safefast-new-drug` (hook `order-select`): checks a newly selected drug against fasting and active meds

Test it in the public sandbox: https://sandbox.cds-hooks.org, then "CDS Services" > "Add CDS Services" > `https://<your-worker>.workers.dev/cds-services`.

Rules are illustrative demo rules, pending clinical pharmacist review.
