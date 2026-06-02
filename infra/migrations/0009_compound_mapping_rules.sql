-- Compound mapping rules: multiple journal entries per transaction.
-- Idempotent: safe to re-run.
--
-- mapping_rules: replaces debit_account_code + mapping_rule_credit_splits
--   with entries jsonb. Existing simple rules are backfilled automatically.
--
-- journal_entries: removes the one-entry-per-transaction UNIQUE constraint
--   and adds entry_order + entry_label to support compound rule legs.

-- ── mapping_rules ──────────────────────────────────────────────────────────

ALTER TABLE mapping_rules
  ADD COLUMN IF NOT EXISTS rule_type text NOT NULL DEFAULT 'simple'
    CHECK (rule_type IN ('simple', 'compound'));

ALTER TABLE mapping_rules
  ADD COLUMN IF NOT EXISTS entries jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill entries only if debit_account_code column still exists
-- (means migration hasn't completed yet on this database).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'mapping_rules'
       AND column_name = 'debit_account_code'
  ) THEN
    UPDATE mapping_rules
       SET entries = jsonb_build_array(
             jsonb_build_object(
               'debitAccountCode', debit_account_code,
               'creditSplits', COALESCE(
                 (SELECT jsonb_agg(
                           jsonb_build_object(
                             'accountCode',   mrcs.account_code,
                             'percentageBps', mrcs.percentage_bps
                           )
                           ORDER BY mrcs.account_code
                         )
                    FROM mapping_rule_credit_splits mrcs
                   WHERE mrcs.mapping_rule_id = mapping_rules.id),
                 '[]'::jsonb
               )
             )
           )
     WHERE jsonb_array_length(entries) = 0;

    DROP TABLE IF EXISTS mapping_rule_credit_splits;

    ALTER TABLE mapping_rules DROP COLUMN IF EXISTS debit_account_code;
  END IF;
END $$;

-- ── journal_entries ────────────────────────────────────────────────────────

-- Drop the old (operator_id, transaction_id) unique constraint.
-- Look it up by column set rather than hardcoding the generated name.
DO $$
DECLARE v_name text;
BEGIN
  SELECT c.conname INTO v_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'journal_entries'
     AND c.contype  = 'u'
     AND array_length(c.conkey, 1) = 2
     AND EXISTS (
           SELECT 1 FROM unnest(c.conkey) k
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = k
            WHERE a.attname = 'operator_id')
     AND EXISTS (
           SELECT 1 FROM unnest(c.conkey) k
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = k
            WHERE a.attname = 'transaction_id');

  IF v_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE journal_entries DROP CONSTRAINT ' || quote_ident(v_name);
  END IF;
END $$;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS entry_order integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS entry_label text;

-- Add the new three-column unique constraint if not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname    = 'journal_entries_operator_transaction_order_key'
       AND conrelid   = 'journal_entries'::regclass
  ) THEN
    ALTER TABLE journal_entries
      ADD CONSTRAINT journal_entries_operator_transaction_order_key
        UNIQUE (operator_id, transaction_id, entry_order);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS journal_entries_transaction_group_idx
  ON journal_entries (operator_id, transaction_id, entry_order);
