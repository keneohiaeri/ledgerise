CREATE TABLE system_settings (
  operator_id uuid PRIMARY KEY REFERENCES operators(id),
  engine_cron_schedule text NOT NULL DEFAULT '0 * * * *',
  batch_size integer NOT NULL DEFAULT 500,
  suspense_account_code text NOT NULL DEFAULT '9999',
  max_retry_attempts integer NOT NULL DEFAULT 5,
  backoff_strategy text NOT NULL DEFAULT 'exponential' CHECK (backoff_strategy IN ('exponential', 'fixed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
