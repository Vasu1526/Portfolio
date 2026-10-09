-- MF Portfolio Manager: Supabase setup
-- IMPORTANT: The policies below are for quick personal testing only.
-- They allow anyone who knows the project URL and publishable key to read/write data.
-- Do not store private financial data with these policies in a production app.

-- Required unique key for syncing each fund/folio pair.
-- If this fails, check for duplicate (folio_no, scheme_code) rows first.
CREATE UNIQUE INDEX IF NOT EXISTS mutual_funds_folio_scheme_uidx
  ON public.mutual_funds (folio_no, scheme_code);

-- Keep transaction IDs unique (the existing import schema already defines this).
CREATE UNIQUE INDEX IF NOT EXISTS mf_transactions_transaction_id_uidx
  ON public.mf_transactions (transaction_id);

-- The app supports these transaction types. Existing rows remain unchanged.
ALTER TABLE public.mf_transactions
  DROP CONSTRAINT IF EXISTS mf_transactions_transaction_type_check;
ALTER TABLE public.mf_transactions
  ADD CONSTRAINT mf_transactions_transaction_type_check
  CHECK (transaction_type IN ('Lumpsum', 'SIP', 'SWP', 'Redemption', 'Switch-In', 'Switch-Out'));

CREATE TABLE IF NOT EXISTS public.mf_sip_schedules (
  schedule_id TEXT PRIMARY KEY,
  scheme_code INTEGER NOT NULL,
  scheme_name TEXT NOT NULL DEFAULT '',
  amc TEXT,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('SIP', 'SWP')),
  schedule_day INTEGER NOT NULL CHECK (schedule_day BETWEEN 1 AND 31),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  folio_no TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.mf_nav_data (
  scheme_code INTEGER PRIMARY KEY,
  latest_nav NUMERIC(14,4) NOT NULL DEFAULT 0,
  previous_nav NUMERIC(14,4) NOT NULL DEFAULT 0,
  nav_date DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS and add development-only open policies so the static HTML app can connect.
ALTER TABLE public.mutual_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mf_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mf_sip_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mf_nav_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Dev access mutual_funds" ON public.mutual_funds;
CREATE POLICY "Dev access mutual_funds" ON public.mutual_funds
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Dev access mf_transactions" ON public.mf_transactions;
CREATE POLICY "Dev access mf_transactions" ON public.mf_transactions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Dev access mf_sip_schedules" ON public.mf_sip_schedules;
CREATE POLICY "Dev access mf_sip_schedules" ON public.mf_sip_schedules
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Dev access mf_nav_data" ON public.mf_nav_data;
CREATE POLICY "Dev access mf_nav_data" ON public.mf_nav_data
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.mutual_funds TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_transactions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_sip_schedules TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mf_nav_data TO anon, authenticated;
