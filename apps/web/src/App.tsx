import { FormEvent, useEffect, useMemo, useState } from 'react';

type Screen = 'transactions' | 'mapping-rules' | 'journal-log' | 'settings';
type SettingsTab = 'coa' | 'schema' | 'adapters' | 'users' | 'system';
type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

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

const emptyRuleForm: RuleFormState = {
  productLine: 'consumer-app',
  biller: '',
  billerCategory: '',
  transactionType: '',
  debitAccountCode: '',
  creditSplits: [{ accountCode: '', percentageBps: 10000 }]
};

export function App() {
  const [screen, setScreen] = useState<Screen>('mapping-rules');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('coa');
  const [accounts, setAccounts] = useState<ChartAccount[]>([]);
  const [rules, setRules] = useState<MappingRule[]>([]);
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

  useEffect(() => {
    void refreshPhase4Data();
  }, []);

  const activeRules = rules.filter((rule) => rule.status === 'active');
  const inactiveRules = rules.filter((rule) => rule.status === 'inactive');
  const productLineCount = new Set(rules.map((rule) => rule.productLine)).size;

  const creditSplitTotal = useMemo(
    () => ruleForm.creditSplits.reduce((sum, split) => sum + Number(split.percentageBps || 0), 0),
    [ruleForm.creditSplits]
  );

  async function refreshPhase4Data() {
    setLoading(true);
    setError('');

    try {
      const [coaResponse, rulesResponse] = await Promise.all([
        apiGet<{ records: ChartAccount[] }>('/api/coa'),
        apiGet<{ records: MappingRule[] }>('/api/mapping-rules')
      ]);
      setAccounts(coaResponse.records);
      setRules(rulesResponse.records);
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
      await refreshPhase4Data();
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
      await refreshPhase4Data();
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
      await refreshPhase4Data();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to change rule status');
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
        {screen === 'transactions' ? <Placeholder title="Transactions" subtitle="Ingestion data is API-backed; full table wiring comes after mapping UI." /> : null}
        {screen === 'journal-log' ? <Placeholder title="Journal Log" subtitle="Journal generation starts in Phase 5." /> : null}
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
            coaForm={coaForm}
            setCoaForm={setCoaForm}
            saveCoaAccount={saveCoaAccount}
            error={error}
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
  coaForm: { code: string; name: string; type: AccountType };
  setCoaForm: (form: { code: string; name: string; type: AccountType }) => void;
  saveCoaAccount: (event: FormEvent) => void;
  error: string;
}) {
  const { settingsTab, setSettingsTab, accounts, coaForm, setCoaForm, saveCoaAccount, error } = props;

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
              {tab === 'coa' ? 'COA Reference' : labelizeTab(tab)}
            </button>
          ))}
        </aside>
        <div className="settings-content">
          {settingsTab === 'coa' ? (
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
          ) : (
            <Placeholder title={labelizeTab(settingsTab)} subtitle="This settings panel will be wired in its corresponding phase." embedded />
          )}
        </div>
      </div>
    </section>
  );
}

function labelizeTab(tab: SettingsTab) {
  return `${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
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

function formatBps(value: number) {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
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
