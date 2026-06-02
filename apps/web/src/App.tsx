import { FormEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';

type Screen = 'transactions' | 'mapping-rules' | 'journal-log' | 'settings';
type SettingsTab = 'coa' | 'schema' | 'adapters' | 'users' | 'system';
type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type PostingDisplayStatus = JournalEntry['posting_status'] | 'unposted' | 'blocked';
type TransactionStatusFilter = TransactionRecord['status'] | 'all';

interface ChartAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentCode?: string;
  active: boolean;
}

interface CreditSplit {
  accountCode: string;
  percentageBps: number;
}

interface MappingRule {
  id: string;
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  debitAccountCode: string;
  status: 'active' | 'inactive';
  version: number;
  creditSplits: CreditSplit[];
}

interface TransactionRecord {
  id: string;
  source_id?: string;
  source: {
    adapter: string;
    system: string;
    environment?: 'live' | 'test';
  };
  occurred_at: string;
  settled_at: string | null;
  status: 'pending' | 'settled' | 'failed' | 'reversed' | 'disputed';
  posting_status: 'unposted';
  type: string;
  direction: 'debit' | 'credit';
  amount: number;
  currency: string;
  product: {
    line: string;
    biller?: string;
    biller_category?: string;
  };
  channel: string;
  dedupe_confidence: 'high' | 'low';
  ingested_at: string;
}

interface JournalLine {
  account_code: string;
  side: 'debit' | 'credit';
  amount: number;
  currency: string;
  line_order: number;
}

interface JournalEntry {
  id: string;
  transaction_id: string;
  entry_type: 'standard' | 'reversal' | 'unmapped';
  status: 'generated' | 'unmapped';
  posting_status: 'generated' | 'posting' | 'posted' | 'failed' | 'unmapped' | 'retry_exhausted';
  currency: string;
  amount: number;
  mapping_rule_id?: string;
  mapping_rule_version?: number;
  generated_at: string;
  posted_at?: string;
  last_posting_attempt_at?: string;
  last_posting_error?: string;
  attempt_count: number;
  lines: JournalLine[];
  latest_attempt?: {
    adapter_name: string;
    status: string;
    attempt_number: number;
    occurred_at: string;
    error_message?: string;
  };
  attempts: Array<{
    id: string;
    adapter_name: string;
    status: string;
    attempt_number: number;
    occurred_at: string;
    error_message?: string;
    external_reference?: string;
  }>;
  transaction?: {
    id: string;
    source_id?: string;
    status: string;
    type: string;
    occurred_at: string;
    settled_at?: string | null;
    source_adapter: string;
    source_system: string;
    product_line: string;
    product_biller?: string;
    product_biller_category?: string;
  };
}

interface AdapterRecord {
  name: string;
  version: string;
  direction: 'inbound' | 'outbound';
  source_system?: string;
  target_system?: string;
  modes: string[];
  currency_codes: string[];
  runtime: {
    type: 'internal' | 'http';
  };
  enabled?: boolean;
  config?: unknown;
}

interface AdapterMappingRow {
  sourcePath: string;
  canonicalField: string;
  transform: string;
  defaultValue: string;
  required: boolean;
}

type AdapterConfigField =
  | { type: 'display'; label: string; value: string; hint: string }
  | { type: 'text' | 'password' | 'number'; label: string; value?: string; hint: string; key?: string }
  | { type: 'select'; label: string; value: string; options: string[]; hint: string; key?: string }
  | { type: 'action'; label?: string; text: string; status: string; statusClass: 'ok' | 'err' }
  | {
      type: 'mapping';
      id: string;
      sourceLabel?: string;
      rows: AdapterMappingRow[];
      preview: {
        source: string;
        output: string;
      };
    };

interface AdapterConfigSection {
  title: string;
  desc?: string;
  fields: AdapterConfigField[];
}

interface AdapterConfigTemplate {
  subtitle: string;
  summary: string;
  sections: AdapterConfigSection[];
}

interface PageInfo {
  limit: number;
  offset: number;
  total: number;
}

interface RuleFormState {
  id?: string;
  productLine: string;
  biller: string;
  billerCategory: string;
  transactionType: string;
  debitAccountCode: string;
  creditSplits: CreditSplit[];
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const transactionPageSize = 100;
const canonicalFieldOptions = [
  'source_id',
  'occurred_at',
  'settled_at',
  'status',
  'amount',
  'currency',
  'type',
  'direction',
  'product.line',
  'product.biller',
  'product.biller_category',
  'principal.id',
  'principal.reference',
  'principal.type',
  'channel',
  'metadata'
];
const transformOptions = ['copy', 'parse_datetime', 'amount_to_minor', 'enum_map', 'lowercase', 'uppercase', 'mask_phone'];

const adapterConfigTemplates: Record<string, AdapterConfigTemplate> = {
  'generic-webhook': {
    subtitle: 'Inbound · Webhook',
    summary: 'Receives mapped JSON payloads from any source system.',
    sections: [
      {
        title: 'Webhook Endpoint',
        fields: [
          {
            label: 'Inbound URL',
            type: 'display',
            value: `${apiBaseUrl}/api/ingest/generic-webhook`,
            hint: 'Send canonical JSON transaction payloads from source systems to this endpoint.'
          },
          {
            label: 'Signing Secret',
            type: 'password',
            hint: 'Optional shared secret for verifying inbound requests before normalization.'
          }
        ]
      },
      {
        title: 'Payload Contract',
        fields: [
          { label: 'Records Path', type: 'text', value: 'records', hint: 'JSON path containing one or more canonical transaction records.' },
          {
            label: 'Accept Partial Batches',
            type: 'select',
            options: ['Yes, store valid records', 'No, reject entire batch'],
            value: 'Yes, store valid records',
            hint: 'Controls how the adapter handles mixed valid and invalid payloads.'
          }
        ]
      },
      {
        title: 'Field Mapping',
        desc: 'Map source JSON paths to Ledgerise canonical fields before records reach the journal engine.',
        fields: [
          {
            type: 'mapping',
            id: 'generic-webhook-map',
            rows: [
              { sourcePath: 'txn_ref', canonicalField: 'source_id', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'paid_at', canonicalField: 'occurred_at', transform: 'parse_datetime', defaultValue: '', required: true },
              { sourcePath: 'state', canonicalField: 'status', transform: 'enum_map', defaultValue: 'SUCCESS=settled, FAILED=failed', required: true },
              { sourcePath: 'value', canonicalField: 'amount', transform: 'amount_to_minor', defaultValue: '', required: true },
              { sourcePath: 'service', canonicalField: 'type', transform: 'enum_map', defaultValue: 'electricity=payment.electricity', required: true },
              { sourcePath: 'customer_id', canonicalField: 'principal.id', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'customer_phone', canonicalField: 'principal.reference', transform: 'mask_phone', defaultValue: '', required: false }
            ],
            preview: {
              source: '{\n  "txn_ref": "ABC123",\n  "paid_at": "2026-05-31T14:01:54Z",\n  "state": "SUCCESS",\n  "value": 5000,\n  "service": "electricity"\n}',
              output: '{\n  "source_id": "ABC123",\n  "status": "settled",\n  "amount": 500000,\n  "currency": "NGN"\n}'
            }
          }
        ]
      }
    ]
  },
  'generic-poll': {
    subtitle: 'Inbound · Poll',
    summary: 'Fetches transactions from simple JSON APIs on a schedule.',
    sections: [
      {
        title: 'Source API',
        fields: [
          { label: 'Endpoint URL', type: 'text', value: 'https://api.example.com/transactions', hint: 'Ledgerise fetches this URL on the configured schedule.' },
          { label: 'Auth Header', type: 'text', value: 'Authorization', hint: 'Header used for API authentication.' },
          { label: 'API Token', type: 'password', hint: 'Stored securely and redacted from logs.' },
          { label: 'Records Path', type: 'text', value: 'data.transactions', hint: 'JSON path containing source records.' }
        ]
      },
      {
        title: 'Poll Schedule',
        fields: [
          {
            label: 'Poll Interval',
            type: 'select',
            options: ['Every 5 minutes', 'Every 15 minutes', 'Every 30 minutes', 'Every hour'],
            value: 'Every 15 minutes',
            hint: 'How often Ledgerise fetches new records.'
          },
          { label: 'Cursor Field', type: 'text', value: 'updated_at', hint: 'Field used to advance the next poll cursor after successful ingestion.' }
        ]
      },
      {
        title: 'Field Mapping',
        desc: 'Map each API result object to canonical fields. The cursor only advances after these records validate.',
        fields: [
          {
            type: 'mapping',
            id: 'generic-poll-map',
            rows: [
              { sourcePath: 'id', canonicalField: 'source_id', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'created_at', canonicalField: 'occurred_at', transform: 'parse_datetime', defaultValue: '', required: true },
              { sourcePath: 'settled_at', canonicalField: 'settled_at', transform: 'parse_datetime', defaultValue: '', required: false },
              { sourcePath: 'amount', canonicalField: 'amount', transform: 'amount_to_minor', defaultValue: '', required: true },
              { sourcePath: 'status', canonicalField: 'status', transform: 'enum_map', defaultValue: 'completed=settled, failed=failed', required: true },
              { sourcePath: 'product', canonicalField: 'product.line', transform: 'copy', defaultValue: 'consumer-app', required: true }
            ],
            preview: {
              source: '{\n  "id": "api_8841",\n  "created_at": "2026-05-31T11:02:44Z",\n  "status": "completed",\n  "amount": 1200,\n  "product": "consumer-app"\n}',
              output: '{\n  "source_id": "api_8841",\n  "status": "settled",\n  "amount": 120000,\n  "product": { "line": "consumer-app" }\n}'
            }
          }
        ]
      }
    ]
  },
  'generic-csv': {
    subtitle: 'Inbound · File import',
    summary: 'Imports CSV transaction exports with configurable column mapping.',
    sections: [
      {
        title: 'Column Mapping',
        desc: 'Map CSV headers to canonical fields. These mappings are configuration, not adapter code.',
        fields: [
          {
            type: 'mapping',
            id: 'generic-csv-map',
            sourceLabel: 'CSV column',
            rows: [
              { sourcePath: 'reference', canonicalField: 'source_id', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'transaction_date', canonicalField: 'occurred_at', transform: 'parse_datetime', defaultValue: '', required: true },
              { sourcePath: 'amount', canonicalField: 'amount', transform: 'amount_to_minor', defaultValue: '', required: true },
              { sourcePath: 'status', canonicalField: 'status', transform: 'enum_map', defaultValue: 'success=settled, failed=failed', required: true },
              { sourcePath: 'transaction_type', canonicalField: 'type', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'product_line', canonicalField: 'product.line', transform: 'copy', defaultValue: '', required: true },
              { sourcePath: 'biller', canonicalField: 'product.biller', transform: 'copy', defaultValue: '', required: false }
            ],
            preview: {
              source: 'reference,transaction_date,amount,status,transaction_type,product_line,biller\nCSV-4482,2026-05-31,5000,success,payment.electricity,consumer-app,ikeja-electric',
              output: '{\n  "source_id": "CSV-4482",\n  "occurred_at": "2026-05-31T00:00:00Z",\n  "amount": 500000,\n  "status": "settled"\n}'
            }
          }
        ]
      },
      {
        title: 'Format',
        fields: [
          { label: 'Delimiter', type: 'select', options: ['Comma (,)', 'Semicolon (;)', 'Tab', 'Pipe (|)'], value: 'Comma (,)', hint: 'The manual import button currently expects comma-separated files.' },
          { label: 'Date Format', type: 'select', options: ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'ISO 8601'], value: 'YYYY-MM-DD', hint: 'Used by the CSV normalizer when parsing transaction dates.' },
          { label: 'Amount Unit', type: 'select', options: ['Smallest unit (kobo, cents)', 'Major unit (naira, dollars)'], value: 'Smallest unit (kobo, cents)', hint: 'Ledgerise stores amounts in the smallest currency unit internally.' }
        ]
      }
    ]
  },
  'zoho-books': {
    subtitle: 'Outbound · Journal posting',
    summary: 'Posts journal entries to Zoho Books via the Manual Journals API.',
    sections: [
      {
        title: 'OAuth 2.0 Authentication',
        fields: [
          { label: 'Client ID', type: 'text', value: 'ZOHO_CLIENT_ID', hint: 'Configured from environment until secret storage is added.' },
          { label: 'Client Secret', type: 'password', hint: 'Keep this secret out of logs and browser storage.' },
          { label: 'Organization ID', type: 'text', value: 'ZOHO_ORGANIZATION_ID', hint: 'Zoho Books organization identifier.' },
          { type: 'action', text: 'Test connection', status: 'Configured from server environment', statusClass: 'ok' }
        ]
      },
      {
        title: 'Posting Behaviour',
        fields: [
          { label: 'Batch Size', type: 'number', value: '100', hint: 'Maximum number of journal entries sent per posting batch.' },
          {
            label: 'On Rate Limit',
            type: 'select',
            options: ['Retry with exponential backoff', 'Pause batch and alert'],
            value: 'Retry with exponential backoff',
            hint: 'Controls retry behavior when Zoho returns a rate-limit response.'
          },
          {
            label: 'Journal Status',
            type: 'select',
            options: ['draft', 'published'],
            value: 'draft',
            hint: 'Draft is safest for sandbox and first production rollout.'
          }
        ]
      },
      {
        title: 'Account Mapping',
        fields: [
          { label: 'Account Map Source', type: 'display', value: 'ZOHO_ACCOUNT_MAP_JSON', hint: 'Maps Ledgerise account codes to Zoho account IDs before posting.' }
        ]
      }
    ]
  },
  'generic-journal-csv': {
    subtitle: 'Outbound · File exchange',
    summary: 'Creates durable journal CSV artifacts for external accounting systems.',
    sections: [
      {
        title: 'Batch API',
        fields: [
          { label: 'Create Batch', type: 'display', value: `${apiBaseUrl}/api/posting-batches/generic-journal-csv`, hint: 'POST generated entries into a durable CSV artifact batch.' },
          { label: 'List Batches', type: 'display', value: `${apiBaseUrl}/api/posting-batches`, hint: 'External systems can poll batch metadata before downloading artifacts.' },
          { label: 'Download Pattern', type: 'display', value: `${apiBaseUrl}/api/posting-batches/{batch_id}/artifact.csv`, hint: 'Download the exact CSV artifact for a posted batch.' }
        ]
      },
      {
        title: 'Export Format',
        fields: [
          { label: 'File Name Pattern', type: 'text', value: 'ledgerise-journals-{batch_id}.csv', hint: 'Used when returning the durable CSV artifact.' },
          { label: 'Amount Unit', type: 'select', options: ['Major unit (naira, dollars)', 'Smallest unit (kobo, cents)'], value: 'Major unit (naira, dollars)', hint: 'Controls exported CSV display only.' },
          { label: 'Include Source Transaction ID', type: 'select', options: ['Yes', 'No'], value: 'Yes', hint: 'Keeps audit traceability for downstream imports.' }
        ]
      },
      {
        title: 'Batch Rules',
        fields: [
          { label: 'Idempotency Header', type: 'display', value: 'Idempotency-Key', hint: 'Repeat calls with the same key return the same posting batch instead of duplicating journal exports.' },
          { label: 'API Key Scope', type: 'display', value: 'posting_batches:create/read + posting_artifacts:download', hint: 'Required scopes for an external file exchange integration.' }
        ]
      }
    ]
  }
};

