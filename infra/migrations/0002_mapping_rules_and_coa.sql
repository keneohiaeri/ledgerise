-- Chart of accounts, mapping rules, versions, and audit events.

CREATE TABLE chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, code)
);

CREATE INDEX chart_of_accounts_operator_type_idx
  ON chart_of_accounts (operator_id, type, active);

CREATE TABLE mapping_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  product_line text NOT NULL,
  biller text,
  biller_category text,
  transaction_type text,
  debit_account_code text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operator_id, debit_account_code)
    REFERENCES chart_of_accounts(operator_id, code)
);

CREATE INDEX mapping_rules_operator_lookup_idx
  ON mapping_rules (
    operator_id,
    status,
    product_line,
    biller,
    biller_category,
    transaction_type
  );

CREATE TABLE mapping_rule_credit_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_rule_id uuid NOT NULL REFERENCES mapping_rules(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES operators(id),
  account_code text NOT NULL,
  percentage_bps integer NOT NULL CHECK (percentage_bps > 0 AND percentage_bps <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operator_id, account_code)
    REFERENCES chart_of_accounts(operator_id, code)
);

CREATE INDEX mapping_rule_credit_splits_rule_idx
  ON mapping_rule_credit_splits (mapping_rule_id);

CREATE TABLE mapping_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_rule_id uuid NOT NULL REFERENCES mapping_rules(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES operators(id),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mapping_rule_id, version)
);

CREATE INDEX mapping_rule_versions_rule_idx
  ON mapping_rule_versions (mapping_rule_id, version DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators(id),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_operator_occurred_at_idx
  ON audit_events (operator_id, occurred_at DESC);

CREATE INDEX audit_events_entity_idx
  ON audit_events (operator_id, entity_type, entity_id);
