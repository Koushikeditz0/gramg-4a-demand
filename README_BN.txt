# G RAM-G 4A/Demand List Builder — PWA v1.2

## Files to upload to GitHub Pages (repository root)
- `index.html`
- `manifest.json`
- `service-worker.js`
- `icon-192.png`
- `icon-512.png`

Do not upload the ZIP itself as a substitute for these files.

## Apps Script backend update
1. Open the existing Apps Script project attached to the same Google Sheet.
2. Back up the current `Code.gs` first.
3. Replace `Code.gs` with `Code.gs` included in this package (it preserves the existing business functions and adds the PWA API bridge).
4. Save, then Deploy → Manage deployments → Edit the existing Web App deployment → select **New version** → Deploy. Keep access settings consistent with the existing app.
5. The frontend is configured to call the existing Web App URL. If the deployment URL changes, update `GRAMG_API_URL` in `index.html` to the new `/exec` URL and upload the changed file.

## Important
Test login, worker search, saved selection, account lookup, Excel and PDF after deploying. Do not remove or change the Google Sheets tab names/headers. This is a development version; keep your stable files backed up.