const emptyRuleForm: RuleFormState = {
  productLine: 'consumer-app',
  biller: '',
  billerCategory: '',
  transactionType: '',
  debitAccountCode: '',
  creditSplits: [{ accountCode: '', percentageBps: 10000 }]
};

export function App() {
  const [screen, setScreen] = useState<Screen>('transactions');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('coa');
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [transactionPage, setTransactionPage] = useState<PageInfo>({
    limit: transactionPageSize,
    offset: 0,
    total: 0
  });
  const [transactionOffset, setTransactionOffset] = useState(0);
  const [transactionFilter, setTransactionFilter] = useState<'all' | 'unmapped'>('all');
  const [transactionStatusFilter, setTransactionStatusFilter] = useState<TransactionStatusFilter>('all');
  const [transactionPostingFilter, setTransactionPostingFilter] = useState<PostingDisplayStatus | 'all'>('all');
  const [transactionDateFrom, setTransactionDateFrom] = useState('');
  const [transactionDateTo, setTransactionDateTo] = useState('');
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionRecord | null>(null);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);
  const [journalFilter, setJournalFilter] = useState<JournalEntry['posting_status'] | 'all'>('all');
  const [selectedJournal, setSelectedJournal] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [ruleForm, setRuleForm] = useState<RuleFormState>(emptyRuleForm);
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const [coaForm, setCoaForm] = useState({
    code: '',
    name: '',
    type: 'asset' as AccountType
  });
  const transactionImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refreshOperationalData();
  }, [journalFilter, transactionOffset]);

  const activeRules = rules.filter((rule) => rule.status === 'active');
  const inactiveRules = rules.filter((rule) => rule.status === 'inactive');
  const productLineCount = new Set(rules.map((rule) => rule.productLine)).size;

  const creditSplitTotal = useMemo(
    () => ruleForm.creditSplits.reduce((sum, split) => sum + Number(split.percentageBps || 0), 0),
    [ruleForm.creditSplits]
  );

  async function refreshOperationalData() {
    setLoading(true);
    setError('');

    try {
      const journalPath =
        journalFilter === 'all'
          ? '/api/journal-entries'
          : `/api/journal-entries?posting_status=${journalFilter}`;
      const transactionPath = `/api/transactions?limit=${transactionPageSize}&offset=${transactionOffset}`;
      const [coaResponse, adapterResponse, rulesResponse, transactionResponse, journalResponse] = await Promise.all([
        apiGet<{ records: ChartAccount[] }>('/api/coa'),
        apiGet<{ records: AdapterRecord[] }>('/api/adapters'),
        apiGet<{ records: MappingRule[] }>('/api/mapping-rules'),
        apiGet<{ records: TransactionRecord[]; page: PageInfo }>(transactionPath),
        apiGet<{ records: JournalEntry[] }>(journalPath)
      ]);
      setAccounts(coaResponse.records);
      setAdapters(adapterResponse.records);
      setRules(rulesResponse.records);
      setTransactions(transactionResponse.records);
      setTransactionPage(transactionResponse.page);
      setJournalEntries(journalResponse.records);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load Ledgerise data');
    } finally {
      setLoading(false);
    }
  }

  async function saveCoaAccount(event: FormEvent) {
    event.preventDefault();
    setError('');

    try {
      await apiPost('/api/coa/import', {
        accounts: [coaForm]
      });
      setNotice(`Imported COA account ${coaForm.code}`);
      setCoaForm({ code: '', name: '', type: 'asset' });
      await refreshOperationalData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to import account');
    }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (creditSplitTotal !== 10000) {
      setError('Credit splits must sum to 100%.');
      return;
    }

    const payload = {
      product_line: ruleForm.productLine,
      biller: ruleForm.biller || undefined,
      biller_category: ruleForm.billerCategory || undefined,
      transaction_type: ruleForm.transactionType || undefined,
      debit_account_code: ruleForm.debitAccountCode,
      credit_splits: ruleForm.creditSplits.map((split) => ({
        account_code: split.accountCode,
        percentage_bps: Number(split.percentageBps)
      }))
    };

    try {
      if (ruleForm.id) {
        await apiPatch(`/api/mapping-rules/${ruleForm.id}`, payload);
        setNotice('Mapping rule updated');
      } else {
        await apiPost('/api/mapping-rules', payload);
        setNotice('Mapping rule created');
      }
      setRuleForm(emptyRuleForm);
      setRuleDrawerOpen(false);
      await refreshOperationalData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save mapping rule');
    }
  }

  async function toggleRule(rule: MappingRule) {
    const action = rule.status === 'active' ? 'deactivate' : 'activate';
    setError('');

    try {
      await apiPost(`/api/mapping-rules/${rule.id}/${action}`, {});
      setNotice(`Rule ${action}d`);
      await refreshOperationalData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to change rule status');
    }
  }

  async function importGenericCsv(file: File) {
    setError('');
    setNotice('');

    try {
      const content = await file.text();
      const result = await apiPost<{
        imported: number;
        duplicates: number;
        rejected: number;
        row_errors?: unknown[];
      }>('/api/import/generic-csv', {
        filename: file.name,
        content
      });
      setNotice(
        `Imported ${result.imported} transactions` +
          (result.duplicates ? `, ${result.duplicates} duplicates` : '') +
          (result.row_errors?.length ? `, ${result.row_errors.length} row errors` : '')
      );
      setTransactionOffset(0);
      await refreshOperationalData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to import CSV data');
    }
  }

  function editRule(rule: MappingRule) {
    setRuleForm({
      id: rule.id,
      productLine: rule.productLine,
      biller: rule.biller ?? '',
      billerCategory: rule.billerCategory ?? '',
      transactionType: rule.transactionType ?? '',
      debitAccountCode: rule.debitAccountCode,
      creditSplits:
        rule.creditSplits.length > 0
          ? rule.creditSplits
          : [{ accountCode: '', percentageBps: 10000 }]
    });
    setRuleDrawerOpen(true);
  }

  function openNewRule() {
    setRuleForm(emptyRuleForm);
    setError('');
    setRuleDrawerOpen(true);
  }

  function closeRuleDrawer() {
    setRuleDrawerOpen(false);
  }

  function updateSplit(index: number, patch: Partial<CreditSplit>) {
    setRuleForm((current) => ({
      ...current,
      creditSplits: current.creditSplits.map((split, splitIndex) =>
        splitIndex === index ? { ...split, ...patch } : split
      )
    }));
  }

  function removeSplit(index: number) {
    setRuleForm((current) => ({
      ...current,
      creditSplits: current.creditSplits.filter((_, splitIndex) => splitIndex !== index)
    }));
  }

  async function retryJournalEntry(entry: JournalEntry) {
    setError('');
    try {
      await apiPost(`/api/journal-entries/${entry.id}/retry`, {
        adapter_name: 'generic-journal-csv'
      });
      setNotice('Retry requested');
      await refreshOperationalData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to request retry');
    }
  }

  function closeJournalDrawer() {
    setSelectedJournal(null);
  }

  function closeTransactionDrawer() {
    setSelectedTransaction(null);
  }

  async function saveAdapterConfiguration(adapter: AdapterRecord, config: unknown) {
    const result = await apiPatch<{ record: AdapterRecord }>(
      `/api/adapters/${encodeURIComponent(adapter.name)}/config`,
      {
        enabled: adapter.enabled ?? true,
        config
      }
    );
    setAdapters((current) =>
      current.map((item) => (item.name === result.record.name ? { ...item, ...result.record } : item))
    );
    setNotice(`Saved ${adapter.name} adapter configuration`);
  }

  async function toggleAdapterConfiguration(adapter: AdapterRecord, enabled: boolean) {
    const result = await apiPatch<{ record: AdapterRecord }>(
      `/api/adapters/${encodeURIComponent(adapter.name)}/config`,
      {
        enabled,
        config: adapter.config ?? defaultAdapterOperationalConfig(adapter.name)
      }
    );
    setAdapters((current) =>
      current.map((item) => (item.name === result.record.name ? { ...item, ...result.record } : item))
    );
    setNotice(`${adapter.name} ${enabled ? 'enabled' : 'disabled'}`);
  }

  function mapTransaction(transaction: TransactionRecord) {
    setRuleForm({
      ...emptyRuleForm,
      productLine: transaction.product.line,
      biller: transaction.product.biller ?? '',
      billerCategory: transaction.product.biller_category ?? '',
      transactionType: transaction.type
    });
    setSelectedTransaction(null);
    setScreen('mapping-rules');
    setRuleDrawerOpen(true);
  }

  function openTransactionJournal(entry: JournalEntry) {
    setSelectedTransaction(null);
    setSelectedJournal(entry);
    setScreen('journal-log');
  }

  return (
    <div className="layout">
      <nav className="topnav">
        <div className="topnav-logo">
          <div className="logo-mark">
            <img src="/ledgerise-logo.svg" alt="" aria-hidden="true" />
          </div>
          <span className="logo-wordmark">Ledgerise</span>
          <span className="logo-version">v0.1</span>
        </div>

        <div className="topnav-nav">
          <NavButton active={screen === 'transactions'} onClick={() => setScreen('transactions')}>
            Transactions
          </NavButton>
          <NavButton active={screen === 'mapping-rules'} onClick={() => setScreen('mapping-rules')}>
            Mapping Rules
          </NavButton>
          <NavButton active={screen === 'journal-log'} onClick={() => setScreen('journal-log')}>
            Journal Log
          </NavButton>
          <NavButton active={screen === 'settings'} onClick={() => setScreen('settings')}>
            Settings
          </NavButton>
        </div>
      </nav>

      <main className="main">
        {notice ? <Toast message={notice} onClose={() => setNotice('')} /> : null}
        {screen === 'transactions' ? (
          <TransactionsView
            error={error}
            importInputRef={transactionImportInputRef}
            journalEntries={journalEntries}
            loading={loading}
            mapTransaction={mapTransaction}
            importGenericCsv={importGenericCsv}
            selectedTransaction={selectedTransaction}
            selectTransaction={setSelectedTransaction}
            closeTransactionDrawer={closeTransactionDrawer}
            transactionFilter={transactionFilter}
            setTransactionFilter={setTransactionFilter}
            statusFilter={transactionStatusFilter}
            setStatusFilter={setTransactionStatusFilter}
            postingFilter={transactionPostingFilter}
            setPostingFilter={setTransactionPostingFilter}
            dateFrom={transactionDateFrom}
            setDateFrom={setTransactionDateFrom}
            dateTo={transactionDateTo}
            setDateTo={setTransactionDateTo}
            openTransactionJournal={openTransactionJournal}
            page={transactionPage}
            setTransactionOffset={setTransactionOffset}
            transactions={transactions}
          />
        ) : null}
        {screen === 'journal-log' ? (
          <JournalLogView
            accounts={accounts}
            entries={journalEntries}
            error={error}
            filter={journalFilter}
            loading={loading}
            retryJournalEntry={retryJournalEntry}
            selectedJournal={selectedJournal}
            selectJournal={setSelectedJournal}
            closeJournalDrawer={closeJournalDrawer}
            setFilter={setJournalFilter}
          />
        ) : null}
        {screen === 'mapping-rules' ? (
          <MappingRulesView
            accounts={accounts}
            activeRules={activeRules.length}
            inactiveRules={inactiveRules.length}
            loading={loading}
            productLineCount={productLineCount}
            rules={rules}
            error={error}
            ruleForm={ruleForm}
            ruleDrawerOpen={ruleDrawerOpen}
            creditSplitTotal={creditSplitTotal}
            setRuleForm={setRuleForm}
            saveRule={saveRule}
            openNewRule={openNewRule}
            closeRuleDrawer={closeRuleDrawer}
            editRule={editRule}
            toggleRule={toggleRule}
            updateSplit={updateSplit}
            removeSplit={removeSplit}
          />
        ) : null}
        {screen === 'settings' ? (
          <SettingsView
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            accounts={accounts}
            adapters={adapters}
            coaForm={coaForm}
            setCoaForm={setCoaForm}
            saveCoaAccount={saveCoaAccount}
            saveAdapterConfiguration={saveAdapterConfiguration}
            toggleAdapterConfiguration={toggleAdapterConfiguration}
            error={error}
            setNotice={setNotice}
          />
        ) : null}
      </main>
    </div>
  );
}

function NavButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button className={`nav-tab${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}

function TransactionsView(props: {
  error: string;
  importGenericCsv: (file: File) => Promise<void>;
  importInputRef: RefObject<HTMLInputElement>;
  journalEntries: JournalEntry[];
  loading: boolean;
  mapTransaction: (transaction: TransactionRecord) => void;
  selectedTransaction: TransactionRecord | null;
  selectTransaction: (transaction: TransactionRecord) => void;
  closeTransactionDrawer: () => void;
  transactionFilter: 'all' | 'unmapped';
  setTransactionFilter: (filter: 'all' | 'unmapped') => void;
  statusFilter: TransactionStatusFilter;
  setStatusFilter: (filter: TransactionStatusFilter) => void;
  postingFilter: PostingDisplayStatus | 'all';
  setPostingFilter: (filter: PostingDisplayStatus | 'all') => void;
  dateFrom: string;
  setDateFrom: (value: string) => void;
  dateTo: string;
  setDateTo: (value: string) => void;
  openTransactionJournal: (entry: JournalEntry) => void;
  page: PageInfo;
  setTransactionOffset: (offset: number) => void;
  transactions: TransactionRecord[];
}) {
  const {
    error,
    importGenericCsv,
    importInputRef,
    journalEntries,
    loading,
    mapTransaction,
    selectedTransaction,
    selectTransaction,
    closeTransactionDrawer,
    transactionFilter,
    setTransactionFilter,
    statusFilter,
    setStatusFilter,
    postingFilter,
    setPostingFilter,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    openTransactionJournal,
    page,
    setTransactionOffset,
    transactions
  } = props;
  const settled = transactions.filter((transaction) => transaction.status === 'settled').length;
  const pending = transactions.filter((transaction) => transaction.status === 'pending').length;
  const unmapped = transactions.filter(
    (transaction) => transactionJournalStatus(transaction, journalEntries) === 'unmapped'
  ).length;
  const test = transactions.filter((transaction) => transaction.source.environment === 'test').length;
  const visibleTransactions = transactions.filter((transaction) => {
    const journalStatus = transactionJournalStatus(transaction, journalEntries);
    if (transactionFilter === 'unmapped' && journalStatus !== 'unmapped') return false;
    if (statusFilter !== 'all' && transaction.status !== statusFilter) return false;
    if (postingFilter !== 'all' && journalStatus !== postingFilter) return false;
    return transactionWithinDateRange(transaction, dateFrom, dateTo);
  });
  const pageStart = page.total === 0 ? 0 : page.offset + 1;
  const pageEnd = Math.min(page.offset + page.limit, page.total);
  const canPageBack = page.offset > 0;
  const canPageForward = page.offset + page.limit < page.total;

  return (
    <section className="screen active">
      <div className="page-header">
        <div>
          <h1>Transactions</h1>
          <p>Canonical records ingested by inbound adapters before mapping and journal generation</p>
        </div>
        <div className="page-actions">
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importGenericCsv(file);
            }}
          />
          <button className="btn btn-primary" onClick={() => importInputRef.current?.click()}>
            Import Data
          </button>
        </div>
      </div>

      <div className="stat-bar cols-4">
        <StatCell label="Total" value={String(page.total)} sub="canonical records stored" />
        <StatCell label="Settled" value={String(settled)} sub="eligible for journal generation" tone="ok" />
        <StatCell label="Unmapped" value={String(unmapped)} sub="journaled to suspense" tone={unmapped ? 'warn' : undefined} />
        <StatCell label="Pending/Test" value={String(pending + test)} sub="blocked from posting" />
      </div>

      <div className="table-workspace">
        <div className="filter-bar">
          <input className="fi" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} style={{ width: 140 }} />
          <span style={{ color: 'var(--color-text-3)', fontSize: 'var(--text-sm)' }}>to</span>
          <input className="fi" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} style={{ width: 140 }} />
          <div className="bar-sep" />
          <select
            className="fi"
            style={{ width: 145 }}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as TransactionStatusFilter)}
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="settled">Settled</option>
            <option value="failed">Failed</option>
            <option value="reversed">Reversed</option>
            <option value="disputed">Disputed</option>
          </select>
          <select
            className="fi"
            style={{ width: 165 }}
            value={postingFilter}
            onChange={(event) => setPostingFilter(event.target.value as PostingDisplayStatus | 'all')}
          >
            <option value="all">All Posting Status</option>
            <option value="unposted">Unposted</option>
            <option value="generated">Generated</option>
            <option value="posting">Posting</option>
            <option value="posted">Posted</option>
            <option value="failed">Failed</option>
            <option value="unmapped">Unmapped</option>
            <option value="retry_exhausted">Retry exhausted</option>
            <option value="blocked">Blocked/Test</option>
          </select>
          <select className="fi" style={{ width: 170 }}>
            <option>All Adapters</option>
          </select>
          <input className="fi" placeholder="Search transaction ID..." style={{ width: 240 }} />
          <button
            className={`btn btn-ghost btn-sm${transactionFilter === 'unmapped' ? ' active-filter' : ''}`}
            onClick={() => setTransactionFilter(transactionFilter === 'unmapped' ? 'all' : 'unmapped')}
          >
            Unmapped only
          </button>
          <div className="spacer" />
          <span className="stat-sub">{loading ? 'Loading transactions...' : `${visibleTransactions.length} transactions`}</span>
        </div>
        {error ? <div className="form-error journal-error">{error}</div> : null}

        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Transaction ID</th>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Dir</th>
                <th>Status</th>
                <th>Posting</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleTransactions.map((transaction) => {
                const journalStatus = transactionJournalStatus(transaction, journalEntries);
                return (
                  <tr key={transaction.id} onClick={() => selectTransaction(transaction)}>
                    <td className="mono">{transaction.source_id ?? shortId(transaction.id)}</td>
                    <td>{formatDate(transaction.occurred_at)}</td>
                    <td><span className="type-tag">{transaction.type}</span></td>
                    <td className="amt">{formatMoney(transaction.amount, transaction.currency)}</td>
                    <td><span className={`dir-badge ${transaction.direction}`}>{transaction.direction === 'debit' ? 'DR' : 'CR'}</span></td>
                    <td><span className={`badge ${transactionStatusClass(transaction.status)}`}>{transaction.status}</span></td>
                    <td><span className={`badge ${postingBadgeClass(journalStatus)}`}>{formatStatusLabel(journalStatus)}</span></td>
                    <td>
                      <div className="mono">{transaction.source.adapter}</div>
                      <div className="dim" style={{ fontSize: 11 }}>{transaction.source.environment ?? 'live'} · {transaction.dedupe_confidence}</div>
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      {journalStatus === 'unmapped' ? (
                        <button className="btn-link primary" onClick={() => mapTransaction(transaction)}>Map</button>
                      ) : (
                        <button className="btn-link primary" onClick={() => selectTransaction(transaction)}>View</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleTransactions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="dim">No transactions found. Ingest canonical records through an inbound adapter to populate this table.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {page.total > transactionPageSize ? (
          <div className="table-pagination">
            <span className="stat-sub">
              Showing {pageStart}-{pageEnd} of {page.total}
            </span>
            <div className="pagination-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={!canPageBack || loading}
                onClick={() => setTransactionOffset(Math.max(0, page.offset - transactionPageSize))}
              >
                Previous
              </button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={!canPageForward || loading}
                onClick={() => setTransactionOffset(page.offset + transactionPageSize)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className={`drawer-overlay${selectedTransaction ? ' open' : ''}`} onClick={closeTransactionDrawer} />
      <aside className={`drawer${selectedTransaction ? ' open' : ''}`} aria-hidden={!selectedTransaction}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>Transaction</h2>
            <div className="mono-id">{selectedTransaction?.source_id ?? selectedTransaction?.id}</div>
          </div>
          <button className="drawer-close" type="button" onClick={closeTransactionDrawer} aria-label="Close transaction drawer">
            ×
          </button>
        </div>
        {selectedTransaction ? (
          <TransactionDrawer
            journalEntries={journalEntries}
            mapTransaction={mapTransaction}
            openTransactionJournal={openTransactionJournal}
            transaction={selectedTransaction}
            closeTransactionDrawer={closeTransactionDrawer}
          />
        ) : null}
      </aside>
    </section>
  );
}

function TransactionDrawer(props: {
  journalEntries: JournalEntry[];
  mapTransaction: (transaction: TransactionRecord) => void;
  openTransactionJournal: (entry: JournalEntry) => void;
  transaction: TransactionRecord;
  closeTransactionDrawer: () => void;
}) {
  const { journalEntries, mapTransaction, openTransactionJournal, transaction, closeTransactionDrawer } = props;
  const journalEntry = journalEntries.find((entry) => entry.transaction_id === transaction.id);
  const journalStatus = transactionJournalStatus(transaction, journalEntries);

  return (
    <>
      <div className="drawer-body">
        <div className="drawer-section">
          <div className="drawer-section-title">Canonical Record</div>
          <div className="drawer-grid">
            <DetailField label="Source ID" value={transaction.source_id ?? '-'} mono />
            <DetailField label="Internal ID" value={transaction.id} mono />
            <DetailField label="Type" value={transaction.type} mono />
            <DetailField label="Amount" value={formatMoney(transaction.amount, transaction.currency)} strong />
            <DetailField label="Direction" value={transaction.direction} />
            <DetailField label="Channel" value={transaction.channel} />
            <DetailField label="Status" value={transaction.status} />
            <DetailField label="Environment" value={transaction.source.environment ?? 'live'} />
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Product & Source</div>
          <div className="drawer-grid">
            <DetailField label="Product Line" value={transaction.product.line} />
            <DetailField label="Biller" value={transaction.product.biller ?? '-'} />
            <DetailField label="Biller Category" value={transaction.product.biller_category ?? '-'} />
            <DetailField label="Adapter" value={transaction.source.adapter} mono />
            <DetailField label="Source System" value={transaction.source.system} />
            <DetailField label="Dedupe Confidence" value={transaction.dedupe_confidence} />
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Timing</div>
          <div className="drawer-grid">
            <DetailField label="Occurred At" value={formatDateTime(transaction.occurred_at)} />
            <DetailField label="Settled At" value={transaction.settled_at ? formatDateTime(transaction.settled_at) : '-'} />
            <DetailField label="Ingested At" value={formatDateTime(transaction.ingested_at)} />
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Journal Entry</div>
          {journalEntry ? (
            <div className="drawer-grid">
              <DetailField label="Journal ID" value={shortId(journalEntry.id)} mono />
              <DetailField label="Posting Status" value={formatStatusLabel(journalEntry.posting_status)} />
              <DetailField label="Entry Type" value={journalEntry.entry_type} />
              <DetailField label="Generated At" value={formatDateTime(journalEntry.generated_at)} />
              <DetailField
                label="Rule Applied"
                value={journalEntry.mapping_rule_id ? `${shortId(journalEntry.mapping_rule_id)} · v${journalEntry.mapping_rule_version ?? 1}` : 'No rule matched - suspense'}
                mono={Boolean(journalEntry.mapping_rule_id)}
              />
            </div>
          ) : transaction.source.environment === 'test' ? (
            <span className="badge test-env">Test env - blocked from posting</span>
          ) : transaction.status !== 'settled' && transaction.status !== 'reversed' ? (
            <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>Awaiting settlement before journal generation</span>
          ) : (
            <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>Eligible but no journal entry generated yet</span>
          )}
        </div>
      </div>

      <div className="drawer-footer">
        <span className={`badge ${postingBadgeClass(journalStatus)}`}>{formatStatusLabel(journalStatus)}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={closeTransactionDrawer}>Close</button>
          {journalEntry ? (
            <button className="btn btn-secondary btn-sm" onClick={() => openTransactionJournal(journalEntry)}>Open Journal Entry</button>
          ) : null}
          {journalStatus === 'unmapped' ? (
            <button className="btn btn-primary btn-sm" onClick={() => mapTransaction(transaction)}>Map Transaction</button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function MappingRulesView(props: {
  accounts: ChartAccount[];
  activeRules: number;
  inactiveRules: number;
  productLineCount: number;
  loading: boolean;
  rules: MappingRule[];
  error: string;
  ruleForm: RuleFormState;
  ruleDrawerOpen: boolean;
  creditSplitTotal: number;
  setRuleForm: (updater: RuleFormState | ((current: RuleFormState) => RuleFormState)) => void;
  saveRule: (event: FormEvent) => void;
  openNewRule: () => void;
  closeRuleDrawer: () => void;
  editRule: (rule: MappingRule) => void;
  toggleRule: (rule: MappingRule) => void;
  updateSplit: (index: number, patch: Partial<CreditSplit>) => void;
  removeSplit: (index: number) => void;
}) {
  const {
    accounts,
    activeRules,
    inactiveRules,
    productLineCount,
    loading,
    rules,
    error,
    ruleForm,
    ruleDrawerOpen,
    creditSplitTotal,
    setRuleForm,
    saveRule,
    openNewRule,
    closeRuleDrawer,
    editRule,
    toggleRule,
    updateSplit,
    removeSplit
  } = props;

  return (
    <section className="screen active">
      <div className="page-header">
        <div>
          <h1>Mapping Rules</h1>
          <p>Configure which COA accounts to debit and credit per transaction pattern</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openNewRule}>
            Add Rule
          </button>
        </div>
      </div>

      <div className="stat-bar cols-3">
        <StatCell label="Active Rules" value={String(activeRules)} sub={`across ${productLineCount} product lines`} tone="ok" />
        <StatCell label="COA Accounts" value={String(accounts.length)} sub="available for mappings" />
        <StatCell label="Inactive Rules" value={String(inactiveRules)} sub="manually deactivated" />
      </div>

      <div className="table-workspace">
        <div className="filter-bar">
          <input className="fi" placeholder="Search biller or account code..." style={{ width: 280 }} />
          <div className="spacer" />
          <span className="stat-sub">{loading ? 'Loading rules...' : `${rules.length} rules`}</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
              <thead>
                <tr>
                  <th>Product Line</th>
                  <th>Biller</th>
                  <th>Category</th>
                  <th>Type Filter</th>
                  <th>Debit Account</th>
                  <th>Credit Account(s)</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id} onClick={() => editRule(rule)}>
                    <td style={{ fontWeight: 500 }}>{rule.productLine}</td>
                    <td className={rule.biller ? '' : 'dim'}>{rule.biller || '-'}</td>
                    <td className={rule.billerCategory ? '' : 'dim'}>{rule.billerCategory || '-'}</td>
                    <td>{rule.transactionType ? <span className="type-tag">{rule.transactionType}</span> : <span className="dim">Catch-all</span>}</td>
                    <td>{accountChip(rule.debitAccountCode, accounts)}</td>
                    <td>
                      <div className="chip-stack">
                        {rule.creditSplits.map((split) => (
                          <span key={`${rule.id}-${split.accountCode}`}>
                            {accountChip(split.accountCode, accounts)}{' '}
                            <span className="dim" style={{ fontSize: 11 }}>
                              {formatBps(split.percentageBps)}
                            </span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td><span className={`badge ${rule.status === 'active' ? 'active-rule' : 'failed'}`}>{rule.status}</span></td>
                    <td className="mono">{rule.version}</td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <label className="toggle" title="Toggle active">
                          <input type="checkbox" checked={rule.status === 'active'} onChange={() => void toggleRule(rule)} />
                          <span className="toggle-track" />
                          <span className="toggle-thumb" />
                        </label>
                        <button className="btn-link primary" onClick={() => editRule(rule)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="dim">No mapping rules yet. Create the first rule from Add Rule.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
      </div>

      <div className={`drawer-overlay${ruleDrawerOpen ? ' open' : ''}`} onClick={closeRuleDrawer} />
      <aside className={`drawer${ruleDrawerOpen ? ' open' : ''}`} aria-hidden={!ruleDrawerOpen}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>{ruleForm.id ? 'Edit Mapping Rule' : 'Add Mapping Rule'}</h2>
            <div className="mono-id">Configure debit and credit accounts for a transaction pattern</div>
          </div>
          <button className="drawer-close" type="button" onClick={closeRuleDrawer} aria-label="Close mapping rule drawer">
            ×
          </button>
        </div>
        <RuleEditor
          accounts={accounts}
          error={error}
          ruleForm={ruleForm}
          creditSplitTotal={creditSplitTotal}
          setRuleForm={setRuleForm}
          saveRule={saveRule}
          updateSplit={updateSplit}
          removeSplit={removeSplit}
          closeRuleDrawer={closeRuleDrawer}
        />
      </aside>
    </section>
  );
}

function JournalLogView(props: {
  accounts: ChartAccount[];
  entries: JournalEntry[];
  error: string;
  filter: JournalEntry['posting_status'] | 'all';
  loading: boolean;
  retryJournalEntry: (entry: JournalEntry) => void;
  selectedJournal: JournalEntry | null;
  selectJournal: (entry: JournalEntry) => void;
  closeJournalDrawer: () => void;
  setFilter: (filter: JournalEntry['posting_status'] | 'all') => void;
}) {
  const {
    accounts,
    entries,
    error,
    filter,
    loading,
    retryJournalEntry,
    selectedJournal,
    selectJournal,
    closeJournalDrawer,
    setFilter
  } = props;
  const posted = entries.filter((entry) => entry.posting_status === 'posted').length;
  const failed = entries.filter((entry) => ['failed', 'retry_exhausted'].includes(entry.posting_status)).length;
  const unmapped = entries.filter((entry) => entry.posting_status === 'unmapped').length;
  const generated = entries.filter((entry) => entry.posting_status === 'generated').length;
  const lastGeneratedAt = entries[0]?.generated_at;

  return (
    <section className="screen active">
      <div className="page-header">
        <div>
          <h1>Journal Log</h1>
          <p>Double-entry records generated by the engine and queued for outbound accounting adapters</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setFilter('generated')}>
            Run Engine Now
          </button>
        </div>
      </div>

      <div className="stat-bar cols-4">
        <StatCell label="Generated" value={String(generated)} sub="ready for outbound posting" />
        <StatCell label="Posted" value={String(posted)} sub="accepted by accounting system" tone="ok" />
        <StatCell label="Failed" value={String(failed)} sub="failed or retry-exhausted entries" tone={failed ? 'bad' : undefined} />
        <StatCell label="Unmapped" value={String(unmapped)} sub="parked in suspense" tone={unmapped ? 'warn' : undefined} />
      </div>

      <div className="table-workspace">
        <div className="filter-bar">
          <input className="fi" type="date" style={{ width: 140 }} />
          <span style={{ color: 'var(--color-text-3)', fontSize: 'var(--text-sm)' }}>to</span>
          <input className="fi" type="date" style={{ width: 140 }} />
          <div className="bar-sep" />
          <select className="fi" value={filter} onChange={(event) => setFilter(event.target.value as JournalEntry['posting_status'] | 'all')}>
            <option value="all">All statuses</option>
            <option value="generated">Generated</option>
            <option value="posting">Posting</option>
            <option value="posted">Posted</option>
            <option value="failed">Failed</option>
            <option value="unmapped">Unmapped</option>
            <option value="retry_exhausted">Retry exhausted</option>
          </select>
          <button
            className={`btn btn-ghost btn-sm${filter === 'failed' || filter === 'unmapped' ? ' active-filter' : ''}`}
            onClick={() => setFilter(filter === 'failed' || filter === 'unmapped' ? 'all' : failed ? 'failed' : 'unmapped')}
          >
            Failed & unmapped only
          </button>
          <div className="spacer" />
          <span className="stat-sub">
            {loading
              ? 'Loading journal entries...'
              : `${entries.length} entries${lastGeneratedAt ? ` · last generated ${formatDateTime(lastGeneratedAt)}` : ''}`}
          </span>
        </div>
        {error ? <div className="form-error journal-error">{error}</div> : null}
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Journal ID</th>
                <th>Transaction ID</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Debit</th>
                <th>Credit</th>
                <th>Posting Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} onClick={() => selectJournal(entry)}>
                  <td className="mono">{shortId(entry.id)}</td>
                  <td className="mono">{entry.transaction?.source_id ?? shortId(entry.transaction_id)}</td>
                  <td>{formatDate(entry.transaction?.occurred_at ?? entry.generated_at)}</td>
                  <td className="amt">{formatMoney(entry.amount, entry.currency)}</td>
                  <td>{journalSideChips(entry, 'debit', accounts)}</td>
                  <td>{journalSideChips(entry, 'credit', accounts)}</td>
                  <td><span className={`badge ${postingBadgeClass(entry.posting_status)}`}>{formatStatusLabel(entry.posting_status)}</span></td>
                  <td onClick={(event) => event.stopPropagation()}>
                    {['failed', 'retry_exhausted'].includes(entry.posting_status) ? (
                      <button className="btn-link danger" onClick={() => void retryJournalEntry(entry)}>
                        Retry
                      </button>
                    ) : (
                      <button className="btn-link primary" onClick={() => selectJournal(entry)}>View</button>
                    )}
                  </td>
                </tr>
              ))}
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="dim">No journal entries found for this filter.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`drawer-overlay${selectedJournal ? ' open' : ''}`} onClick={closeJournalDrawer} />
      <aside className={`drawer${selectedJournal ? ' open' : ''}`} aria-hidden={!selectedJournal}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>Journal Entry</h2>
            <div className="mono-id">{selectedJournal?.id}</div>
          </div>
          <button className="drawer-close" type="button" onClick={closeJournalDrawer} aria-label="Close journal drawer">
            ×
          </button>
        </div>
        {selectedJournal ? (
          <JournalDrawer
            accounts={accounts}
            entry={selectedJournal}
            retryJournalEntry={retryJournalEntry}
            closeJournalDrawer={closeJournalDrawer}
          />
        ) : null}
      </aside>
    </section>
  );
}

function JournalDrawer(props: {
  accounts: ChartAccount[];
  entry: JournalEntry;
  retryJournalEntry: (entry: JournalEntry) => void;
  closeJournalDrawer: () => void;
}) {
  const { accounts, entry, retryJournalEntry, closeJournalDrawer } = props;
  const transaction = entry.transaction;

  return (
    <>
      <div className="drawer-body">
        <div className="drawer-section">
          <div className="drawer-section-title">Entry Lines</div>
          {entry.entry_type === 'reversal' ? (
            <div className="reversal-notice">Reversal entry - debits and credits are swapped from the original journal entry.</div>
          ) : null}
          <div className="jlines">
            {entry.lines.map((line) => {
              const account = accounts.find((item) => item.code === line.account_code);
              return (
                <div className="jline" key={`${entry.id}-${line.line_order}`}>
                  <span className={`jline-type ${line.side === 'debit' ? 'dr' : 'cr'}`}>
                    {line.side === 'debit' ? 'DR' : 'CR'}
                  </span>
                  <div className="jline-acct">
                    <div className="jline-acct-code">{line.account_code}</div>
                    <div className="jline-acct-name">{account?.name ?? 'Unknown account'}</div>
                  </div>
                  <span className="jline-amt">{formatMoney(line.amount, line.currency)}</span>
                </div>
              );
            })}
          </div>
          {entry.posting_status === 'unmapped' ? (
            <p className="drawer-note">Parked in suspense pending rule assignment.</p>
          ) : null}
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Transaction</div>
          <div className="drawer-grid">
            <DetailField label="TX ID" value={transaction?.source_id ?? shortId(entry.transaction_id)} mono />
            <DetailField label="Date" value={formatDate(transaction?.occurred_at ?? entry.generated_at)} />
            <DetailField label="Type" value={transaction?.type ?? entry.entry_type} mono />
            <DetailField label="Amount" value={formatMoney(entry.amount, entry.currency)} strong />
            <DetailField label="Product Line" value={transaction?.product_line ?? '-'} />
            <DetailField label="Biller" value={transaction?.product_biller ?? '-'} />
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Mapping & Posting</div>
          <div className="drawer-grid">
            <DetailField
              label="Rule Applied"
              value={entry.mapping_rule_id ? `${shortId(entry.mapping_rule_id)} · v${entry.mapping_rule_version ?? 1}` : 'No rule matched - suspense'}
              mono={Boolean(entry.mapping_rule_id)}
            />
            <DetailField label="Adapter" value={entry.latest_attempt?.adapter_name ?? 'generic-journal-csv'} mono />
            <DetailField label="Attempts" value={String(entry.attempt_count)} />
            <DetailField label="Posted At" value={entry.posted_at ? formatDateTime(entry.posted_at) : '-'} />
            <DetailField label="Last Error" value={entry.last_posting_error ?? '-'} />
          </div>
        </div>

        <div className="drawer-section">
          <div className="drawer-section-title">Posting History</div>
          <div className="timeline">
            {journalTimeline(entry).map((item, index) => (
              <div className="timeline-item" key={`${item.event}-${index}`}>
                <div className={`tl-dot ${item.ok ? 'ok' : 'err'}`} />
                <div>
                  <div className="tl-event">{item.event}</div>
                  <div className="tl-time">{formatDateTime(item.time)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="drawer-footer">
        <span className={`badge ${postingBadgeClass(entry.posting_status)}`}>
          {formatStatusLabel(entry.posting_status)}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={closeJournalDrawer}>Close</button>
          {['failed', 'retry_exhausted'].includes(entry.posting_status) ? (
            <button className="btn btn-danger btn-sm" onClick={() => void retryJournalEntry(entry)}>Retry Now</button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function RuleEditor(props: {
  accounts: ChartAccount[];
  error: string;
  ruleForm: RuleFormState;
  creditSplitTotal: number;
  setRuleForm: (updater: RuleFormState | ((current: RuleFormState) => RuleFormState)) => void;
  saveRule: (event: FormEvent) => void;
  updateSplit: (index: number, patch: Partial<CreditSplit>) => void;
  removeSplit: (index: number) => void;
  closeRuleDrawer: () => void;
}) {
  const { accounts, error, ruleForm, creditSplitTotal, setRuleForm, saveRule, updateSplit, removeSplit, closeRuleDrawer } = props;
  const canSave = creditSplitTotal === 10000 && ruleForm.productLine && ruleForm.debitAccountCode;

  return (
    <form className="rule-drawer-form" onSubmit={saveRule}>
      <div className="drawer-body">
        {error ? <div className="form-error">{error}</div> : null}

        <div className="drawer-section rule-match-section">
          <TextField label="Product Line" value={ruleForm.productLine} onChange={(value) => setRuleForm({ ...ruleForm, productLine: value })} />
          <div className="form-row">
            <TextField label="Biller" value={ruleForm.biller} onChange={(value) => setRuleForm({ ...ruleForm, biller: value })} />
            <TextField label="Biller Category" value={ruleForm.billerCategory} onChange={(value) => setRuleForm({ ...ruleForm, billerCategory: value })} />
          </div>
          <TextField label="Transaction Type Filter" value={ruleForm.transactionType} onChange={(value) => setRuleForm({ ...ruleForm, transactionType: value })} />
        </div>

        <div className="drawer-section">
          <div className="form-section-label rule-section-label">Account</div>
          <div className="form-field">
            <label>Debit Account</label>
            <select value={ruleForm.debitAccountCode} onChange={(event) => setRuleForm({ ...ruleForm, debitAccountCode: event.target.value })}>
              <option value="">Select account</option>
              {accounts.map((account) => <option key={account.id} value={account.code}>{account.code} - {account.name}</option>)}
            </select>
          </div>

          <div className="form-field">
            <label>Credit Account(s)</label>
            {ruleForm.creditSplits.map((split, index) => (
              <div className="credit-row" key={index}>
                <select value={split.accountCode} onChange={(event) => updateSplit(index, { accountCode: event.target.value })}>
                  <option value="">Credit account</option>
                  {accounts.map((account) => <option key={account.id} value={account.code}>{account.code} - {account.name}</option>)}
                </select>
                <div className="percent-input">
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={split.percentageBps / 100}
                    onChange={(event) => updateSplit(index, { percentageBps: Math.round(Number(event.target.value) * 100) })}
                    aria-label="Credit split percentage"
                  />
                  <span>%</span>
                </div>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => removeSplit(index)} disabled={ruleForm.creditSplits.length === 1}>Remove</button>
              </div>
            ))}
            <button
              className="btn btn-secondary btn-sm split-add-button"
              type="button"
              onClick={() => setRuleForm((current) => ({ ...current, creditSplits: [...current.creditSplits, { accountCode: '', percentageBps: 0 }] }))}
            >
              Add split
            </button>
            <div className={`split-total ${creditSplitTotal === 10000 ? 'ok' : 'bad'}`}>
              Total: {formatBps(creditSplitTotal)}
            </div>
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        <button className="btn btn-ghost" type="button" onClick={closeRuleDrawer}>Cancel</button>
        <button className="btn btn-primary" type="submit" disabled={!canSave}>{ruleForm.id ? 'Save Changes' : 'Save Rule'}</button>
      </div>
    </form>
  );
}

function SettingsView(props: {
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  accounts: ChartAccount[];
  adapters: AdapterRecord[];
  coaForm: { code: string; name: string; type: AccountType };
  setCoaForm: (form: { code: string; name: string; type: AccountType }) => void;
  saveCoaAccount: (event: FormEvent) => void;
  saveAdapterConfiguration: (adapter: AdapterRecord, config: unknown) => Promise<void>;
  toggleAdapterConfiguration: (adapter: AdapterRecord, enabled: boolean) => Promise<void>;
  error: string;
  setNotice: (notice: string) => void;
}) {
  const {
    settingsTab,
    setSettingsTab,
    accounts,
    adapters,
    coaForm,
    setCoaForm,
    saveCoaAccount,
    saveAdapterConfiguration,
    toggleAdapterConfiguration,
    error
  } = props;
  const [selectedAdapterName, setSelectedAdapterName] = useState<string | null>(null);

  const selectedAdapter = adapters.find((adapter) => adapter.name === selectedAdapterName) ?? null;

  return (
    <section className="screen active">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>System configuration, adapter catalog, and accounting references</p>
        </div>
      </div>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-label">Configuration</div>
          {(['coa', 'schema', 'adapters', 'users', 'system'] as SettingsTab[]).map((tab) => (
            <button key={tab} className={`settings-nav-btn${settingsTab === tab ? ' active' : ''}`} onClick={() => setSettingsTab(tab)}>
              <SettingsTabIcon tab={tab} />
              {tab === 'coa' ? 'COA Reference' : labelizeTab(tab)}
            </button>
          ))}
        </aside>
        <div className="settings-content">
          {settingsTab === 'schema' ? (
            <SchemaSettingsPanel />
          ) : settingsTab === 'coa' ? (
            <div className="settings-panel active">
              <h2>COA Reference</h2>
              <p className="panel-desc">Account codes used in mapping rules.</p>

              <form className="coa-import-strip coa-form" onSubmit={saveCoaAccount}>
                <input className="fi" placeholder="Code" value={coaForm.code} onChange={(event) => setCoaForm({ ...coaForm, code: event.target.value })} />
                <input className="fi" placeholder="Account name" value={coaForm.name} onChange={(event) => setCoaForm({ ...coaForm, name: event.target.value })} />
                <select className="fi" value={coaForm.type} onChange={(event) => setCoaForm({ ...coaForm, type: event.target.value as AccountType })}>
                  <option value="asset">Asset</option>
                  <option value="liability">Liability</option>
                  <option value="equity">Equity</option>
                  <option value="revenue">Revenue</option>
                  <option value="expense">Expense</option>
                </select>
                <button className="btn btn-primary btn-sm" type="submit">Import Account</button>
              </form>
              {error ? <div className="form-error">{error}</div> : null}

              <div className="table-card">
                <table className="tbl">
                  <thead>
                    <tr><th>Code</th><th>Account Name</th><th>Type</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <tr key={account.id}>
                        <td className="mono">{account.code}</td>
                        <td>{account.name}</td>
                        <td>{accountTypeChip(account.type)}</td>
                        <td><span className={`badge ${account.active ? 'active-rule' : 'failed'}`}>{account.active ? 'Active' : 'Inactive'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : settingsTab === 'adapters' ? (
            <AdapterSettingsPanel
              adapters={adapters}
              onCloseDrawer={() => setSelectedAdapterName(null)}
              onConfigure={(adapter) => setSelectedAdapterName(adapter.name)}
              onSave={async (adapter, config) => {
                await saveAdapterConfiguration(adapter, config);
                setSelectedAdapterName(null);
              }}
              onToggleAdapter={(adapter, enabled) => void toggleAdapterConfiguration(adapter, enabled)}
              selectedAdapter={selectedAdapter}
            />
          ) : (
            <Placeholder title={labelizeTab(settingsTab)} subtitle="This settings panel will be wired in its corresponding phase." embedded />
          )}
        </div>
      </div>
    </section>
  );
}

function AdapterSettingsPanel(props: {
  adapters: AdapterRecord[];
  selectedAdapter: AdapterRecord | null;
  onConfigure: (adapter: AdapterRecord) => void;
  onCloseDrawer: () => void;
  onSave: (adapter: AdapterRecord, config: unknown) => Promise<void>;
  onToggleAdapter: (adapter: AdapterRecord, enabled: boolean) => void;
}) {
  const { adapters, selectedAdapter, onConfigure, onCloseDrawer, onSave, onToggleAdapter } = props;
  const inboundAdapters = adapters.filter((adapter) => adapter.direction === 'inbound');
  const outboundAdapters = adapters.filter((adapter) => adapter.direction === 'outbound');

  return (
    <div className="settings-panel active">
      <h2>Adapters</h2>
      <p className="panel-desc">
        Registered inbound and outbound adapters. Adapter configuration controls how source records are normalized and how generated journal entries leave Ledgerise.
      </p>

      <div className="section-group-label">Inbound</div>
      <div className="adapter-list" style={{ marginBottom: 'var(--s8)' }}>
        {inboundAdapters.map((adapter) => (
          <AdapterCard
            key={adapter.name}
            adapter={adapter}
            enabled={adapter.enabled ?? true}
            onConfigure={onConfigure}
            onToggleAdapter={onToggleAdapter}
          />
        ))}
      </div>

      <div className="section-group-label">Outbound</div>
      <p className="outbound-desc">
        Outbound adapters receive batched journal entries from the engine and post or export them for accounting systems.
      </p>
      <div className="adapter-list">
        {outboundAdapters.map((adapter) => (
          <AdapterCard
            key={adapter.name}
            adapter={adapter}
            enabled={adapter.enabled ?? true}
            onConfigure={onConfigure}
            onToggleAdapter={onToggleAdapter}
          />
        ))}
      </div>

      <AdapterConfigDrawer adapter={selectedAdapter} onClose={onCloseDrawer} onSave={onSave} />
    </div>
  );
}

function SchemaSettingsPanel() {
  const canonicalFields = [
    ['id', 'Ledgerise-generated UUID for the normalized record.', 'Yes', 'Internal identity', '9f7a...c22'],
    ['source_id', 'Original provider reference, when available.', 'No', 'Deduplication and audit trail', 'SRC_839104'],
    ['source', 'Adapter, source system, and live/test environment.', 'Yes', 'Traceability and test blocking', 'generic-api / live'],
    ['status', 'Settlement state: pending, settled, failed, reversed, disputed.', 'Yes', 'Posting eligibility', 'settled'],
    ['type', 'Business category of the transaction using dot notation.', 'Yes', 'Mapping context and reporting', 'payment.electricity'],
    ['direction', 'Money movement from the operator perspective.', 'Yes', 'Journal line direction', 'debit'],
    ['amount', 'Positive amount in the smallest currency unit.', 'Yes', 'Journal value', '500000'],
    ['currency', 'ISO 4217 three-letter currency code.', 'Yes', 'Accounting currency', 'NGN'],
    ['product', 'Product line, biller, and biller category.', 'Yes', 'Primary mapping lookup', 'consumer-app / ikeja-electric'],
    ['principal', 'Customer, merchant, agent, or internal actor. PII must be masked.', 'Yes', 'Audit trail', 'customer / ***4821'],
    ['fee', 'Platform fee, processing fee, and net fee when present.', 'No', 'Revenue/cost splits', 'platform_fee: 5000'],
    ['metadata', 'Source-specific extra fields that do not affect mapping.', 'Yes', 'Debugging and audit context', 'terminal_id: POS-17']
  ];
  const modeCards = [
    ['Webhook', 'Source system pushes each event to Ledgerise. Best for payment processors that support reliable event callbacks.', 'generic-webhook'],
    ['Poll', 'Ledgerise calls the source API on a schedule using a cursor such as last fetched time or source ID.', 'generic-poll'],
    ['File Import', 'Operator uploads CSV exports. Useful for onboarding, backfills, banks, and providers without an API.', 'generic-csv'],
    ['Manual Entry', 'Structured one-off entry for exceptions. Stored through the same canonical schema.', 'manual-entry']
  ];
  const typeGroups = [
    ['Payments', ['payment.airtime', 'payment.data', 'payment.electricity', 'payment.cable-tv', 'payment.internet', 'payment.merchant']],
    ['Transfers & Collections', ['transfer.wallet-to-bank', 'transfer.bank-to-wallet', 'collection.pos', 'collection.web', 'collection.ussd', 'collection.bank-transfer']],
    ['Fees, FX & Cards', ['fee.platform', 'fee.processing', 'fx.conversion', 'fx.gain', 'card.spend', 'card.chargeback']],
    ['Lending, Savings & Agency', ['loan.disbursement', 'loan.repayment.interest', 'savings.deposit', 'investment.purchase', 'agency.cash-in', 'agency.commission']]
  ];

  return (
    <div className="settings-panel active">
      <h2>Schema &amp; Types</h2>
      <p className="panel-desc">Operator-facing reference for the canonical transaction record. These fields are produced by inbound adapters and consumed by the journal engine.</p>

      <div className="schema-flow">
        {[
          ['Raw source event', 'Webhook, poll result, file row, or manual entry'],
          ['Inbound adapter', 'Validates, masks PII, converts amounts, normalizes fields'],
          ['Canonical record', 'Single stable format for mapping and journal generation']
        ].map(([title, detail], index) => (
          <FragmentWithArrow key={title} index={index}>
            <div className="schema-flow-step">
              <span className="schema-flow-num">{index + 1}</span>
              <div><strong>{title}</strong><span>{detail}</span></div>
            </div>
          </FragmentWithArrow>
        ))}
      </div>

      <div className="schema-reference-grid">
        <section className="schema-card">
          <div className="schema-card-title">Posting Rules</div>
          <div className="schema-rule-list">
            <div><span className="chip income">Posted</span> Only <code>settled</code> records with <code>settled_at</code> can become journal entries.</div>
            <div><span className="chip expense">Blocked</span> <code>failed</code>, <code>pending</code>, and <code>disputed</code> records are stored but not posted.</div>
            <div><span className="chip suspense">Review</span> No matching mapping rule means suspense/unmapped, never silent dropping.</div>
            <div><span className="chip asset">Reversal</span> <code>reversed</code> records mirror the original posted journal when <code>reversal_of</code> is present.</div>
          </div>
        </section>

        <section className="schema-card">
          <div className="schema-card-title">Mapping Priority</div>
          <ol className="schema-ordered-list">
            <li><code>product.line</code> + <code>product.biller</code></li>
            <li><code>product.line</code> + <code>product.biller_category</code></li>
            <li><code>product.line</code> catch-all</li>
            <li>Suspense account if no rule matches</li>
          </ol>
        </section>
      </div>

      <div className="section-group-label">Canonical Fields</div>
      <div className="table-card" style={{ marginBottom: 'var(--s6)' }}>
        <table className="tbl schema-table">
          <thead>
            <tr><th>Field</th><th>Meaning</th><th>Required</th><th>Used For</th><th>Example</th></tr>
          </thead>
          <tbody>
            {canonicalFields.map(([field, meaning, required, usedFor, example]) => (
              <tr key={field}>
                <td className="mono">{field}</td>
                <td>{meaning}</td>
                <td><span className={`badge ${required === 'Yes' ? 'healthy' : 'auditor-role'}`}>{required}</span></td>
                <td>{usedFor}</td>
                <td className="mono">{example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-group-label">Adapter Modes</div>
      <div className="schema-mode-grid">
        {modeCards.map(([title, detail, tag]) => (
          <div className="schema-mode-card" key={title}>
            <div className="schema-mode-title">{title}</div>
            <p>{detail}</p>
            <span className="type-tag">{tag}</span>
          </div>
        ))}
      </div>

      <div className="section-group-label" style={{ marginTop: 'var(--s6)' }}>Transaction Type Library</div>
      <div className="schema-type-grid">
        {typeGroups.map(([title, types]) => (
          <div className="schema-type-card" key={title as string}>
            <div className="schema-type-title">{title}</div>
            <div className="schema-type-list">
              {(types as string[]).map((type) => <span key={type}>{type}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="schema-note">
        Custom types are allowed when they use dot notation, for example <code>payment.toll</code> or <code>agency.crop-insurance</code>. A matching mapping rule must exist or the transaction is held as unmapped.
      </div>
    </div>
  );
}

function FragmentWithArrow({ children, index }: { children: ReactNode; index: number }) {
  return (
    <>
      {index > 0 ? <div className="schema-flow-arrow">→</div> : null}
      {children}
    </>
  );
}

function AdapterCard(props: {
  adapter: AdapterRecord;
  enabled: boolean;
  onConfigure: (adapter: AdapterRecord) => void;
  onToggleAdapter: (adapter: AdapterRecord, enabled: boolean) => void;
}) {
  const { adapter, enabled, onConfigure, onToggleAdapter } = props;
  const template = adapterConfigTemplates[adapter.name];
  const system = adapter.source_system ?? adapter.target_system ?? 'generic';

  return (
    <div className="adapter-card">
      <div className="adapter-card-top">
        <div className="adapter-meta">
          <div className="adapter-icon" aria-hidden="true">
            <AdapterGlyph adapterName={adapter.name} direction={adapter.direction} />
          </div>
          <div>
            <div className="adapter-name">{adapter.name}</div>
            <div className="adapter-desc">
              {template?.summary ?? `${labelizeText(adapter.direction)} adapter for ${system}`} · {template?.subtitle ?? labelizeText(adapter.direction)}
            </div>
            <div className="adapter-sub">
              <span className={`badge ${enabled ? 'healthy' : 'failed'}`}><span className="badge-dot" />{enabled ? 'Enabled' : 'Disabled'}</span>
              <span>·</span><span>v{adapter.version}</span>
              <span>·</span><span>Modes: {adapter.modes.join(', ')}</span>
              <span>·</span><span>Currencies: {adapter.currency_codes.join(', ')}</span>
              <span>·</span><span>Runtime: {adapter.runtime.type}</span>
            </div>
          </div>
        </div>
        <div className="adapter-controls">
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => onConfigure(adapter)}>Configure</button>
          <label className="toggle" title="Toggle adapter active">
            <input type="checkbox" checked={enabled} onChange={(event) => onToggleAdapter(adapter, event.target.checked)} />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
        </div>
      </div>
    </div>
  );
}

function AdapterConfigDrawer(props: {
  adapter: AdapterRecord | null;
  onClose: () => void;
  onSave: (adapter: AdapterRecord, config: unknown) => Promise<void>;
}) {
  const { adapter, onClose, onSave } = props;
  const template = adapter ? getAdapterConfigTemplate(adapter) : null;
  const formRef = useRef<HTMLFormElement | null>(null);

  return (
    <>
      <div className={`drawer-overlay${adapter ? ' open' : ''}`} onClick={onClose} />
      <form
        ref={formRef}
        id="ac-drawer"
        className={`drawer${adapter ? ' open' : ''}`}
        aria-hidden={!adapter}
        onSubmit={(event) => {
          event.preventDefault();
          if (!adapter || !formRef.current) return;
          void onSave(adapter, buildAdapterOperationalConfig(adapter, new FormData(formRef.current)));
        }}
      >
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>{adapter?.name ?? 'Adapter configuration'}</h2>
            <div className="mono-id">{template?.subtitle ?? 'Adapter configuration'}</div>
          </div>
          <button className="drawer-close" type="button" onClick={onClose} aria-label="Close adapter configuration drawer">×</button>
        </div>
        <div className="drawer-body">
          {adapter && template ? (
            template.sections.map((section) => (
              <div className="drawer-section" key={section.title}>
                <div className="drawer-section-title">{section.title}</div>
                {section.desc ? <p className="config-section-desc">{section.desc}</p> : null}
                {section.fields.map((field, index) => (
                  <AdapterConfigFieldView field={field} key={`${section.title}-${index}`} />
                ))}
              </div>
            ))
          ) : (
            <p className="panel-desc">Select an adapter to configure.</p>
          )}
        </div>
        <div className="drawer-footer">
          <span className="dim" style={{ fontSize: 12 }}>
            {adapter ? `Registry: ${adapter.direction} · ${adapter.modes.join(', ')}` : ''}
          </span>
          <div className="drawer-actions">
            <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={!adapter}>Save Configuration</button>
          </div>
        </div>
      </form>
    </>
  );
}

function AdapterConfigFieldView({ field }: { field: AdapterConfigField }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detected, setDetected] = useState(false);
  const [mappingRows, setMappingRows] = useState(field.type === 'mapping' ? field.rows : []);
  const sampleRef = useRef<HTMLTextAreaElement | null>(null);

  const mappingId = field.type === 'mapping' ? field.id : '';

  useEffect(() => {
    if (field.type === 'mapping') {
      setMappingRows(field.rows);
      setDetected(false);
      setPreviewOpen(false);
    }
  }, [mappingId]);

  if (field.type === 'display') {
    return (
      <div className="form-field">
        <label>{field.label}</label>
        <div className="display-value">
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{field.value}</span>
          <button className="btn-link primary copy-btn" type="button" onClick={() => void navigator.clipboard?.writeText(field.value)}>Copy</button>
        </div>
        <div className="hint">{field.hint}</div>
      </div>
    );
  }

  if (field.type === 'text' || field.type === 'password' || field.type === 'number') {
    return (
      <div className="form-field">
        <label>{field.label}</label>
        <input
          type={field.type}
          name={field.key ? `field:${field.key}` : undefined}
          defaultValue={field.value}
          placeholder={field.type === 'password' ? '••••••••••••' : undefined}
        />
        <div className="hint">{field.hint}</div>
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="form-field">
        <label>{field.label}</label>
        <select name={field.key ? `field:${field.key}` : undefined} defaultValue={field.value}>
          {field.options.map((option) => <option key={option}>{option}</option>)}
        </select>
        <div className="hint">{field.hint}</div>
      </div>
    );
  }

  if (field.type === 'action') {
    return (
      <div className="form-field">
        <div className="connect-field">
          <button className="btn btn-secondary btn-sm" type="button">{field.text}</button>
          <span className={`connect-status ${field.statusClass}`}>{field.status}</span>
        </div>
      </div>
    );
  }

  if (field.type !== 'mapping') {
    return null;
  }

  const mappingField = field;

  return (
    <>
      <div className="field-map-sample">
        <div className="field-map-sample-top">
          <div>
            <div className="field-map-sample-title">Sample {mappingField.sourceLabel ? 'file row' : 'payload'}</div>
            <div className={`field-map-status${detected ? ' ok' : ''}`}>
              {detected ? `${mappingRows.length} suggested mappings detected. Review transforms before saving.` : 'Paste a sample, then detect suggested mappings.'}
            </div>
          </div>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => {
              const sample = sampleRef.current?.value ?? mappingField.preview.source;
              const sourceFields = detectSourceFields(sample, Boolean(mappingField.sourceLabel));
              setMappingRows((current) => applyDetectedFields(current, sourceFields));
              setDetected(true);
            }}
          >
            Detect fields
          </button>
        </div>
        <textarea ref={sampleRef} spellCheck={false} defaultValue={mappingField.preview.source} />
      </div>
      <div className="field-map">
        <div className="field-map-head">
          <span>{mappingField.sourceLabel ?? 'Source field'}</span>
          <span>Standard Ledgerise field</span>
          <span>Required</span>
          <span />
        </div>
        <div className="field-map-body">
          {mappingRows.map((row, index) => (
            <div className="field-map-row" key={`${row.sourcePath}-${index}`}>
              <input
                type="text"
                name={`map:${mappingField.id}:${index}:sourcePath`}
                value={row.sourcePath}
                onChange={(event) => updateMappingRow(setMappingRows, index, { sourcePath: event.target.value })}
              />
              <select
                name={`map:${mappingField.id}:${index}:canonicalField`}
                value={row.canonicalField}
                onChange={(event) => updateMappingRow(setMappingRows, index, { canonicalField: event.target.value })}
              >
                {canonicalFieldOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
              <label className="field-map-required">
                <input
                  type="checkbox"
                  name={`map:${mappingField.id}:${index}:required`}
                  checked={row.required}
                  onChange={(event) => updateMappingRow(setMappingRows, index, { required: event.target.checked })}
                />
              </label>
              <div className="field-map-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  aria-label="Remove mapping row"
                  onClick={() => setMappingRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="field-map-toolbar">
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          onClick={() =>
            setMappingRows((current) => [
              ...current,
              { sourcePath: '', canonicalField: 'metadata', transform: 'copy', defaultValue: '', required: false }
            ])
          }
        >
          Add field
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setPreviewOpen(true)}>Preview mapping</button>
      </div>
      <div className="field-map-note">Detected source fields are mapped onto Ledgerise canonical fields. Adapter defaults still handle normalization, validation, and required canonical structure.</div>
      {previewOpen ? (
        <div className="field-map-preview">
          <div className="field-map-preview-title">Preview output</div>
          <pre>{mappingField.preview.output}</pre>
        </div>
      ) : null}
    </>
  );
}

function getAdapterConfigTemplate(adapter: AdapterRecord): AdapterConfigTemplate | null {
  const template = adapterConfigTemplates[adapter.name];
  if (!template) return null;

  const config = isRecord(adapter.config) ? adapter.config : {};
  return {
    ...template,
    sections: template.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        if (field.type !== 'mapping') return field;

        if (adapter.name === 'generic-csv' && field.id === 'generic-csv-map') {
          return {
            ...field,
            rows: rowsFromMappingConfig(
              isRecord(config.column_mappings) ? config.column_mappings : undefined,
              field.rows
            )
          };
        }

        if (adapter.name === 'generic-webhook' && field.id === 'generic-webhook-map') {
          return {
            ...field,
            rows: rowsFromMappingConfig(
              isRecord(config.field_mappings) ? config.field_mappings : undefined,
              field.rows
            )
          };
        }

        return field;
      })
    }))
  };
}

function rowsFromMappingConfig(
  mapping: Record<string, unknown> | undefined,
  fallback: AdapterMappingRow[]
): AdapterMappingRow[] {
  if (!mapping) return fallback;
  const fallbackByCanonical = new Map(fallback.map((row) => [row.canonicalField, row]));
  return Object.entries(mapping)
    .filter(([, sourcePath]) => typeof sourcePath === 'string' && sourcePath.trim())
    .map(([canonicalField, sourcePath]) => ({
      sourcePath: String(sourcePath),
      canonicalField,
      transform: fallbackByCanonical.get(canonicalField)?.transform ?? defaultTransformForField(canonicalField),
      defaultValue: fallbackByCanonical.get(canonicalField)?.defaultValue ?? '',
      required: fallbackByCanonical.get(canonicalField)?.required ?? requiredCanonicalFields.has(canonicalField)
    }));
}

function buildAdapterOperationalConfig(adapter: AdapterRecord, formData: FormData): unknown {
  if (adapter.name === 'generic-csv') {
    return {
      ...defaultAdapterOperationalConfig(adapter.name),
      column_mappings: mappingRowsToObject(readMappingRows(formData, 'generic-csv-map'))
    };
  }

  if (adapter.name === 'generic-webhook') {
    return {
      ...defaultAdapterOperationalConfig(adapter.name),
      field_mappings: mappingRowsToObject(readMappingRows(formData, 'generic-webhook-map'))
    };
  }

  return {
    ...defaultAdapterOperationalConfig(adapter.name),
    ...readFieldValues(formData)
  };
}

function defaultAdapterOperationalConfig(adapterName: string): Record<string, unknown> {
  if (adapterName === 'generic-csv') {
    return {
      source_system: 'csv-backfill',
      environment: 'live',
      column_mappings: {
        source_id: 'reference',
        occurred_at: 'occurred_at',
        settled_at: 'settled_at',
        status: 'status',
        type: 'type',
        direction: 'direction',
        amount: 'amount',
        currency: 'currency',
        channel: 'channel',
        'principal.id': 'principal_id',
        'principal.type': 'principal_type',
        'principal.reference': 'principal_reference',
        'product.line': 'product_line',
        'product.biller': 'biller',
        'product.biller_category': 'biller_category'
      },
      metadata_columns: {
        token: 'token'
      }
    };
  }

  if (adapterName === 'generic-webhook') {
    return {
      source_system: 'generic-api',
      environment: 'live',
      field_mappings: {
        source_id: 'txn_ref',
        occurred_at: 'paid_at',
        status: 'state',
        amount: 'value',
        type: 'service',
        direction: 'direction',
        currency: 'currency',
        channel: 'channel',
        'product.line': 'product_line',
        'product.biller': 'biller',
        'product.biller_category': 'biller_category',
        'principal.id': 'customer_id',
        'principal.reference': 'customer_phone',
        'principal.type': 'principal_type'
      },
      defaults: {
        direction: 'debit',
        currency: 'NGN',
        channel: 'api',
        'product.line': 'consumer-app',
        'principal.type': 'customer'
      },
      metadata_paths: {
        raw_service: 'service'
      },
      amount_multiplier: 100
    };
  }

  if (adapterName === 'generic-journal-csv') {
    return {
      file_name_pattern: 'ledgerise-journals-{batch_id}.csv',
      amount_unit: 'major',
      include_source_transaction_id: true,
      include_mapping_rule_id: true,
      idempotency_header: 'Idempotency-Key'
    };
  }

  if (adapterName === 'zoho-books') {
    return {
      organization_id_env: 'ZOHO_ORGANIZATION_ID',
      client_id_env: 'ZOHO_CLIENT_ID',
      journal_status: 'draft',
      batch_size: 100,
      account_map_env: 'ZOHO_ACCOUNT_MAP_JSON'
    };
  }

  return {};
}

function readMappingRows(formData: FormData, mapId: string): AdapterMappingRow[] {
  const rows: Record<string, Partial<AdapterMappingRow>> = {};
  for (const [key, value] of formData.entries()) {
    const parts = key.split(':');
    if (parts[0] !== 'map' || parts[1] !== mapId || parts.length !== 4) continue;
    const [, , index, field] = parts;
    if (!index || !field) continue;
    rows[index] = {
      ...rows[index],
      [field]: field === 'required' ? true : String(value)
    };
  }

  return Object.values(rows)
    .map((row) => ({
      sourcePath: row.sourcePath ?? '',
      canonicalField: row.canonicalField ?? '',
      transform: row.transform ?? 'copy',
      defaultValue: row.defaultValue ?? '',
      required: Boolean(row.required)
    }))
    .filter((row) => row.sourcePath && row.canonicalField);
}

function mappingRowsToObject(rows: AdapterMappingRow[]) {
  return rows.reduce<Record<string, string>>((current, row) => {
    current[row.canonicalField] = row.sourcePath;
    return current;
  }, {});
}

function readFieldValues(formData: FormData) {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith('field:')) {
      values[key.slice('field:'.length)] = String(value);
    }
  }
  return values;
}

function updateMappingRow(
  setRows: (updater: (current: AdapterMappingRow[]) => AdapterMappingRow[]) => void,
  index: number,
  patch: Partial<AdapterMappingRow>
) {
  setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
}

function detectSourceFields(sample: string, csvMode: boolean) {
  if (csvMode) {
    const firstLine = sample.trim().split(/\r?\n/)[0] ?? '';
    return firstLine.split(',').map((field) => field.trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(sample);
    return flattenObjectKeys(parsed);
  } catch {
    return [];
  }
}

function applyDetectedFields(rows: AdapterMappingRow[], sourceFields: string[]) {
  return rows.map((row) => ({
    ...row,
    sourcePath: sourceSuggestionForCanonical(row.canonicalField, sourceFields) ?? row.sourcePath
  }));
}

function sourceSuggestionForCanonical(canonicalField: string, sourceFields: string[]) {
  const normalized = new Map(sourceFields.map((field) => [normalizeFieldName(field), field]));
  const preferred = sourceFieldSuggestions[canonicalField] ?? [canonicalField];
  return preferred.map((field) => normalized.get(normalizeFieldName(field))).find(Boolean);
}

function flattenObjectKeys(input: unknown, prefix = ''): string[] {
  if (!isRecord(input)) return [];
  return Object.entries(input).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return isRecord(value) ? [path, ...flattenObjectKeys(value, path)] : [path];
  });
}

function normalizeFieldName(value: string) {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function defaultTransformForField(canonicalField: string) {
  if (canonicalField.endsWith('_at') || canonicalField === 'occurred_at' || canonicalField === 'settled_at') return 'parse_datetime';
  if (canonicalField === 'amount') return 'amount_to_minor';
  if (canonicalField === 'status') return 'enum_map';
  return 'copy';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

const requiredCanonicalFields = new Set([
  'source_id',
  'occurred_at',
  'status',
  'amount',
  'currency',
  'type',
  'direction',
  'product.line'
]);

const sourceFieldSuggestions: Record<string, string[]> = {
  source_id: ['reference', 'source_id', 'txn_ref', 'id'],
  occurred_at: ['occurred_at', 'transaction_date', 'paid_at', 'created_at'],
  settled_at: ['settled_at', 'settled_date'],
  status: ['status', 'state'],
  amount: ['amount', 'value'],
  currency: ['currency'],
  type: ['type', 'transaction_type', 'service'],
  direction: ['direction'],
  channel: ['channel'],
  'product.line': ['product_line', 'product', 'service'],
  'product.biller': ['biller'],
  'product.biller_category': ['biller_category', 'category'],
  'principal.reference': ['principal_reference', 'customer_phone', 'customer_reference'],
  'principal.id': ['principal_id', 'customer_id', 'customer'],
  'principal.type': ['principal_type']
};

function AdapterGlyph({ adapterName, direction }: { adapterName: string; direction: AdapterRecord['direction'] }) {
  if (adapterName.includes('csv')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h8" />
      </svg>
    );
  }

  if (adapterName.includes('webhook')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 8h10" />
        <path d="M7 16h10" />
        <path d="M4 12h16" />
        <path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
      </svg>
    );
  }

  if (adapterName.includes('poll')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.5a11 11 0 0 1 14 0" />
        <path d="M2 9a16 16 0 0 1 20 0" />
        <path d="M8.5 16a6 6 0 0 1 7 0" />
        <path d="M12 20h.01" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {direction === 'outbound' ? (
        <>
          <path d="M4 12h14" />
          <path d="M13 7l5 5-5 5" />
          <path d="M4 5h8" />
          <path d="M4 19h8" />
        </>
      ) : (
        <>
          <path d="M20 12H6" />
          <path d="M11 7l-5 5 5 5" />
          <path d="M12 5h8" />
          <path d="M12 19h8" />
        </>
      )}
    </svg>
  );
}

function SettingsTabIcon({ tab }: { tab: SettingsTab }) {
  if (tab === 'schema') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 2.5h6l2 2v9H4z" />
        <path d="M10 2.5v2h2" />
        <path d="M6.5 7h3" />
        <path d="M6.5 9.5h3" />
        <path d="M6.5 12h2" />
      </svg>
    );
  }

  if (tab === 'adapters') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="1" y="4" width="14" height="8" rx="1.5" />
        <path d="M5 4v8" />
        <circle cx="9" cy="8" r="1" />
        <path d="M12 8h1" />
      </svg>
    );
  }

  if (tab === 'coa') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
        <path d="M5 5.5h6" />
        <path d="M5 8h6" />
        <path d="M5 10.5h4" />
      </svg>
    );
  }

  if (tab === 'users') {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="8" cy="5.5" r="2.5" />
        <path d="M2 13.5c0-2.76 2.69-5 6-5s6 2.24 6 5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8A5.5 5.5 0 1 1 2 8" />
      <path d="M13.5 8V5" />
      <path d="M13.5 8h-3" />
    </svg>
  );
}

function labelizeTab(tab: SettingsTab) {
  return `${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
}

function labelizeText(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function DetailField({
  label,
  value,
  mono = false,
  strong = false
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="df">
      <label>{label}</label>
      <span className={mono ? 'mono' : ''} style={strong ? { fontWeight: 700 } : undefined}>{value}</span>
    </div>
  );
}

function StatCell({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="stat-cell">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      <div className={`stat-sub ${tone === 'ok' ? 'ok' : ''}`}>{sub}</div>
    </div>
  );
}

function Placeholder({ title, subtitle, embedded = false }: { title: string; subtitle: string; embedded?: boolean }) {
  return (
    <section className={embedded ? '' : 'screen active'}>
      <div className={embedded ? '' : 'page-header'}>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
    </section>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onClose, 2600);
    return () => window.clearTimeout(timeout);
  }, [onClose]);

  return <div id="toast" className="show">{message}</div>;
}

