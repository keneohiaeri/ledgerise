import type { OutboundJournalBatch } from '@ledgerise/adapter-sdk';

export const zohoSandboxAccountMap = {
  '1000': '460000000000361',
  '4000': '460000000000362'
};

export const zohoSandboxBatch: OutboundJournalBatch = {
  id: 'b0000000-0000-4000-8000-000000000001',
  operator_id: '11111111-1111-4111-8111-111111111111',
  adapter_name: 'zoho-books',
  created_at: '2026-06-02T01:00:00.000Z',
  entries: [
    {
      id: 'e0000000-0000-4000-8000-000000000001',
      transaction_id: 't0000000-0000-4000-8000-000000000001',
      source_id: 'BILLPAY-20260602-0001',
      transaction_type: 'payment.electricity',
      product_line: 'consumer-app',
      product_biller: 'ikeja-electric',
      entry_type: 'standard',
      currency: 'NGN',
      amount: 500000,
      generated_at: '2026-06-02T01:00:00.000Z',
      mapping_rule_id: 'm0000000-0000-4000-8000-000000000001',
      mapping_rule_version: 1,
      lines: [
        {
          account_code: '1000',
          side: 'debit',
          amount: 500000,
          currency: 'NGN',
          line_order: 1
        },
        {
          account_code: '4000',
          side: 'credit',
          amount: 500000,
          currency: 'NGN',
          line_order: 2
        }
      ]
    }
  ]
};
