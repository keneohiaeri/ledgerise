import { type ChangeEvent, FormEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';

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
  subCategory?: string;
  currency: string;
  parentCode?: string;
  active: boolean;
}

interface CreditSplit {
  accountCode: string;
  percentageBps: number;
}

interface JournalEntryTemplate {
  label?: string;
  debitAccountCode: string;
  creditSplits: CreditSplit[];
}

interface MappingRule {
  id: string;
  productLine: string;
  biller?: string;
  billerCategory?: string;
  transactionType?: string;
  ruleType: 'simple' | 'compound';
  entries: JournalEntryTemplate[];
  status: 'active' | 'inactive';
  version: number;
}

interface EntryFormState {
  label: string;
  debitAccountCode: string;
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
  entry_order: number;
  entry_label?: string;
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

interface PollCursorRecord {
  adapter_name: string;
  cursor: Record<string, unknown>;
  advanced_at: string;
  updated_at: string;
}

interface PollRunRecord {
  id: string;
  adapter_name: string;
  status: 'running' | 'succeeded' | 'failed';
  previous_cursor: Record<string, unknown>;
  next_cursor?: Record<string, unknown>;
  records_fetched: number;
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  error_message?: string;
  started_at: string;
  finished_at?: string;
}

interface PollStatusRecord {
  adapter_name: string;
  cursor: PollCursorRecord | null;
  runs: PollRunRecord[];
  page: PageInfo;
}

type UserRole = 'admin' | 'finance' | 'auditor';
type UserStatus = 'invited' | 'active' | 'disabled';

interface AuthUser {
  id: string;
  email: string;
  display_name?: string;
  role: UserRole;
  status: UserStatus;
}

interface AuthResponse {
  token: string;
  expires_in_seconds: number;
  user: AuthUser;
}

interface UserRecord {
  id: string;
  email: string;
  display_name?: string;
  role: UserRole;
  status: UserStatus;
  has_password?: boolean;
  invited_at?: string;
  last_login_at?: string;
}

type ApiScope =
  | 'posting_batches:create'
  | 'posting_batches:read'
  | 'posting_artifacts:download';

interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiScope[];
  enabled: boolean;
  expires_at?: string;
  last_used_at?: string;
  revoked_at?: string;
  created_at: string;
}

interface SystemSettings {
  engineCronSchedule: string;
  batchSize: number;
  suspenseAccountCode: string;
  maxRetryAttempts: number;
  backoffStrategy: 'exponential' | 'fixed';
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
  ruleType: 'simple' | 'compound';
  entries: EntryFormState[];
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const authTokenStorageKey = 'ledgerise.authToken';
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
const transformOptions = ['none', 'copy', 'parse_datetime', 'amount_to_minor', 'enum_map', 'lowercase', 'uppercase', 'mask_phone'];

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
          { label: 'Endpoint URL', type: 'text', value: 'https://api.example.com/transactions', hint: 'Ledgerise fetches this URL on the configured schedule.', key: 'url' },
          { label: 'Auth Header', type: 'text', value: 'Authorization', hint: 'Header used for API authentication.' },
          { label: 'API Token', type: 'password', hint: 'Stored securely and redacted from logs.' },
          { label: 'Records Path', type: 'text', value: 'data.transactions', hint: 'JSON path containing source records.', key: 'records_path' },
          { label: 'Next Page Path', type: 'text', value: 'data.next_page_token', hint: 'Optional JSON path containing the next page token.', key: 'next_page_response_path' },
          { label: 'Page Query Param', type: 'text', value: 'page_token', hint: 'Optional query parameter used to request the next page.', key: 'page_query_param' },
          { label: 'Max Pages Per Run', type: 'number', value: '10', hint: 'Safety cap for paginated source responses.', key: 'max_pages' }
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
          { label: 'Sync Position Field', type: 'text', value: 'updated_at', hint: 'Field used to remember where the next successful poll should resume.', key: 'next_cursor_record_path' }
        ]
      },
      {
        title: 'Field Mapping',
        desc: 'Map each API result object to canonical fields. The saved sync position only advances after these records validate.',
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
  ruleType: 'simple',
  entries: [{ label: '', debitAccountCode: '', creditSplits: [{ accountCode: '', percentageBps: 10000 }] }]
};

