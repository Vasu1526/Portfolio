MUTUAL FUND PORTFOLIO MANAGER — SUPABASE SETUP

Files:
1. app_supabase.js — replacement for your current app.js
2. index_supabase.html — HTML page that loads Supabase JS before app.js
3. Supabase_App_Setup.sql — run once in Supabase SQL Editor

STEPS
1. Make a backup copy of your existing app.js and index.html.
2. Open your Supabase project and go to SQL Editor.
3. Paste/run Supabase_App_Setup.sql. If the unique index for mutual_funds fails, there are duplicate folio_no + scheme_code pairs that 
    must be resolved first.
4. In your project folder, replace app.js with app_supabase.js (rename app_supabase.js to app.js).
5. Replace index.html with index_supabase.html (rename index_supabase.html to index.html). Keep style.css in the same folder.
6. Open the page using a local web server if possible, then open browser Developer Tools > Console and check for errors.
7. Refresh the app and check that funds/transactions appear. Add a test schedule or transaction, refresh, and confirm it remains.

IMPORTANT SECURITY NOTE
The SQL file uses open development policies to make a static HTML/JS prototype work without login. Anyone who obtains the project URL 
and publishable key can potentially read or change all data. The publishable key is not a secret, but these policies make the database public. 
Do not use this setup for private financial data until Supabase Auth and per-user Row Level Security policies are implemented.

NAV NOTE
The app fetches NAV history from mfapi.in in the browser. Daily NAV refresh happens when the page is opened/refreshed or the R
efresh NAV button is clicked; it is not a background job while the page is closed.
