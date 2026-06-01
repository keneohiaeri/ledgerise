-- Minimal local chart of accounts for mapping-rule verification.

INSERT INTO chart_of_accounts (operator_id, code, name, type)
SELECT operators.id, account.code, account.name, account.type
FROM operators
CROSS JOIN (
  VALUES
    ('1000', 'Cash / Settlement Asset', 'asset'),
    ('1100', 'Aggregator Float', 'asset'),
    ('2000', 'Customer Liability', 'liability'),
    ('4000', 'Bill Payment Revenue', 'revenue'),
    ('5000', 'Processing Fees', 'expense')
) AS account(code, name, type)
WHERE operators.slug = 'local-operator'
ON CONFLICT (operator_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  updated_at = now();