function accountChip(code: string, accounts: ChartAccount[]) {
  const account = accounts.find((item) => item.code === code);
  return <span className={`chip ${accountTypeClass(account?.type)}`}>{code}</span>;
}

function accountTypeChip(type: AccountType) {
  return <span className={`chip ${accountTypeClass(type)}`}>{type}</span>;
}

function accountTypeClass(type?: AccountType) {
  if (type === 'liability') return 'liability';
  if (type === 'expense') return 'expense';
  if (type === 'revenue' || type === 'equity') return 'income';
  return 'asset';
}

function journalSideChips(entry: JournalEntry, side: JournalLine['side'], accounts: ChartAccount[]) {
  const lines = entry.lines.filter((line) => line.side === side);
  if (lines.length === 0) return <span className="dim">-</span>;

  return (
    <div className="chip-stack">
      {lines.map((line) => (
        <span key={`${entry.id}-${side}-${line.line_order}`}>
          {accountChip(line.account_code, accounts)}
          {lines.length > 1 ? (
            <span className="dim" style={{ fontSize: 11 }}> {formatMoney(line.amount, line.currency)}</span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function formatBps(value: number) {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

function formatMoney(amount: number, currency: string) {
  return `${currency} ${(amount / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function postingBadgeClass(status: PostingDisplayStatus) {
  if (status === 'posted') return 'posted';
  if (status === 'failed') return 'failed';
  if (status === 'unmapped') return 'unmapped';
  if (status === 'retry_exhausted') return 'retry-exhausted';
  if (status === 'blocked') return 'test-env';
  return 'pending';
}

function transactionStatusClass(status: TransactionRecord['status']) {
  if (status === 'settled') return 'settled';
  if (status === 'failed') return 'failed';
  if (status === 'reversed') return 'reversed';
  if (status === 'disputed') return 'disputed';
  return 'pending';
}

function transactionJournalStatus(
  transaction: TransactionRecord,
  journalEntries: JournalEntry[]
): PostingDisplayStatus {
  if (transaction.source.environment === 'test') return 'blocked';
  if (transaction.status !== 'settled' && transaction.status !== 'reversed') return 'unposted';

  const journalEntry = journalEntries.find((entry) => entry.transaction_id === transaction.id);
  return journalEntry?.posting_status ?? 'unposted';
}

function transactionWithinDateRange(transaction: TransactionRecord, from: string, to: string) {
  const occurred = transaction.occurred_at.slice(0, 10);
  if (from && occurred < from) return false;
  if (to && occurred > to) return false;
  return true;
}

function formatStatusLabel(status: string) {
  return status.replace('_', ' ');
}

function journalTimeline(entry: JournalEntry) {
  const attempts = entry.attempts.map((attempt) => ({
    ok: ['posted', 'retry_requested', 'queued', 'posting'].includes(attempt.status),
    event:
      attempt.status === 'retry_requested'
        ? `Retry ${attempt.attempt_number} requested via ${attempt.adapter_name}`
        : attempt.status === 'failed'
          ? `Attempt ${attempt.attempt_number} failed${attempt.error_message ? ` - ${attempt.error_message}` : ''}`
          : `Attempt ${attempt.attempt_number} ${attempt.status}`,
    time: attempt.occurred_at
  }));

  return [
    ...attempts,
    {
      ok: entry.posting_status !== 'failed' && entry.posting_status !== 'retry_exhausted',
      event:
        entry.posting_status === 'unmapped'
          ? 'No matching rule - parked in suspense'
          : entry.posting_status === 'posted'
            ? 'Posted to accounting system'
            : 'Journal entry generated',
      time: entry.posted_at ?? entry.generated_at
    },
    {
      ok: true,
      event: entry.mapping_rule_id ? `Mapping rule resolved - ${shortId(entry.mapping_rule_id)}` : 'No mapping rule applied',
      time: entry.generated_at
    }
  ];
}

async function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: 'GET' });
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function apiRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const payload = await response.json();

  if (!response.ok) {
    const message = Array.isArray(payload.errors)
      ? payload.errors.join(', ')
      : payload.message ?? 'API request failed';
    throw new Error(message);
  }

  return payload as T;
}