export function App() {
  const [screen, setScreen] = useState<Screen>('transactions');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('coa');
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [pollStatuses, setPollStatuses] = useState<Record<string, PollStatusRecord>>({});
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [newApiKeySecret, setNewApiKeySecret] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
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
  const [journalDateFrom, setJournalDateFrom] = useState('');
  const [journalDateTo, setJournalDateTo] = useState('');
  const [selectedJournal, setSelectedJournal] = useState<JournalEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(authTokenStorageKey) ?? '');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(Boolean(authToken));
  const [authError, setAuthError] = useState('');
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(emptyRuleForm);
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const transactionImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!authToken) {
      setAuthChecking(false);
      return;
    }

    let cancelled = false;
    setAuthChecking(true);
    apiGet<{ user: AuthUser }>('/api/auth/me')
      .then((response) => {
        if (cancelled) return;
        setAuthUser(response.user);
        setAuthError('');
        if (response.user.status === 'invited') {
          setMustChangePassword(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        clearAuthSession();
        setAuthError('Your session has expired. Sign in again.');
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (!authToken || authChecking || !authUser) return;
    void refreshOperationalData();
  }, [authToken, authChecking, authUser, journalFilter, transactionOffset]);

  const activeRules = rules.filter((rule) => rule.status === 'active');
  const inactiveRules = rules.filter((rule) => rule.status === 'inactive');
  const productLineCount = new Set(rules.map((rule) => rule.productLine)).size;

  const entryCreditTotals = useMemo(
    () => ruleForm.entries.map((entry) =>
      entry.creditSplits.reduce((sum, split) => sum + Number(split.percentageBps || 0), 0)
    ),
    [ruleForm.entries]
  );

  const fieldSuggestions = useMemo(() => {
    const productLines = new Set<string>();
    const billers = new Set<string>();
    const billerCategories = new Set<string>();
    const transactionTypes = new Set<string>();
    for (const t of transactions) {
      if (t.product.line) productLines.add(t.product.line);
      if (t.product.biller) billers.add(t.product.biller);
      if (t.product.biller_category) billerCategories.add(t.product.biller_category);
      if (t.type) transactionTypes.add(t.type);
    }
    for (const r of rules) {
      if (r.productLine) productLines.add(r.productLine);
      if (r.biller) billers.add(r.biller);
      if (r.billerCategory) billerCategories.add(r.billerCategory);
      if (r.transactionType) transactionTypes.add(r.transactionType);
    }
    return {
      productLines: [...productLines].sort(),
      billers: [...billers].sort(),
      billerCategories: [...billerCategories].sort(),
      transactionTypes: [...transactionTypes].sort(),
    };
  }, [transactions, rules]);

  function clearAuthSession() {
    localStorage.removeItem(authTokenStorageKey);
    setAuthToken('');
    setAuthUser(null);
    setAccounts([]);
    setAdapters([]);
    setRules([]);
    setTransactions([]);
    setJournalEntries([]);
    setUsers([]);
    setApiKeys([]);
  }

  async function login(input: { email: string; password: string }) {
    setAuthError('');
    const response = await apiPost<AuthResponse>('/api/auth/login', input);
    localStorage.setItem(authTokenStorageKey, response.token);
    setAuthToken(response.token);
    setAuthUser(response.user);
    if (response.user.status === 'invited') {
      setMustChangePassword(true);
    } else {
      setNotice(`Signed in as ${response.user.email}`);
    }
  }

  async function changePassword(newPassword: string) {
    if (!authUser) return;
    const response = await apiPost<{ token: string; user: AuthUser }>('/api/auth/change-password', {
      password: newPassword
    });
    localStorage.setItem(authTokenStorageKey, response.token);
    setAuthToken(response.token);
    setAuthUser(response.user);
    setMustChangePassword(false);
    setNotice(`Welcome, ${response.user.display_name ?? response.user.email}`);
  }

  async function logout() {
    try {
      await apiPost('/api/auth/logout', {});
    } catch {
      // Local token removal is enough for this stateless session.
    }
    clearAuthSession();
    setNotice('');
  }

  async function refreshOperationalData() {
    setLoading(true);
    setError('');

    try {
      const journalPath =
        journalFilter === 'all'
          ? '/api/journal-entries'
          : `/api/journal-entries?posting_status=${journalFilter}`;
      const transactionPath = `/api/transactions?limit=${transactionPageSize}&offset=${transactionOffset}`;
      const [
        coaResponse,
        adapterResponse,
        rulesResponse,
        transactionResponse,
        journalResponse,
        pollStatusResponse,
        usersResponse,
        apiKeysResponse,
        systemSettingsResponse
      ] = await Promise.all([
        apiGet<{ records: ChartAccount[] }>('/api/coa'),
        apiGet<{ records: AdapterRecord[] }>('/api/adapters'),
        apiGet<{ records: MappingRule[] }>('/api/mapping-rules'),
        apiGet<{ records: TransactionRecord[]; page: PageInfo }>(transactionPath),
        apiGet<{ records: JournalEntry[] }>(journalPath),
        apiGet<PollStatusRecord>('/api/adapters/generic-poll/poll-status?limit=3').catch(() => null),
        apiGet<{ records: UserRecord[] }>('/api/users').catch(() => ({ records: [] })),
        apiGet<{ records: ApiKeyRecord[] }>('/api/api-keys').catch(() => ({ records: [] })),
        apiGet<{ record: SystemSettings }>('/api/system-settings').catch(() => null)
      ]);
      setAccounts(coaResponse.records);
      setAdapters(adapterResponse.records);
      setPollStatuses(pollStatusResponse ? { [pollStatusResponse.adapter_name]: pollStatusResponse } : {});
      setRules(rulesResponse.records);
      setTransactions(transactionResponse.records);
      setTransactionPage(transactionResponse.page);
      setJournalEntries(journalResponse.records);
      setUsers(usersResponse.records);
      setApiKeys(apiKeysResponse.records);
      if (systemSettingsResponse) setSystemSettings(systemSettingsResponse.record);
    } catch (caught) {
      const code = caught instanceof Error ? (caught as Error & { code?: string }).code : undefined;
      if (code === 'MUST_CHANGE_PASSWORD') {
        setMustChangePassword(true);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Failed to load Ledgerise data');
    } finally {
      setLoading(false);
    }
  }

  async function toggleCoaAccount(code: string, active: boolean) {
    setError('');
    try {
      const result = await apiPatch<{ record: ChartAccount }>(`/api/coa/${encodeURIComponent(code)}`, { active });
      setAccounts((prev) => prev.map((a) => a.code === code ? result.record : a));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update account');
    }
  }

  async function deleteCoaAccount(code: string) {
    setError('');
    try {
      await apiRequest(`/api/coa/${encodeURIComponent(code)}`, { method: 'DELETE' });
      setAccounts((prev) => prev.filter((a) => a.code !== code));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to delete account');
    }
  }

  async function importCoaFromCsv(rows: CoaRow[]) {
    const result = await apiPost<{ records: ChartAccount[] }>('/api/coa/import', { accounts: rows });
    setAccounts((prev) => {
      const byCode = new Map(prev.map((a) => [a.code, a]));
      for (const a of result.records) byCode.set(a.code, a);
      return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    });
    setNotice(`Imported ${result.records.length} account${result.records.length !== 1 ? 's' : ''}`);
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    setError('');

    if (entryCreditTotals.some((total) => total !== 10000)) {
      setError('All entries must have credit splits summing to 100%.');
      return;
    }

    const payload = {
      product_line: ruleForm.productLine,
      biller: ruleForm.biller || undefined,
      biller_category: ruleForm.billerCategory || undefined,
      transaction_type: ruleForm.transactionType || undefined,
      rule_type: ruleForm.ruleType,
      entries: ruleForm.entries.map((entry) => ({
        label: entry.label || undefined,
        debit_account_code: entry.debitAccountCode,
        credit_splits: entry.creditSplits.map((split) => ({
          account_code: split.accountCode,
          percentage_bps: Number(split.percentageBps)
        }))
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
      const formData = new FormData();
      formData.append('file', file);
      const token = localStorage.getItem(authTokenStorageKey);
      const response = await fetch(`${apiBaseUrl}/api/import/generic-csv`, {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: formData
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 401) localStorage.removeItem(authTokenStorageKey);
        const message = typeof payload.message === 'string' ? payload.message : 'Failed to import CSV';
        throw new Error(message);
      }
      const result = payload as { imported: number; duplicates: number; row_errors?: unknown[] };
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
      ruleType: rule.ruleType,
      entries: rule.entries.length > 0
        ? rule.entries.map((e) => ({
            label: e.label ?? '',
            debitAccountCode: e.debitAccountCode,
            creditSplits: e.creditSplits.length > 0
              ? e.creditSplits
              : [{ accountCode: '', percentageBps: 10000 }]
          }))
        : [{ label: '', debitAccountCode: '', creditSplits: [{ accountCode: '', percentageBps: 10000 }] }]
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

  function updateSplit(entryIndex: number, splitIndex: number, patch: Partial<CreditSplit>) {
    setRuleForm((current) => ({
      ...current,
      entries: current.entries.map((entry, ei) =>
        ei !== entryIndex ? entry : {
          ...entry,
          creditSplits: entry.creditSplits.map((split, si) =>
            si === splitIndex ? { ...split, ...patch } : split
          )
        }
      )
    }));
  }

  function removeSplit(entryIndex: number, splitIndex: number) {
    setRuleForm((current) => ({
      ...current,
      entries: current.entries.map((entry, ei) =>
        ei !== entryIndex ? entry : {
          ...entry,
          creditSplits: entry.creditSplits.filter((_, si) => si !== splitIndex)
        }
      )
    }));
  }

  function addEntry() {
    setRuleForm((current) => ({
      ...current,
      entries: [...current.entries, { label: '', debitAccountCode: '', creditSplits: [{ accountCode: '', percentageBps: 10000 }] }]
    }));
  }

  function removeEntry(entryIndex: number) {
    setRuleForm((current) => ({
      ...current,
      entries: current.entries.filter((_, ei) => ei !== entryIndex)
    }));
  }

  async function runEngine() {
    setError('');
    try {
      const result = await apiPost<{ scanned: number; generated: number; skipped: number }>(
        '/api/engine/run', {}
      );
      setNotice(
        result.generated > 0
          ? `Engine run complete: ${result.generated} journal entr${result.generated !== 1 ? 'ies' : 'y'} generated from ${result.scanned} transaction${result.scanned !== 1 ? 's' : ''} scanned.`
          : `Engine run complete: ${result.scanned} transaction${result.scanned !== 1 ? 's' : ''} scanned, nothing new to generate.`
      );
      const journalPath =
        journalFilter === 'all'
          ? '/api/journal-entries'
          : `/api/journal-entries?posting_status=${journalFilter}`;
      const journalResponse = await apiGet<{ records: JournalEntry[] }>(journalPath);
      setJournalEntries(journalResponse.records);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Engine run failed');
    }
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

  async function inviteUser(input: { email: string; displayName?: string; role: UserRole; password?: string }) {
    const result = await apiPost<{ record: UserRecord }>('/api/users/invitations', {
      email: input.email,
      display_name: input.displayName,
      role: input.role,
      password: input.password
    });
    setUsers((current) => [result.record, ...current.filter((user) => user.id !== result.record.id)]);
    setNotice(`Invited ${result.record.email}`);
  }

  async function updateUser(user: UserRecord, patch: { role?: UserRole; status?: UserStatus }) {
    const result = await apiPatch<{ record: UserRecord }>(`/api/users/${encodeURIComponent(user.id)}`, patch);
    setUsers((current) => current.map((item) => (item.id === result.record.id ? result.record : item)));
    setNotice(`Updated ${result.record.email}`);
  }

  async function resetUserPassword(user: UserRecord) {
    const password = generatePassword();
    await apiPatch(`/api/users/${encodeURIComponent(user.id)}`, { password });
    setUsers((current) => current.map((item) => (item.id === user.id ? { ...item, has_password: true } : item)));
    setNewUserPassword(password);
    setNotice(`Password reset for ${user.email}`);
  }

  async function createApiKey(input: { name: string; scopes: ApiScope[] }) {
    const result = await apiPost<{ record: ApiKeyRecord; secret: string }>('/api/api-keys', input);
    setApiKeys((current) => [result.record, ...current]);
    setNewApiKeySecret(result.secret);
    setNotice(`Created API key ${result.record.name}`);
  }

  async function saveSystemSettings(patch: Partial<SystemSettings>) {
    const result = await apiPatch<{ record: SystemSettings }>('/api/system-settings', {
      engine_cron_schedule: patch.engineCronSchedule,
      batch_size: patch.batchSize,
      suspense_account_code: patch.suspenseAccountCode,
      max_retry_attempts: patch.maxRetryAttempts,
      backoff_strategy: patch.backoffStrategy
    });
    setSystemSettings(result.record);
    setNotice('System settings saved');
  }

  async function revokeApiKey(apiKey: ApiKeyRecord) {
    const result = await apiPost<{ record: ApiKeyRecord }>(
      `/api/api-keys/${encodeURIComponent(apiKey.id)}/revoke`,
      {}
    );
    setApiKeys((current) => current.map((item) => (item.id === result.record.id ? result.record : item)));
    setNotice(`Revoked API key ${result.record.name}`);
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

  if (authChecking && !authUser) {
    return <AuthLoading />;
  }

  if (!authToken || !authUser) {
    return <LoginView error={authError} onLogin={login} />;
  }

  if (mustChangePassword && authUser) {
    return <ChangePasswordView user={authUser} onChangePassword={changePassword} />;
  }

  return (
    <>
      <aside className="mobile-notice" aria-labelledby="mobile-notice-title">
        <img src="/ledgerise-logo.svg" alt="" aria-hidden="true" />
        <div>
          <p className="mobile-notice-kicker">Desktop workspace</p>
          <h1 id="mobile-notice-title">Open Ledgerise on a wider screen</h1>
          <p>
            This dashboard is optimized for desktop tables, drawers, and finance workflows. Reload it on a laptop or
            desktop browser for the intended experience.
          </p>
        </div>
      </aside>

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
        <div className="topnav-user">
          <span>{authUser.email}</span>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void logout()}>Sign Out</button>
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
            csvImportEnabled={adapters.find((a) => a.name === 'generic-csv')?.enabled ?? true}
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
            dateFrom={journalDateFrom}
            dateTo={journalDateTo}
            setDateFrom={setJournalDateFrom}
            setDateTo={setJournalDateTo}
            loading={loading}
            runEngine={runEngine}
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
            entryCreditTotals={entryCreditTotals}
            fieldSuggestions={fieldSuggestions}
            setRuleForm={setRuleForm}
            saveRule={saveRule}
            openNewRule={openNewRule}
            closeRuleDrawer={closeRuleDrawer}
            editRule={editRule}
            toggleRule={toggleRule}
            updateSplit={updateSplit}
            removeSplit={removeSplit}
            addEntry={addEntry}
            removeEntry={removeEntry}
          />
        ) : null}
        {screen === 'settings' ? (
          <SettingsView
            settingsTab={settingsTab}
            setSettingsTab={setSettingsTab}
            apiKeys={apiKeys}
            accounts={accounts}
            adapters={adapters}
            pollStatuses={pollStatuses}
            importCoaFromCsv={importCoaFromCsv}
            toggleCoaAccount={toggleCoaAccount}
            deleteCoaAccount={deleteCoaAccount}
            createApiKey={createApiKey}
            currentUserRole={authUser?.role ?? 'finance'}
            inviteUser={inviteUser}
            newApiKeySecret={newApiKeySecret}
            newUserPassword={newUserPassword}
            revokeApiKey={revokeApiKey}
            resetUserPassword={resetUserPassword}
            setNewApiKeySecret={setNewApiKeySecret}
            setNewUserPassword={setNewUserPassword}
            saveAdapterConfiguration={saveAdapterConfiguration}
            toggleAdapterConfiguration={toggleAdapterConfiguration}
            updateUser={updateUser}
            users={users}
            setNotice={setNotice}
            systemSettings={systemSettings}
            saveSystemSettings={saveSystemSettings}
          />
        ) : null}
      </main>
      </div>
    </>
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
  csvImportEnabled: boolean;
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
    csvImportEnabled,
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
          <button className="btn btn-primary" disabled={!csvImportEnabled} onClick={() => importInputRef.current?.click()}>
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
  const transactionEntries = journalEntries
    .filter((entry) => entry.transaction_id === transaction.id)
    .sort((a, b) => a.entry_order - b.entry_order);
  const journalEntry = transactionEntries[0] ?? null;
  const isCompound = transactionEntries.length > 1;
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
          <div className="drawer-section-title">{isCompound ? `Journal Entries (${transactionEntries.length})` : 'Journal Entry'}</div>
          {transactionEntries.length > 0 ? (
            isCompound ? (
              <div className="compound-journal-entries">
                {transactionEntries.map((entry) => (
                  <div key={entry.id} className="compound-journal-block">
                    <div className="compound-journal-block-header">
                      <span className="compound-entry-num">
                        Entry {entry.entry_order}{entry.entry_label ? ` — ${entry.entry_label}` : ''}
                      </span>
                      <span className={`badge ${postingBadgeClass(entry.posting_status)}`}>{formatStatusLabel(entry.posting_status)}</span>
                    </div>
                    <div className="drawer-grid">
                      <DetailField label="Journal ID" value={shortId(entry.id)} mono />
                      <DetailField label="Generated At" value={formatDateTime(entry.generated_at)} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="drawer-grid">
                <DetailField label="Journal ID" value={shortId(journalEntry!.id)} mono />
                <DetailField label="Posting Status" value={formatStatusLabel(journalEntry!.posting_status)} />
                <DetailField label="Entry Type" value={journalEntry!.entry_type} />
                <DetailField label="Generated At" value={formatDateTime(journalEntry!.generated_at)} />
                <DetailField
                  label="Rule Applied"
                  value={journalEntry!.mapping_rule_id ? `${shortId(journalEntry!.mapping_rule_id)} · v${journalEntry!.mapping_rule_version ?? 1}` : 'No rule matched - suspense'}
                  mono={Boolean(journalEntry!.mapping_rule_id)}
                />
              </div>
            )
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
  entryCreditTotals: number[];
  fieldSuggestions: { productLines: string[]; billers: string[]; billerCategories: string[]; transactionTypes: string[] };
  setRuleForm: (updater: RuleFormState | ((current: RuleFormState) => RuleFormState)) => void;
  saveRule: (event: FormEvent) => void;
  openNewRule: () => void;
  closeRuleDrawer: () => void;
  editRule: (rule: MappingRule) => void;
  toggleRule: (rule: MappingRule) => void;
  updateSplit: (entryIndex: number, splitIndex: number, patch: Partial<CreditSplit>) => void;
  removeSplit: (entryIndex: number, splitIndex: number) => void;
  addEntry: () => void;
  removeEntry: (entryIndex: number) => void;
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
    entryCreditTotals,
    fieldSuggestions,
    setRuleForm,
    saveRule,
    openNewRule,
    closeRuleDrawer,
    editRule,
    toggleRule,
    updateSplit,
    removeSplit,
    addEntry,
    removeEntry
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
                  <th>Entries</th>
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
                    <td>
                      {rule.ruleType === 'compound'
                        ? <span className="badge badge-compound">{rule.entries.length} entries</span>
                        : <span className="dim" style={{ fontSize: 11 }}>1</span>}
                    </td>
                    <td>
                      {rule.ruleType === 'compound' ? (
                        <div className="chip-stack">
                          {rule.entries.map((entry, i) => (
                            <span key={i}>
                              {accountChip(entry.debitAccountCode, accounts)}
                              {entry.label ? <span className="dim" style={{ fontSize: 11 }}> {entry.label}</span> : null}
                            </span>
                          ))}
                        </div>
                      ) : accountChip(rule.entries[0]?.debitAccountCode ?? '', accounts)}
                    </td>
                    <td>
                      <div className="chip-stack">
                        {rule.ruleType === 'compound'
                          ? rule.entries.flatMap((entry, ei) =>
                              entry.creditSplits.map((split) => (
                                <span key={`${ei}-${split.accountCode}`}>
                                  {accountChip(split.accountCode, accounts)}{' '}
                                  <span className="dim" style={{ fontSize: 11 }}>{formatBps(split.percentageBps)}</span>
                                </span>
                              ))
                            )
                          : (rule.entries[0]?.creditSplits ?? []).map((split) => (
                              <span key={`${rule.id}-${split.accountCode}`}>
                                {accountChip(split.accountCode, accounts)}{' '}
                                <span className="dim" style={{ fontSize: 11 }}>{formatBps(split.percentageBps)}</span>
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
                    <td colSpan={10} className="dim">No mapping rules yet. Create the first rule from Add Rule.</td>
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
          entryCreditTotals={entryCreditTotals}
          fieldSuggestions={fieldSuggestions}
          setRuleForm={setRuleForm}
          saveRule={saveRule}
          updateSplit={updateSplit}
          removeSplit={removeSplit}
          addEntry={addEntry}
          removeEntry={removeEntry}
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
  dateFrom: string;
  dateTo: string;
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
  loading: boolean;
  runEngine: () => void;
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
    dateFrom,
    dateTo,
    setDateFrom,
    setDateTo,
    loading,
    runEngine,
    retryJournalEntry,
    selectedJournal,
    selectJournal,
    closeJournalDrawer,
    setFilter
  } = props;
  const visibleEntries = entries.filter((entry) => {
    const date = (entry.transaction?.occurred_at ?? entry.generated_at).slice(0, 10);
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  });
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
          <button className="btn btn-primary" onClick={runEngine}>
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
          <input className="fi" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ width: 140 }} />
          <span style={{ color: 'var(--color-text-3)', fontSize: 'var(--text-sm)' }}>to</span>
          <input className="fi" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ width: 140 }} />
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
              : `${visibleEntries.length} entries${lastGeneratedAt ? ` · last generated ${formatDateTime(lastGeneratedAt)}` : ''}`}
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
              {visibleEntries.map((entry) => (
                <tr key={entry.id} onClick={() => selectJournal(entry)}>
                  <td className="mono">
                    {shortId(entry.id)}
                    {entry.entry_label ? <div className="entry-leg-label">{entry.entry_label}</div> : null}
                  </td>
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
              {visibleEntries.length === 0 ? (
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
  entryCreditTotals: number[];
  fieldSuggestions: { productLines: string[]; billers: string[]; billerCategories: string[]; transactionTypes: string[] };
  setRuleForm: (updater: RuleFormState | ((current: RuleFormState) => RuleFormState)) => void;
  saveRule: (event: FormEvent) => void;
  updateSplit: (entryIndex: number, splitIndex: number, patch: Partial<CreditSplit>) => void;
  removeSplit: (entryIndex: number, splitIndex: number) => void;
  addEntry: () => void;
  removeEntry: (entryIndex: number) => void;
  closeRuleDrawer: () => void;
}) {
  const { accounts, error, ruleForm, entryCreditTotals, fieldSuggestions, setRuleForm, saveRule, updateSplit, removeSplit, addEntry, removeEntry, closeRuleDrawer } = props;
  const canSave = Boolean(ruleForm.productLine) &&
    ruleForm.entries.length > 0 &&
    ruleForm.entries.every((e, i) => e.debitAccountCode && entryCreditTotals[i] === 10000);

  return (
    <form className="rule-drawer-form" onSubmit={saveRule}>
      <div className="drawer-body">
        {error ? <div className="form-error">{error}</div> : null}

        <div className="drawer-section rule-match-section">
          <ComboField label="Product Line" value={ruleForm.productLine} onChange={(value) => setRuleForm({ ...ruleForm, productLine: value })} suggestions={fieldSuggestions.productLines} />
          <div className="form-row">
            <ComboField label="Biller" value={ruleForm.biller} onChange={(value) => setRuleForm({ ...ruleForm, biller: value })} suggestions={fieldSuggestions.billers} />
            <ComboField label="Biller Category" value={ruleForm.billerCategory} onChange={(value) => setRuleForm({ ...ruleForm, billerCategory: value })} suggestions={fieldSuggestions.billerCategories} />
          </div>
          <ComboField label="Transaction Type Filter" value={ruleForm.transactionType} onChange={(value) => setRuleForm({ ...ruleForm, transactionType: value })} suggestions={fieldSuggestions.transactionTypes} />
        </div>

        <div className="drawer-section">
          <div className="form-section-label rule-section-label">Rule Type</div>
          <div className="rule-type-toggle">
            <label className="rule-type-option">
              <input type="radio" name="rule-type" value="simple" checked={ruleForm.ruleType === 'simple'}
                onChange={() => setRuleForm({ ...ruleForm, ruleType: 'simple', entries: ruleForm.entries.slice(0, 1) })} />
              <div className="rtype-label">Simple</div>
              <div className="rtype-desc">One journal entry per transaction</div>
            </label>
            <label className="rule-type-option">
              <input type="radio" name="rule-type" value="compound" checked={ruleForm.ruleType === 'compound'}
                onChange={() => setRuleForm({ ...ruleForm, ruleType: 'compound' })} />
              <div className="rtype-label">Compound</div>
              <div className="rtype-desc">Multiple journal entries from one transaction</div>
            </label>
          </div>
          {ruleForm.ruleType === 'compound' && (
            <div style={{ marginTop: 'var(--s2)', fontSize: 11, color: 'var(--color-text-3)', lineHeight: 1.5 }}>
              Use for multi-leg flows, e.g. wallet purchase through an aggregator generates separate debit, token, and settlement entries.
            </div>
          )}

          <div className="form-section-label rule-section-label" style={{ marginTop: 'var(--s5)' }}>
            {ruleForm.ruleType === 'compound' ? 'Journal Entries' : 'Account'}
          </div>

          <div className={ruleForm.ruleType === 'compound' ? 'compound-entries' : undefined}>
            {ruleForm.entries.map((entry, entryIndex) => (
              <div key={entryIndex} className={ruleForm.ruleType === 'compound' ? 'compound-entry' : undefined}>
                {ruleForm.ruleType === 'compound' && (
                  <div className="compound-entry-header">
                    <span className="compound-entry-num">Entry {entryIndex + 1}</span>
                    {ruleForm.entries.length > 1 && (
                      <button className="btn-link danger" type="button" onClick={() => removeEntry(entryIndex)}>Remove</button>
                    )}
                  </div>
                )}

                {ruleForm.ruleType === 'compound' && (
                  <div className="form-field">
                    <label>Label (optional)</label>
                    <input type="text" placeholder="e.g. Wallet debit" value={entry.label}
                      onChange={(event) => setRuleForm((cur) => ({
                        ...cur,
                        entries: cur.entries.map((e, i) => i === entryIndex ? { ...e, label: event.target.value } : e)
                      }))} />
                  </div>
                )}

                <div className="form-field">
                  <label>Debit Account</label>
                  <select value={entry.debitAccountCode}
                    onChange={(event) => setRuleForm((cur) => ({
                      ...cur,
                      entries: cur.entries.map((e, i) => i === entryIndex ? { ...e, debitAccountCode: event.target.value } : e)
                    }))}>
                    <option value="">Select account</option>
                    {accounts.map((account) => <option key={account.id} value={account.code}>{account.code} - {account.name}</option>)}
                  </select>
                </div>

                <div className="form-field">
                  <label>Credit Account(s)</label>
                  {entry.creditSplits.map((split, splitIndex) => (
                    <div className="credit-row" key={splitIndex}>
                      <select value={split.accountCode} onChange={(event) => updateSplit(entryIndex, splitIndex, { accountCode: event.target.value })}>
                        <option value="">Credit account</option>
                        {accounts.map((account) => <option key={account.id} value={account.code}>{account.code} - {account.name}</option>)}
                      </select>
                      <div className="percent-input">
                        <input
                          type="number" min="0.01" max="100" step="0.01"
                          value={split.percentageBps / 100}
                          onChange={(event) => updateSplit(entryIndex, splitIndex, { percentageBps: Math.round(Number(event.target.value) * 100) })}
                          aria-label="Credit split percentage"
                        />
                        <span>%</span>
                      </div>
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => removeSplit(entryIndex, splitIndex)} disabled={entry.creditSplits.length === 1}>Remove</button>
                    </div>
                  ))}
                  <button
                    className="btn btn-secondary btn-sm split-add-button"
                    type="button"
                    onClick={() => setRuleForm((cur) => ({
                      ...cur,
                      entries: cur.entries.map((e, i) => i === entryIndex ? { ...e, creditSplits: [...e.creditSplits, { accountCode: '', percentageBps: 0 }] } : e)
                    }))}
                  >Add split</button>
                  <div className={`split-total ${entryCreditTotals[entryIndex] === 10000 ? 'ok' : 'bad'}`}>
                    Total: {formatBps(entryCreditTotals[entryIndex] ?? 0)}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {ruleForm.ruleType === 'compound' && (
            <button className="btn btn-ghost btn-sm" type="button" style={{ marginTop: 'var(--s3)' }} onClick={addEntry}>
              + Add journal entry
            </button>
          )}
        </div>
      </div>

      <div className="drawer-footer">
        <button className="btn btn-ghost" type="button" onClick={closeRuleDrawer}>Cancel</button>
        <button className="btn btn-primary" type="submit" disabled={!canSave}>{ruleForm.id ? 'Save Changes' : 'Save Rule'}</button>
      </div>
    </form>
  );
}

function ChangePasswordView(props: {
  user: AuthUser;
  onChangePassword: (newPassword: string) => Promise<void>;
}) {
  const { user, onChangePassword } = props;
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onChangePassword(form.password);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <img src="/ledgerise-logo.svg" className="auth-logo" alt="" aria-hidden="true" />
          <span className="auth-wordmark">Ledgerise</span>
        </div>
        <h1 className="auth-heading">Set your password</h1>
        <p className="auth-change-desc">
          Welcome, {user.display_name ?? user.email}. Choose a new password to continue — your temporary credential will be replaced.
        </p>
        <form className="auth-form" onSubmit={submit}>
          <div className="form-field">
            <label>New password</label>
            <input
              required
              autoComplete="new-password"
              type="password"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label>Confirm password</label>
            <input
              required
              autoComplete="new-password"
              type="password"
              placeholder="Repeat your new password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
          </div>
          {error ? <div className="form-error">{error}</div> : null}
          <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set Password & Continue'}
          </button>
        </form>
      </section>
    </main>
  );
}

function AuthLoading() {
  return (
    <main className="auth-shell">
      <div className="auth-panel compact">
        <img src="/ledgerise-logo.svg" alt="" aria-hidden="true" />
        <div>
          <h1>Restoring session</h1>
          <p>Checking your Ledgerise access.</p>
        </div>
      </div>
    </main>
  );
}

function LoginView(props: {
  error: string;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
}) {
  const { error, onLogin } = props;
  const [form, setForm] = useState({ email: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setLocalError('');

    try {
      await onLogin(form);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <img src="/ledgerise-logo.svg" className="auth-logo" alt="" aria-hidden="true" />
          <span className="auth-wordmark">Ledgerise</span>
        </div>
        <h1 className="auth-heading">Sign in</h1>
        <form className="auth-form" onSubmit={submitLogin}>
          <div className="form-field">
            <label>Email address</label>
            <input
              required
              autoComplete="email"
              type="email"
              placeholder="you@company.com"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </div>
          <div className="form-field">
            <label>Password</label>
            <input
              required
              autoComplete="current-password"
              type="password"
              placeholder="••••••••"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </div>
          {localError || error ? <div className="form-error">{localError || error}</div> : null}
          <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </section>
    </main>
  );
}

function SettingsView(props: {
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  apiKeys: ApiKeyRecord[];
  accounts: ChartAccount[];
  adapters: AdapterRecord[];
  pollStatuses: Record<string, PollStatusRecord>;
  importCoaFromCsv: (rows: CoaRow[]) => Promise<void>;
  toggleCoaAccount: (code: string, active: boolean) => Promise<void>;
  deleteCoaAccount: (code: string) => Promise<void>;
  createApiKey: (input: { name: string; scopes: ApiScope[] }) => Promise<void>;
  currentUserRole: UserRole;
  inviteUser: (input: { email: string; displayName?: string; role: UserRole; password?: string }) => Promise<void>;
  newApiKeySecret: string;
  newUserPassword: string;
  revokeApiKey: (apiKey: ApiKeyRecord) => Promise<void>;
  resetUserPassword: (user: UserRecord) => Promise<void>;
  setNewApiKeySecret: (secret: string) => void;
  setNewUserPassword: (password: string) => void;
  saveAdapterConfiguration: (adapter: AdapterRecord, config: unknown) => Promise<void>;
  toggleAdapterConfiguration: (adapter: AdapterRecord, enabled: boolean) => Promise<void>;
  updateUser: (user: UserRecord, patch: { role?: UserRole; status?: UserStatus }) => Promise<void>;
  users: UserRecord[];
  setNotice: (notice: string) => void;
  systemSettings: SystemSettings | null;
  saveSystemSettings: (patch: Partial<SystemSettings>) => Promise<void>;
}) {
  const {
    settingsTab,
    setSettingsTab,
    apiKeys,
    accounts,
    adapters,
    pollStatuses,
    importCoaFromCsv,
    toggleCoaAccount,
    deleteCoaAccount,
    createApiKey,
    currentUserRole,
    inviteUser,
    newApiKeySecret,
    newUserPassword,
    revokeApiKey,
    resetUserPassword,
    setNewApiKeySecret,
    setNewUserPassword,
    saveAdapterConfiguration,
    toggleAdapterConfiguration,
    updateUser,
    users,
    setNotice: _setNotice,
    systemSettings,
    saveSystemSettings
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
            <CsvCoaImportPanel accounts={accounts} onImport={importCoaFromCsv} onDeactivate={toggleCoaAccount} onDelete={deleteCoaAccount} />
          ) : settingsTab === 'adapters' ? (
            <AdapterSettingsPanel
              adapters={adapters}
              pollStatuses={pollStatuses}
              onCloseDrawer={() => setSelectedAdapterName(null)}
              onConfigure={(adapter) => setSelectedAdapterName(adapter.name)}
              onSave={async (adapter, config) => {
                await saveAdapterConfiguration(adapter, config);
                setSelectedAdapterName(null);
              }}
              onToggleAdapter={(adapter, enabled) => void toggleAdapterConfiguration(adapter, enabled)}
              selectedAdapter={selectedAdapter}
            />
          ) : settingsTab === 'users' ? (
            <UsersSettingsPanel
              apiKeys={apiKeys}
              createApiKey={createApiKey}
              currentUserRole={currentUserRole}
              inviteUser={inviteUser}
              newApiKeySecret={newApiKeySecret}
              newUserPassword={newUserPassword}
              resetUserPassword={resetUserPassword}
              revokeApiKey={revokeApiKey}
              setNewApiKeySecret={setNewApiKeySecret}
              setNewUserPassword={setNewUserPassword}
              updateUser={updateUser}
              users={users}
            />
          ) : settingsTab === 'system' ? (
            <SystemSettingsPanel
              settings={systemSettings}
              onSave={saveSystemSettings}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function UsersSettingsPanel(props: {
  apiKeys: ApiKeyRecord[];
  createApiKey: (input: { name: string; scopes: ApiScope[] }) => Promise<void>;
  currentUserRole: UserRole;
  inviteUser: (input: { email: string; displayName?: string; role: UserRole; password?: string }) => Promise<void>;
  newApiKeySecret: string;
  newUserPassword: string;
  resetUserPassword: (user: UserRecord) => Promise<void>;
  revokeApiKey: (apiKey: ApiKeyRecord) => Promise<void>;
  setNewApiKeySecret: (secret: string) => void;
  setNewUserPassword: (password: string) => void;
  updateUser: (user: UserRecord, patch: { role?: UserRole; status?: UserStatus }) => Promise<void>;
  users: UserRecord[];
}) {
  const {
    apiKeys,
    createApiKey,
    currentUserRole,
    inviteUser,
    newApiKeySecret,
    newUserPassword,
    resetUserPassword,
    revokeApiKey,
    setNewApiKeySecret,
    setNewUserPassword,
    updateUser,
    users
  } = props;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editUserOpen, setEditUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: '', displayName: '', role: 'finance' as UserRole });
  const [editUserForm, setEditUserForm] = useState({ role: 'finance' as UserRole, status: 'active' as UserStatus });
  const [apiKeyForm, setApiKeyForm] = useState({ name: '', scopes: ['posting_batches:create', 'posting_batches:read'] as ApiScope[] });
  const [copiedId, setCopiedId] = useState('');

  function openEditUser(user: UserRecord) {
    setEditingUser(user);
    setEditUserForm({ role: user.role, status: user.status });
    setEditUserOpen(true);
  }

  async function downloadAuditLog() {
    const token = localStorage.getItem(authTokenStorageKey);
    const res = await fetch(`${apiBaseUrl}/api/audit-log.csv`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyText(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 2000);
  }

  async function submitInvite(event: FormEvent) {
    event.preventDefault();
    const password = generatePassword();
    await inviteUser({ email: inviteForm.email, displayName: inviteForm.displayName || undefined, role: inviteForm.role, password });
    setNewUserPassword(password);
    setInviteForm({ email: '', displayName: '', role: 'finance' });
    setInviteOpen(false);
  }

  async function submitEditUser(event: FormEvent) {
    event.preventDefault();
    if (!editingUser) return;
    await updateUser(editingUser, { role: editUserForm.role, status: editUserForm.status });
    setEditUserOpen(false);
    setEditingUser(null);
  }

  async function submitApiKey(event: FormEvent) {
    event.preventDefault();
    await createApiKey(apiKeyForm);
    setApiKeyForm({ name: '', scopes: ['posting_batches:create', 'posting_batches:read'] });
    setApiKeyOpen(false);
  }

  return (
    <div className="settings-panel active">
      {/* ── Users ── */}
      <div className="settings-panel-head">
        <div>
          <h2>Users</h2>
          <p className="panel-desc">Manage team access. A temporary credential is generated for each new user.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {currentUserRole === 'admin' ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void downloadAuditLog()}>Download Audit Log</button>
          ) : null}
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setInviteOpen(true)}>Add User</button>
        </div>
      </div>

      {newUserPassword ? (
        <div className="secret-once">
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>New user credential</strong>
            <p>Share this with the user — they will be prompted to change it on first sign-in.</p>
            <code>{newUserPassword}</code>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyText(newUserPassword, 'user-pw')}>
            {copiedId === 'user-pw' ? 'Copied!' : 'Copy'}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNewUserPassword('')}>Dismiss</button>
        </div>
      ) : null}

      <div className="table-card">
        <table className="tbl">
          <thead>
            <tr><th>User</th><th>Role</th><th>Status</th><th>Last Login</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={5} className="dim">No users found for this operator.</td></tr>
            ) : users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{user.display_name ?? user.email}</div>
                  {user.display_name ? <div className="dim" style={{ fontSize: 'var(--text-xs)', marginTop: 1 }}>{user.email}</div> : null}
                </td>
                <td><span className={`badge ${user.role}-role`}>{labelizeText(user.role)}</span></td>
                <td>
                  <span className={`badge ${user.status === 'disabled' ? 'failed' : user.status === 'invited' ? 'queued' : 'healthy'}`}>
                    {labelizeText(user.status)}
                  </span>
                  {!user.has_password ? <span className="badge queued" style={{ marginLeft: 4, fontSize: 10 }}>No password</span> : null}
                </td>
                <td className="dim">{user.last_login_at ? formatDateTime(user.last_login_at) : '—'}</td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button className="btn-link primary" type="button" onClick={() => openEditUser(user)}>Edit</button>
                    <button className="btn-link primary" type="button" onClick={() => void resetUserPassword(user)}>Reset password</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="role-desc-box">
        <p><strong>Admin:</strong> Full access to all sections and settings.</p>
        <p><strong>Finance:</strong> Full access to Transactions, Mapping Rules, and Journal Log. Read-only on Settings.</p>
        <p><strong>Auditor:</strong> Read-only access to Transactions and Journal Log. No access to Mapping Rules or Settings.</p>
      </div>

      {/* ── API Keys ── */}
      <div className="panel-section-divider" />
      <div className="settings-panel-head api-key-head">
        <div>
          <h3 className="panel-section-title">API Keys</h3>
          <p className="panel-desc">Machine credentials for external integrations — posting batches or downloading journal exports. Secrets are shown once at creation.</p>
        </div>
        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setApiKeyOpen(true)}>Generate Key</button>
      </div>

      {newApiKeySecret ? (
        <div className="secret-once">
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>New API key secret</strong>
            <p>Store this value now — Ledgerise will only show it once.</p>
            <code>{newApiKeySecret}</code>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => void copyText(newApiKeySecret, 'api-key')}>
            {copiedId === 'api-key' ? 'Copied!' : 'Copy'}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNewApiKeySecret('')}>Dismiss</button>
        </div>
      ) : null}

      <div className="table-card">
        <table className="tbl">
          <thead>
            <tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Status</th><th>Last Used</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {apiKeys.length === 0 ? (
              <tr><td colSpan={6} className="dim">No API keys created yet.</td></tr>
            ) : apiKeys.map((apiKey) => (
              <tr key={apiKey.id}>
                <td>{apiKey.name}</td>
                <td className="mono">{apiKey.key_prefix}…</td>
                <td>
                  <div className="scope-list">
                    {apiKey.scopes.map((scope) => <span className="type-tag" key={scope}>{scope}</span>)}
                  </div>
                </td>
                <td><span className={`badge ${apiKey.enabled ? 'healthy' : 'failed'}`}>{apiKey.enabled ? 'Active' : 'Revoked'}</span></td>
                <td className="dim">{apiKey.last_used_at ? formatDateTime(apiKey.last_used_at) : '—'}</td>
                <td>
                  {apiKey.enabled
                    ? <button className="btn-link danger" type="button" onClick={() => void revokeApiKey(apiKey)}>Revoke</button>
                    : <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Invite user drawer ── */}
      <div className={`drawer-overlay${inviteOpen ? ' open' : ''}`} onClick={() => setInviteOpen(false)} />
      <form className={`drawer${inviteOpen ? ' open' : ''}`} aria-hidden={!inviteOpen} onSubmit={submitInvite}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>Add User</h2>
            <div className="mono-id">A one-time credential will be generated on save</div>
          </div>
          <button className="drawer-close" type="button" onClick={() => setInviteOpen(false)} aria-label="Close drawer">×</button>
        </div>
        <div className="drawer-body">
          <div className="form-field">
            <label>Email <span className="field-req">*</span></label>
            <input required type="email" placeholder="colleague@example.com" value={inviteForm.email} onChange={(event) => setInviteForm({ ...inviteForm, email: event.target.value })} />
          </div>
          <div className="form-field">
            <label>Display Name</label>
            <input placeholder="Full name" value={inviteForm.displayName} onChange={(event) => setInviteForm({ ...inviteForm, displayName: event.target.value })} />
          </div>
          <div className="form-field">
            <label>Role <span className="field-req">*</span></label>
            <select value={inviteForm.role} onChange={(event) => setInviteForm({ ...inviteForm, role: event.target.value as UserRole })}>
              <option value="finance">Finance — full access except Settings (read-only)</option>
              <option value="auditor">Auditor — read-only on Transactions and Journal Log</option>
              <option value="admin">Admin — full access including Settings</option>
            </select>
            <div className="hint">Role can be changed later from the Users table.</div>
          </div>
          <div className="invite-note">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" style={{ flexShrink: 0, marginTop: 1 }}>
              <circle cx="8" cy="8" r="6" /><path d="M8 7v4" /><circle cx="8" cy="5" r=".5" fill="currentColor" stroke="none" />
            </svg>
            A secure password will be generated automatically. You'll see it once after saving — copy and share it with the user.
          </div>
        </div>
        <div className="drawer-footer">
          <button className="btn btn-ghost" type="button" onClick={() => setInviteOpen(false)}>Cancel</button>
          <button className="btn btn-primary" type="submit">Add User</button>
        </div>
      </form>

      {/* ── Edit user drawer ── */}
      <div className={`drawer-overlay${editUserOpen ? ' open' : ''}`} onClick={() => setEditUserOpen(false)} />
      <form className={`drawer${editUserOpen ? ' open' : ''}`} aria-hidden={!editUserOpen} onSubmit={submitEditUser}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>Edit User</h2>
            <div className="mono-id">{editingUser?.email}</div>
          </div>
          <button className="drawer-close" type="button" onClick={() => setEditUserOpen(false)} aria-label="Close drawer">×</button>
        </div>
        <div className="drawer-body">
          <div className="form-field">
            <label>Role</label>
            <select value={editUserForm.role} onChange={(event) => setEditUserForm({ ...editUserForm, role: event.target.value as UserRole })}>
              <option value="finance">Finance</option>
              <option value="auditor">Auditor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="form-field">
            <label>Status</label>
            <select value={editUserForm.status} onChange={(event) => setEditUserForm({ ...editUserForm, status: event.target.value as UserStatus })}>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        </div>
        <div className="drawer-footer">
          <button className="btn btn-ghost" type="button" onClick={() => setEditUserOpen(false)}>Cancel</button>
          <button className="btn btn-primary" type="submit">Save Changes</button>
        </div>
      </form>

      {/* ── API key drawer ── */}
      <div className={`drawer-overlay${apiKeyOpen ? ' open' : ''}`} onClick={() => setApiKeyOpen(false)} />
      <form className={`drawer${apiKeyOpen ? ' open' : ''}`} aria-hidden={!apiKeyOpen} onSubmit={submitApiKey}>
        <div className="drawer-header">
          <div className="drawer-hd">
            <h2>Generate API Key</h2>
            <div className="mono-id">Create a scoped machine credential</div>
          </div>
          <button className="drawer-close" type="button" onClick={() => setApiKeyOpen(false)} aria-label="Close drawer">×</button>
        </div>
        <div className="drawer-body">
          <div className="form-field">
            <label>Key Name <span className="field-req">*</span></label>
            <input required placeholder="e.g. erp-integration" value={apiKeyForm.name} onChange={(event) => setApiKeyForm({ ...apiKeyForm, name: event.target.value })} />
            <div className="hint">A descriptive name to identify this key's integration.</div>
          </div>
          <div className="form-field">
            <label>Scopes</label>
            <div className="scope-checks">
              {([
                { scope: 'posting_batches:create' as ApiScope, title: 'Create posting batches', desc: 'Submit journal entry batches for outbound posting.' },
                { scope: 'posting_batches:read' as ApiScope, title: 'Read posting batches', desc: 'List and inspect batch metadata and status.' },
                { scope: 'posting_artifacts:download' as ApiScope, title: 'Download artifacts', desc: 'Download generated journal CSV exports.' },
              ]).map(({ scope, title, desc }) => (
                <label key={scope} className="scope-check-row">
                  <input
                    type="checkbox"
                    checked={apiKeyForm.scopes.includes(scope)}
                    onChange={(event) =>
                      setApiKeyForm((current) => ({
                        ...current,
                        scopes: event.target.checked
                          ? [...current.scopes, scope]
                          : current.scopes.filter((item) => item !== scope)
                      }))
                    }
                  />
                  <div className="scope-check-text">
                    <div className="scope-check-title">{title}</div>
                    <div className="scope-check-desc">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="drawer-footer">
          <button className="btn btn-ghost" type="button" onClick={() => setApiKeyOpen(false)}>Cancel</button>
          <button className="btn btn-primary" type="submit">Generate Key</button>
        </div>
      </form>
    </div>
  );
}

type CoaRow = { code: string; name: string; type: AccountType; subCategory?: string; currency?: string };
type CoaParseResult = CoaRow | { error: string; raw: string };

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  fields.push(current.trim());
  return fields;
}

function normalizeCoaType(raw: string): AccountType | null {
  const t = raw.toLowerCase().trim();
  if (t === 'asset' || t === 'assets') return 'asset';
  if (t === 'liability' || t === 'liabilities') return 'liability';
  if (t === 'equity') return 'equity';
  if (t === 'income' || t === 'revenue') return 'revenue';
  if (t === 'expense' || t === 'expenses' || t === 'cost of sales' || t === 'cost_of_sales') return 'expense';
  return null;
}

function parseCoaCsv(text: string): CoaParseResult[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];

  const firstFields = parseCsvLine(lines[0] ?? '').map((f) => f.toLowerCase().trim());
  const hasHeader = firstFields.some((h) => h.includes('code') || h.includes('account') || h === 'type' || h === 'name' || h === 'class');

  let codeIdx = 0, nameIdx = 1, typeIdx = 2, subCatIdx = -1, currencyIdx = -1;
  const startIdx = hasHeader ? 1 : 0;

  if (hasHeader) {
    const ci = firstFields.findIndex((h) => h === 'account code' || h === 'code');
    const ni = firstFields.findIndex((h) => h === 'account name' || h === 'name');
    const ti = firstFields.findIndex((h) => h === 'class' || h === 'account type' || h === 'type');
    const si = firstFields.findIndex((h) => h === 'sub-category' || h === 'sub_category' || h === 'subcategory' || h === 'sub category' || h === 'category');
    const xi = firstFields.findIndex((h) => h === 'currency' || h === 'ccy');
    if (ci >= 0) codeIdx = ci;
    if (ni >= 0) nameIdx = ni;
    if (ti >= 0) typeIdx = ti;
    subCatIdx = si;
    currencyIdx = xi;
  }

  const results: CoaParseResult[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i] ?? '');
    const code = fields[codeIdx]?.trim() ?? '';
    const name = fields[nameIdx]?.trim() ?? '';
    const rawType = fields[typeIdx]?.trim() ?? '';
    if (!code || !name || !/^\d/.test(code)) continue;
    const type = normalizeCoaType(rawType);
    if (!type) { results.push({ error: `Unknown type "${rawType}"`, raw: lines[i] ?? '' }); continue; }
    const subCategory = subCatIdx >= 0 ? (fields[subCatIdx]?.trim() || undefined) : undefined;
    const currency = currencyIdx >= 0 ? (fields[currencyIdx]?.trim() || undefined) : undefined;
    results.push({ code, name, type, subCategory, currency });
  }
  return results;
}

const COA_SECTION_LABELS: Record<AccountType, string> = {
  asset:     '1 — Assets',
  liability: '2 — Liabilities',
  equity:    '3 — Equity',
  revenue:   '4 — Income (Revenue)',
  expense:   '5 — Cost of Sales / Expenses'
};
const COA_SECTION_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

const COA_CSV_TEMPLATE = [
  'Account Code,Account Name,Type,Sub-category,Currency',
  '100030,BNK — Globus Bank (Collection),Asset,Cash & Bank,NGN',
  '199999,Suspense / Clearing Account,Asset,Suspense,NGN',
  '200010,Payable — Biller Settlement Pool,Liability,Trade Payables,NGN',
  '410010,AirVend | MTN — Airtime & Data,Income,AirVend Revenue,NGN',
  '510210,COS | Aggregator Transaction Cost,Expense,Aggregator Costs,NGN'
].join('\r\n');

function downloadTemplate() {
  const blob = new Blob([COA_CSV_TEMPLATE], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'coa-import-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function CsvCoaImportPanel(props: {
  accounts: ChartAccount[];
  onImport: (rows: CoaRow[]) => Promise<void>;
  onDeactivate: (code: string, active: boolean) => Promise<void>;
  onDelete: (code: string) => Promise<void>;
}) {
  const { accounts, onImport, onDeactivate, onDelete } = props;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<{ ok: true; count: number } | { ok: false; message: string } | null>(null);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImportStatus(null);
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseCoaCsv(text);
      const valid = parsed.filter((r): r is CoaRow => 'code' in r);
      if (!valid.length) {
        setImportStatus({ ok: false, message: 'No valid accounts found in file. Check that the CSV has code, name, and type columns.' });
        return;
      }
      await onImport(valid);
      setImportStatus({ ok: true, count: valid.length });
    } catch (e) {
      setImportStatus({ ok: false, message: e instanceof Error ? e.message : 'Import failed' });
    } finally {
      setImporting(false);
    }
  }

  const grouped = COA_SECTION_ORDER.reduce<Record<AccountType, ChartAccount[]>>(
    (acc, type) => { acc[type] = accounts.filter((a) => a.type === type); return acc; },
    { asset: [], liability: [], equity: [], revenue: [], expense: [] }
  );

  return (
    <div className="settings-panel active">
      <h2>COA Reference</h2>
      <p className="panel-desc">Account codes from your chart of accounts used in mapping rules.</p>

      <div className="coa-import-strip">
        <div className="coa-import-strip-info">
          <div className="coa-import-strip-title">Import from CSV</div>
          <div className="coa-import-strip-desc">
            Upload a CSV with columns: Code, Account Name, Type. Accepts simple three-column format or a
            full export where Type is Asset / Liability / Equity / Income / Cost of Sales / Expense.
          </div>
        </div>
        <div className="coa-import-strip-actions">
          <button className="btn btn-secondary btn-sm" onClick={downloadTemplate}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2v8M5 7l3 3 3-3" /><path d="M2 12h12" />
            </svg>
            Template
          </button>
          <button className="btn btn-primary btn-sm" disabled={importing} onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 10V2M5 5l3-3 3 3" /><path d="M2 12h12" />
            </svg>
            {importing ? 'Importing…' : 'Import CSV'}
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
        </div>
      </div>

      {importStatus && (
        importStatus.ok
          ? <div className="notice" style={{ marginBottom: 'var(--s3)' }}>{importStatus.count} account{importStatus.count !== 1 ? 's' : ''} imported successfully.</div>
          : <div className="form-error" style={{ marginBottom: 'var(--s3)' }}>{importStatus.message}</div>
      )}

      <div className="table-card">
        <table className="tbl">
          <thead>
            <tr><th>Code</th><th>Account Name</th><th>Sub-category</th><th>Type</th><th>CCY</th><th>Status</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={7} className="dim">No accounts imported yet. Use Import CSV above to get started.</td></tr>
            )}
            {COA_SECTION_ORDER.flatMap((type) => {
              const rows = grouped[type];
              if (!rows.length) return [];
              return [
                <tr key={`hdr-${type}`}>
                  <td colSpan={7} style={{ background: 'var(--color-muted-bg)', fontWeight: 600, fontSize: 11, color: 'var(--color-text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    {COA_SECTION_LABELS[type]}
                  </td>
                </tr>,
                ...rows.map((account) => (
                  <tr key={account.id}>
                    <td className="mono">{account.code}</td>
                    <td>{account.name}</td>
                    <td className="dim">{account.subCategory ?? '—'}</td>
                    <td>{accountTypeChip(account.type)}</td>
                    <td className="mono dim" style={{ fontSize: 'var(--text-xs)' }}>{account.currency}</td>
                    <td><span className={`badge ${account.active ? 'active-rule' : 'failed'}`}>{account.active ? 'Active' : 'Inactive'}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn-link primary" onClick={() => void onDeactivate(account.code, !account.active)}>
                          {account.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button className="btn-link danger" onClick={() => void onDelete(account.code)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SystemSettingsPanel(props: {
  settings: SystemSettings | null;
  onSave: (patch: Partial<SystemSettings>) => Promise<void>;
}) {
  const { settings, onSave } = props;
  const defaults: SystemSettings = {
    engineCronSchedule: '0 * * * *',
    batchSize: 500,
    suspenseAccountCode: 'X9999',
    maxRetryAttempts: 5,
    backoffStrategy: 'exponential'
  };
  const initial = settings ?? defaults;
  const [form, setForm] = useState<SystemSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  function discard() {
    setForm(settings ?? defaults);
    setLocalError('');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setLocalError('');
    try {
      await onSave(form);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to save system settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-panel active">
      <h2>System</h2>
      <p className="panel-desc">Engine scheduling, batch processing, suspense account, and retry policy</p>
      <form onSubmit={submit}>
        <div className="config-section">
          <div className="config-section-title">Journal Engine</div>
          <div className="config-grid">
            <div className="form-field">
              <label>Engine Schedule (Cron)</label>
              <input
                type="text"
                value={form.engineCronSchedule}
                onChange={(e) => setForm({ ...form, engineCronSchedule: e.target.value })}
              />
              <div className="hint">Standard cron syntax. Current: runs {form.engineCronSchedule === '0 * * * *' ? 'every hour' : 'on schedule'}.</div>
            </div>
            <div className="form-field">
              <label>Batch Size</label>
              <input
                type="number"
                min="1"
                max="10000"
                value={form.batchSize}
                onChange={(e) => setForm({ ...form, batchSize: Math.max(1, Number(e.target.value)) })}
              />
              <div className="hint">Max transactions processed per engine run.</div>
            </div>
            <div className="form-field">
              <label>Suspense Account Code</label>
              <input
                type="text"
                value={form.suspenseAccountCode}
                onChange={(e) => setForm({ ...form, suspenseAccountCode: e.target.value })}
              />
              <div className="hint">COA code where unmapped transactions are parked.</div>
            </div>
          </div>
        </div>

        <div className="config-section">
          <div className="config-section-title">Retry Policy</div>
          <div className="config-grid">
            <div className="form-field">
              <label>Max Retry Attempts</label>
              <input
                type="number"
                min="0"
                max="20"
                value={form.maxRetryAttempts}
                onChange={(e) => setForm({ ...form, maxRetryAttempts: Math.max(0, Number(e.target.value)) })}
              />
              <div className="hint">After this, entry is marked retry_exhausted and held for manual review.</div>
            </div>
            <div className="form-field">
              <label>Backoff Strategy</label>
              <select
                value={form.backoffStrategy}
                onChange={(e) => setForm({ ...form, backoffStrategy: e.target.value as SystemSettings['backoffStrategy'] })}
              >
                <option value="exponential">Exponential (5m → 15m → 1h → 4h → 24h)</option>
                <option value="fixed">Fixed interval</option>
              </select>
            </div>
          </div>
        </div>

        {localError ? <div className="form-error">{localError}</div> : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--s2)' }}>
          <button className="btn btn-secondary" type="button" onClick={discard} disabled={saving}>Discard Changes</button>
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </div>
      </form>
    </div>
  );
}

function AdapterSettingsPanel(props: {
  adapters: AdapterRecord[];
  pollStatuses: Record<string, PollStatusRecord>;
  selectedAdapter: AdapterRecord | null;
  onConfigure: (adapter: AdapterRecord) => void;
  onCloseDrawer: () => void;
  onSave: (adapter: AdapterRecord, config: unknown) => Promise<void>;
  onToggleAdapter: (adapter: AdapterRecord, enabled: boolean) => void;
}) {
  const {
    adapters,
    pollStatuses,
    selectedAdapter,
    onConfigure,
    onCloseDrawer,
    onSave,
    onToggleAdapter
  } = props;
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

      <AdapterConfigDrawer
        adapter={selectedAdapter}
        onClose={onCloseDrawer}
        onSave={onSave}
        pollStatus={selectedAdapter ? pollStatuses[selectedAdapter.name] : undefined}
      />
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
    ['Poll', 'Ledgerise calls the source API on a schedule and remembers the last safely synced time or source ID.', 'generic-poll'],
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

function PollStatusSummary({ status }: { status?: PollStatusRecord }) {
  const latestRun = status?.runs[0];
  const cursorValue = readCursorValue(status?.cursor?.cursor);

  return (
    <div className="adapter-status-panel">
      <div className="adapter-status-metrics">
        <div className="adapter-status-cell">
          <span>Last run</span>
          <strong>{latestRun ? labelizeText(latestRun.status) : 'No runs yet'}</strong>
          {latestRun ? <small>{formatDateTime(latestRun.finished_at ?? latestRun.started_at)}</small> : <small>Waiting for first worker run</small>}
        </div>
        <div className="adapter-status-cell">
          <span>Records</span>
          <strong>{latestRun ? latestRun.records_fetched : '-'}</strong>
          <small>fetched from source</small>
        </div>
        <div className="adapter-status-cell">
          <span>Ingestion</span>
          <strong>
            {latestRun
              ? `${latestRun.accepted_count}/${latestRun.duplicate_count}/${latestRun.rejected_count}`
              : '-'}
          </strong>
          <small>accepted / duplicate / rejected</small>
        </div>
      </div>
      <div className="adapter-status-cursor">
        <span>Synced through</span>
        <strong className="mono">{cursorValue ?? '-'}</strong>
        {status?.cursor ? <small>{formatDateTime(status.cursor.advanced_at)}</small> : null}
      </div>
      {latestRun?.error_message ? (
        <div className="adapter-status-error">
          <span>Error</span>
          <strong>{latestRun.error_message}</strong>
        </div>
      ) : null}
    </div>
  );
}

function AdapterConfigDrawer(props: {
  adapter: AdapterRecord | null;
  onClose: () => void;
  onSave: (adapter: AdapterRecord, config: unknown) => Promise<void>;
  pollStatus?: PollStatusRecord;
}) {
  const { adapter, onClose, onSave, pollStatus } = props;
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
          {adapter?.modes.includes('poll') ? (
            <div className="drawer-section">
              <div className="drawer-section-title">Poll Status</div>
              <PollStatusSummary status={pollStatus} />
            </div>
          ) : null}
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
  const [previewOutput, setPreviewOutput] = useState<string | null>(null);
  const [detected, setDetected] = useState(false);
  const [mappingRows, setMappingRows] = useState(field.type === 'mapping' ? field.rows : []);
  const sampleRef = useRef<HTMLTextAreaElement | null>(null);

  const mappingId = field.type === 'mapping' ? field.id : '';

  useEffect(() => {
    if (field.type === 'mapping') {
      setMappingRows(field.rows);
      setDetected(false);
      setPreviewOutput(null);
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
          <span>Canonical field</span>
          <span>Transform</span>
          <span>Enum map / Default</span>
          <span />
        </div>
        <div className="field-map-body">
          {mappingRows.map((row, index) => (
            <div className="field-map-row" key={`${row.sourcePath}-${index}`}>
              <input
                type="text"
                name={`map:${mappingField.id}:${index}:sourcePath`}
                value={row.sourcePath}
                placeholder="CSV column name"
                onChange={(event) => updateMappingRow(setMappingRows, index, { sourcePath: event.target.value })}
              />
              <select
                name={`map:${mappingField.id}:${index}:canonicalField`}
                value={row.canonicalField}
                onChange={(event) => {
                  const canonicalField = event.target.value;
                  updateMappingRow(setMappingRows, index, {
                    canonicalField,
                    transform: defaultTransformForField(canonicalField)
                  });
                }}
              >
                {canonicalFieldOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
              <select
                name={`map:${mappingField.id}:${index}:transform`}
                value={row.transform}
                onChange={(event) => updateMappingRow(setMappingRows, index, { transform: event.target.value })}
              >
                {transformOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
              <input
                type="text"
                name={`map:${mappingField.id}:${index}:defaultValue`}
                value={row.defaultValue}
                placeholder={row.transform === 'enum_map' ? 'src=canonical, ...' : row.sourcePath ? '' : 'type a value...'}
                style={{ opacity: !row.sourcePath || row.transform === 'enum_map' ? 1 : 0.35 }}
                onChange={(event) => updateMappingRow(setMappingRows, index, { defaultValue: event.target.value })}
              />
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
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => {
            if (previewOutput !== null) { setPreviewOutput(null); return; }
            const sample = sampleRef.current?.value ?? mappingField.preview.source;
            setPreviewOutput(runPreviewMapping(sample, mappingRows, Boolean(mappingField.sourceLabel)));
          }}
        >
          {previewOutput !== null ? 'Hide preview' : 'Preview mapping'}
        </button>
      </div>
      <div className="field-map-note">Detected source fields are mapped onto Ledgerise canonical fields. Adapter defaults still handle normalization, validation, and required canonical structure.</div>
      {previewOutput !== null ? (
        <div className="field-map-preview">
          <div className="field-map-preview-title">Preview output (first data row)</div>
          <pre>{previewOutput}</pre>
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
        if (field.type !== 'mapping') {
          if ('key' in field && field.key && config[field.key] !== undefined) {
            return {
              ...field,
              value: String(config[field.key])
            };
          }

          return field;
        }

        if (adapter.name === 'generic-csv' && field.id === 'generic-csv-map') {
          return {
            ...field,
            rows: rowsFromMappingConfig(
              isRecord(config.column_mappings) ? config.column_mappings : undefined,
              field.rows,
              isRecord(config.defaults) ? config.defaults as Record<string, unknown> : undefined
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

        if (adapter.name === 'generic-poll' && field.id === 'generic-poll-map') {
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
  fallback: AdapterMappingRow[],
  defaults?: Record<string, unknown>
): AdapterMappingRow[] {
  const fallbackByCanonical = new Map(fallback.map((row) => [row.canonicalField, row]));
  const rows: AdapterMappingRow[] = mapping
    ? Object.entries(mapping)
        .filter(([, spec]) => {
          const col = spec !== null && typeof spec === 'object' && !Array.isArray(spec)
            ? (spec as Record<string, unknown>).column
            : spec;
          return typeof col === 'string' && String(col).trim().length > 0;
        })
        .map(([canonicalField, spec]) => {
          const isObj = spec !== null && typeof spec === 'object' && !Array.isArray(spec);
          const obj = isObj ? (spec as Record<string, unknown>) : null;
          const sourcePath = obj ? String(obj.column ?? '') : String(spec);
          const transform = obj ? String(obj.transform ?? 'copy') : 'copy';
          const enumMap = obj ? String(obj.enum_map ?? '') : '';
          const fallbackRow = fallbackByCanonical.get(canonicalField);
          return {
            sourcePath,
            canonicalField,
            transform: transform || fallbackRow?.transform || defaultTransformForField(canonicalField),
            defaultValue: enumMap || fallbackRow?.defaultValue || '',
            required: fallbackRow?.required ?? requiredCanonicalFields.has(canonicalField)
          };
        })
    : [...fallback];

  const mapped = new Set(rows.map((r) => r.canonicalField));

  for (const canonicalField of requiredCanonicalFields) {
    if (!mapped.has(canonicalField)) {
      const savedDefault = defaults?.[canonicalField];
      rows.push({
        sourcePath: '',
        canonicalField,
        transform: 'none',
        defaultValue: savedDefault === undefined ? '' : savedDefault === null ? 'null' : String(savedDefault),
        required: true
      });
      mapped.add(canonicalField);
    }
  }

  if (defaults) {
    for (const [canonicalField, value] of Object.entries(defaults)) {
      if (!mapped.has(canonicalField)) {
        rows.push({
          sourcePath: '',
          canonicalField,
          transform: 'copy',
          defaultValue: value === null ? 'null' : String(value),
          required: false
        });
      }
    }
  }

  return rows;
}

function buildAdapterOperationalConfig(adapter: AdapterRecord, formData: FormData): unknown {
  if (adapter.name === 'generic-csv') {
    const allRows = readMappingRows(formData, 'generic-csv-map');
    const columnRows = allRows.filter((row) => row.sourcePath.trim());
    const defaultRows = allRows.filter((row) => !row.sourcePath.trim() && row.defaultValue.trim());
    const defaults: Record<string, unknown> = {};
    for (const row of defaultRows) {
      defaults[row.canonicalField] = row.defaultValue === 'null' ? null : row.defaultValue;
    }
    return {
      ...defaultAdapterOperationalConfig(adapter.name),
      column_mappings: mappingRowsToObject(columnRows),
      ...(Object.keys(defaults).length > 0 ? { defaults } : {})
    };
  }

  if (adapter.name === 'generic-webhook') {
    return {
      ...defaultAdapterOperationalConfig(adapter.name),
      field_mappings: mappingRowsToObject(readMappingRows(formData, 'generic-webhook-map'))
    };
  }

  if (adapter.name === 'generic-poll') {
    const fields = readFieldValues(formData);
    const maxPages = Number(fields.max_pages ?? 10);
    return {
      ...defaultAdapterOperationalConfig(adapter.name),
      ...fields,
      max_pages: Number.isFinite(maxPages) && maxPages > 0 ? Math.floor(maxPages) : 10,
      field_mappings: mappingRowsToObject(readMappingRows(formData, 'generic-poll-map'))
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

  if (adapterName === 'generic-poll') {
    return {
      url: 'https://api.example.com/transactions',
      records_path: 'data.transactions',
      source_system: 'generic-api',
      environment: 'live',
      cursor_query_param: 'since',
      next_cursor_record_path: 'updated_at',
      page_query_param: 'page_token',
      next_page_response_path: 'data.next_page_token',
      max_pages: 10,
      field_mappings: {
        source_id: 'id',
        occurred_at: 'created_at',
        settled_at: 'settled_at',
        amount: 'amount',
        status: 'status',
        type: 'type',
        direction: 'direction',
        currency: 'currency',
        channel: 'channel',
        'principal.id': 'customer_id',
        'principal.type': 'principal_type',
        'principal.reference': 'customer_phone',
        'product.line': 'product_line',
        'product.biller': 'biller',
        'product.biller_category': 'biller_category'
      }
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
    .filter((row) => row.canonicalField && (row.sourcePath || row.defaultValue));
}

type CsvColumnSpec = string | { column: string; transform: string; enum_map?: string };

function mappingRowsToObject(rows: AdapterMappingRow[]): Record<string, CsvColumnSpec> {
  return rows.reduce<Record<string, CsvColumnSpec>>((current, row) => {
    if (row.transform && row.transform !== 'copy') {
      const spec: { column: string; transform: string; enum_map?: string } = {
        column: row.sourcePath,
        transform: row.transform
      };
      if (row.transform === 'enum_map' && row.defaultValue) spec.enum_map = row.defaultValue;
      current[row.canonicalField] = spec;
    } else {
      current[row.canonicalField] = row.sourcePath;
    }
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

function parsePreviewCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    const next = content[i + 1];
    if (ch === '"' && inQuotes && next === '"') { field += '"'; i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(field); field = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function runPreviewMapping(sample: string, rows: AdapterMappingRow[], csvMode: boolean): string {
  try {
    let sourceRow: Record<string, string> = {};

    if (csvMode) {
      const parsed = parsePreviewCsv(sample.trim());
      if (parsed.length < 2) return '(paste a sample with a header row and at least one data row)';
      const headers = parsed[0]!.map((h) => h.trim());
      const values = parsed[1]!.map((v) => v.trim());
      sourceRow = Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
    } else {
      const parsed = JSON.parse(sample) as unknown;
      const flat = (key: string, obj: unknown): [string, string][] => {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [[key, String(obj ?? '')]];
        return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => flat(`${key}.${k}`, v));
      };
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        sourceRow = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).flatMap(([k, v]) => flat(k, v))
        );
      }
    }

    const record: Record<string, unknown> = {};
    for (const row of rows) {
      if (!row.sourcePath || !row.canonicalField) continue;
      const value = sourceRow[row.sourcePath];
      if (value === undefined || value === '') continue;
      const transformed = applyPreviewTransform(value, row.transform, row.defaultValue);
      const parts = row.canonicalField.split('.');
      let current = record;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (typeof current[part] !== 'object' || current[part] === null) current[part] = {};
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]!] = transformed;
    }

    return JSON.stringify(record, null, 2);
  } catch {
    return '(preview error — check sample format)';
  }
}

function applyPreviewTransform(value: string, transform: string, enumMapStr: string): unknown {
  switch (transform) {
    case 'none':
      return value;
    case 'parse_datetime': {
      const t = value.trim();
      const excel = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(t);
      if (excel) {
        const year = excel[3]!.length === 2 ? `20${excel[3]}` : excel[3]!;
        return `${year}-${excel[1]!.padStart(2, '0')}-${excel[2]!.padStart(2, '0')}T${(excel[4] ?? '0').padStart(2, '0')}:${(excel[5] ?? '0').padStart(2, '0')}:00.000Z`;
      }
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00.000Z` : t;
    }
    case 'amount_to_minor': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n * 100) : value;
    }
    case 'enum_map': {
      const map: Record<string, string> = {};
      for (const pair of enumMapStr.split(',')) {
        const eq = pair.indexOf('=');
        if (eq !== -1) map[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
      }
      return map[value.trim().toLowerCase()] ?? map[value.trim()] ?? value;
    }
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'mask_phone': {
      const d = value.replace(/\D/g, '');
      return d.length < 7 ? value : d.slice(0, 3) + '*'.repeat(d.length - 6) + d.slice(-3);
    }
    default: {
      const n = Number(value);
      return value !== '' && Number.isFinite(n) ? n : value;
    }
  }
}

function applyDetectedFields(rows: AdapterMappingRow[], sourceFields: string[]) {
  return rows.map((row) => {
    const suggested = sourceSuggestionForCanonical(row.canonicalField, sourceFields);
    if (suggested) {
      return { ...row, sourcePath: suggested, transform: defaultTransformForField(row.canonicalField) };
    }
    // No match found — clear the source path so stale template values don't remain
    return { ...row, sourcePath: '' };
  });
}

function tokenizeField(field: string): string[] {
  return field.replace(/[._\-\s]+/g, ' ').toLowerCase().split(' ').filter((t) => t.length > 2);
}

function sourceSuggestionForCanonical(canonicalField: string, sourceFields: string[]) {
  const preferred = sourceFieldSuggestions[canonicalField] ?? [];
  const normalized = new Map(sourceFields.map((field) => [normalizeFieldName(field), field]));

  // 1. Curated exact matches first
  const exact = preferred.map((field) => normalized.get(normalizeFieldName(field))).find(Boolean);
  if (exact) return exact;

  // 2. Token-overlap fuzzy matching
  // Build a set of meaningful tokens from the canonical field name and its known synonyms
  const synonymTokens = new Set([...preferred, canonicalField].flatMap(tokenizeField));

  let bestMatch: string | undefined;
  let bestScore = 0;

  for (const sourceField of sourceFields) {
    const sourceTokens = tokenizeField(sourceField);
    if (sourceTokens.length === 0) continue;
    const overlap = sourceTokens.filter((t) => synonymTokens.has(t)).length;
    if (overlap === 0) continue;
    const score = overlap / sourceTokens.length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = sourceField;
    }
  }

  return bestMatch;
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
  source_id: [
    'reference', 'source_id', 'txn_ref', 'transaction_ref', 'transaction_id',
    'external_id', 'external_ref', 'payment_ref', 'payment_id', 'order_id',
    'order_ref', 'request_id', 'correlation_id', 'trace_id', 'tracking_id',
    'receipt_id', 'receipt_no', 'receipt_num', 'invoice_id', 'invoice_no',
    'booking_id', 'confirmation_no', 'confirmation_id', 'session_id',
    'trx_id', 'tran_id', 'trans_id', 'unique_ref', 'identifier'
  ],
  occurred_at: [
    'occurred_at', 'transaction_date', 'paid_at', 'created_at', 'created_on',
    'created_date', 'payment_date', 'payment_time', 'initiated_at',
    'processed_at', 'executed_at', 'event_time', 'event_date',
    'date_time', 'tran_date', 'txn_date', 'order_date', 'timestamp',
    'trans_date', 'activity_date', 'value_date', 'post_date'
  ],
  settled_at: [
    'settled_at', 'settled_date', 'settlement_date', 'settlement_time',
    'completed_at', 'cleared_at', 'finalized_at', 'resolved_at',
    'clearing_date', 'posting_date', 'fulfillment_date'
  ],
  status: [
    'status', 'state', 'status_code', 'response_code', 'result', 'outcome',
    'condition', 'transaction_status', 'payment_status', 'order_status',
    'resolution', 'response', 'code', 'flag', 'success_flag',
    'tran_status', 'txn_status', 'trans_status'
  ],
  amount: [
    'amount', 'value', 'sum', 'total', 'price', 'cost', 'charge',
    'payment_amount', 'transaction_amount', 'tran_amount', 'txn_amount',
    'debit_amount', 'credit_amount', 'gross_amount', 'net_amount',
    'gross', 'net', 'qty', 'quantity', 'amt', 'naira_value',
    'face_value', 'principal_amount', 'settlement_amount'
  ],
  currency: [
    'currency', 'currency_code', 'ccy', 'iso_currency', 'curr',
    'denomination', 'coin', 'fx_currency', 'payment_currency'
  ],
  type: [
    'type', 'transaction_type', 'payment_type', 'service', 'service_type',
    'product_type', 'category', 'kind', 'class', 'mode', 'operation',
    'method', 'txn_type', 'tran_type', 'trans_type', 'order_type',
    'event_type', 'action_type', 'transfer_type'
  ],
  direction: [
    'direction', 'flow', 'side', 'dr_cr', 'debit_credit', 'entry_type',
    'movement', 'sign', 'polarity', 'credit_debit', 'txn_side'
  ],
  channel: [
    'channel', 'source', 'platform', 'medium', 'interface', 'origin',
    'access', 'device', 'network', 'gateway', 'entry_channel',
    'payment_channel', 'transaction_channel', 'txn_channel', 'access_channel'
  ],
  'product.line': [
    'product_line', 'product', 'line', 'service_line', 'segment',
    'division', 'business_line', 'vertical', 'offering', 'portfolio',
    'product_group', 'service_group', 'business_unit', 'product_category'
  ],
  'product.biller': [
    'biller', 'merchant', 'vendor', 'provider', 'processor', 'payee',
    'counterparty', 'beneficiary', 'operator', 'partner', 'service_provider',
    'recipient', 'collector', 'issuer', 'sender', 'destination_bank',
    'merchant_name', 'biller_name', 'vendor_name', 'payee_name'
  ],
  'product.biller_category': [
    'biller_category', 'merchant_category', 'service_category', 'sector',
    'industry', 'mcc', 'class', 'group', 'sub_category', 'sub_type',
    'merchant_type', 'biller_type', 'service_class'
  ],
  'principal.id': [
    'principal_id', 'customer_id', 'user_id', 'account_id', 'client_id',
    'wallet_id', 'payer_id', 'msisdn', 'subscriber_id', 'member_id',
    'consumer_id', 'agent_id', 'sender_id', 'buyer_id', 'holder_id',
    'patron_id', 'owner_id', 'initiator_id', 'originator_id'
  ],
  'principal.reference': [
    'principal_reference', 'customer_phone', 'phone_number', 'mobile',
    'phone', 'msisdn', 'account_number', 'customer_reference',
    'user_reference', 'contact', 'mobile_number', 'phone_no',
    'customer_account', 'account_no', 'account_num', 'masked_phone'
  ],
  'principal.type': [
    'principal_type', 'customer_type', 'user_type', 'account_type',
    'client_type', 'payer_type', 'entity_type', 'actor_type', 'party_type'
  ]
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

function ComboField({ label, value, onChange, suggestions }: { label: string; value: string; onChange: (value: string) => void; suggestions: string[] }) {
  const [open, setOpen] = useState(false);
  const filtered = suggestions.filter((s) => !value || s.toLowerCase().includes(value.toLowerCase()));

  function handleSelect(s: string) {
    onChange(s);
    setOpen(false);
  }

  return (
    <div className="form-field combo-field">
      <label>{label}</label>
      <div className="combo-wrap">
        <input
          value={value}
          autoComplete="off"
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        {open && filtered.length > 0 && (
          <ul className="combo-list">
            {filtered.map((s) => (
              <li key={s} className="combo-item" onMouseDown={(event) => { event.preventDefault(); handleSelect(s); }}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
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

  return (
    <div id="toast" className="show" role="status" aria-live="polite">
      <span className="toast-dot" aria-hidden="true" />
      {message}
    </div>
  );
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

function readCursorValue(cursor: Record<string, unknown> | undefined): string | undefined {
  const value = cursor?.last_fetched_at ?? cursor?.last_source_id ?? Object.values(cursor ?? {})[0];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
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

function generatePassword(length = 16): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join('');
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
  const headers = new Headers(init.headers);
  const token = localStorage.getItem(authTokenStorageKey);
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers
  });
  const payload = await response.json();

  if (!response.ok) {
    if (response.status === 401) {
      localStorage.removeItem(authTokenStorageKey);
    }
    const code = typeof payload.code === 'string' ? payload.code : undefined;
    const message = typeof payload.message === 'string'
      ? payload.message
      : Array.isArray(payload.errors)
        ? payload.errors.map((e: unknown) => (typeof e === 'string' ? e : (e as { message?: string }).message ?? String(e))).join(', ')
        : 'API request failed';
    const error = new Error(message) as Error & { code?: string };
    error.code = code;
    throw error;
  }

  return payload as T;
}
