// ==Plugin==
// @id: dawn-ynab
// @name: YNAB
// @description: JHS income tab + dashboard — cache paint; sync/token onDemand; no nav scans
// @icon: ti-coin
// ==/Plugin==

/**
 * Dawn YNAB — standalone JHS tab plugin.
 *
 * Deploy: cat plugin.js ynab-engine.js
 *
 * CONTRACT:
 * - registerTab('ynab') on Journal Header Shell.
 * - onDay = cache paint only. Chart.js / sync / collection onDemand.
 * - Hydrates prod Path B `ynab` vault (`ynab_pat` etc.) into `dawn:ynab_*`.
 * - Never getAllRecords on panel.navigated.
 */

class Plugin extends AppPlugin {
  onLoad() {
    this._unreg = null;
    this._ynab = null;

    try {
      this._ynab = new DawnYnab(this);
      this._ynab.attach();
    } catch (e) {
      console.error('[Dawn/YNAB] engine missing — deploy concatenated bundle', e);
      return;
    }

    this._waitForBoot((boot) => {
      this._unreg = boot.register({
        id: 'dawn-ynab',
        tier: 'idle',
        runIdle: () => this._ynab?._ynabEnsurePathBReady?.(),
        idleDelayMs: (isMobile) => (isMobile ? 8000 : 600),
      });
    });
  }

  onUnload() {
    try {
      this._ynab?.detach?.();
    } catch (_) {}
    try {
      this._unreg?.();
    } catch (_) {}
  }

  _waitForBoot(cb) {
    let n = 0;
    const tick = () => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      if (boot?.register) {
        cb(boot);
        return;
      }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 25);
    };
    tick();
  }
}
/**
 * Dawn YNAB engine — prod dashboard + income widget chrome.
 * Instantiated by Tier2. JHS tab (no panel.navigated). Network onDemand.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const YNAB_COLLECTION_NAME = 'YNAB';
/** darienx YNAB txn collection (Income vs Expenses). */
const YNAB_COLLECTION_GUID = '1JK4KABKZHT6G8CBGF0QV64NTD';
const CACHE_TTL_MS  = 15 * 60 * 1000;
const CHART_JS_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';

// Colors
// Widget bg matches Backreferences / Today's Notes card exactly (rgba(30,30,36,0.60))
// Green is now a deeper forest: #1e5c35
const C = {
  green:     '#1e5c35',
  greenRgb:  '30, 92, 53',
  prevLine:  'rgba(140, 130, 110, 0.40)',
  avgLine:   'rgba(110, 100, 88, 0.90)',
  axisText:  '#6e6458',
  statLabel: '#8a7e6a',
  text:      '#e8e0d0',
  textMuted: '#8a7e6a',
  // Exact match to Backreferences card bg (Today's Notes plugin confirmed values)
  cardBg:    'rgba(30, 30, 36, 0.60)',
  cardBorder:'rgba(255, 255, 255, 0.10)',
  hoverBg:   '#2a241f',
};

const SK = {
  TOKEN:           'dawn:ynab_pat',
  BUDGET_ID:       'dawn:ynab_budget_id',
  BUDGET_NAME:     'dawn:ynab_budget_name',
  CACHE_TXN:       'dawn:ynab_txn_cache_v4',
  CACHE_CATS:      'dawn:ynab_cats_v4',
  CACHE_CATS_TS:   'dawn:ynab_cats_ts_v4',
  CACHE_TS:        'dawn:ynab_txn_cache_ts',
  EXCLUDED_GROUPS: 'dawn:ynab_excluded_groups',
  WIDGET_PERIOD:   'dawn:ynab_widget_period',
  WIDGET_CHART:    'dawn:ynab_widget_chart',
  WIDGET_COMPARE:  'dawn:ynab_widget_compare',
  WIDGET_AVG:      'dawn:ynab_widget_avg',
  WIDGET_COLLAPSE: 'dawn:ynab_widget_collapse',
  DASH_FROM:       'dawn:ynab_dash_from',
  DASH_TO:         'dawn:ynab_dash_to',
  EXCL_PAYEES:     'dawn:ynab_excl_payees',
  INCL_PAYEES:     'dawn:ynab_incl_payees_v4',
};

/** Keys synced via Plugin Backend. Cache blobs stay local — vault round-trips were
 *  overwriting fresher API caches with stale snapshots (e.g. missing July 2025). */
const SK_CACHE_KEYS = new Set([SK.CACHE_TXN, SK.CACHE_CATS, SK.CACHE_CATS_TS, SK.CACHE_TS]);
const SK_PROD_KEY = (dawnKey) => (String(dawnKey).startsWith('dawn:') ? dawnKey.slice(5) : dawnKey);
const SK_PATHB_MIRROR = () => {
  const dawn = Object.values(SK).filter((k) => !SK_CACHE_KEYS.has(k));
  const prod = dawn.map(SK_PROD_KEY);
  return [...new Set([...prod, ...dawn])];
};

function ynabCopyProdLsIfEmpty() {
  for (const dawnKey of Object.values(SK)) {
    const prodKey = SK_PROD_KEY(dawnKey);
    if (!prodKey || prodKey === dawnKey) continue;
    try {
      if (String(localStorage.getItem(dawnKey) || '').trim()) continue;
      const v = localStorage.getItem(prodKey);
      if (v == null || v === '') continue;
      localStorage.setItem(dawnKey, v);
    } catch (_) {}
  }
}

/** localStorage: `'on'` | `'off'` — when absent, use collection `custom.mount_journal_income_widget`. */
const YNAB_JWIDGET_OVERRIDE_LS = 'ynab_journal_income_widget_override';

// Default excluded expense category groups
// Default excluded payee keywords for income filter
const DEFAULT_EXCLUDED = [
  'Inflow: Ready to Assign',
  'Internal Master Category',
  'Credit Card Payments',
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

const ls      = k    => { try { return localStorage.getItem(k); } catch { return null; } };
/** UI toggles flush on a short debounce so Path B / panel refresh doesn't race mid-click. */
const YNAB_UI_FLUSH_KEYS = new Set([
  SK.WIDGET_PERIOD, SK.WIDGET_CHART, SK.WIDGET_COMPARE, SK.WIDGET_AVG,
  SK.WIDGET_COLLAPSE, SK.DASH_FROM, SK.DASH_TO,
]);
let _ynabUiFlushTimer = null;
function ynabPluginSettingsFlush(immediate = false) {
  try {
    const p = globalThis.__ynabPluginSettingsPlugin;
    if (!p) return;
    const run = () => {
      _ynabUiFlushTimer = null;
      globalThis.ThymerPluginSettings?.scheduleFlush?.(p, SK_PATHB_MIRROR);
    };
    if (immediate) {
      if (_ynabUiFlushTimer != null) { try { clearTimeout(_ynabUiFlushTimer); } catch (_) {} _ynabUiFlushTimer = null; }
      run();
      return;
    }
    if (_ynabUiFlushTimer != null) try { clearTimeout(_ynabUiFlushTimer); } catch (_) {}
    _ynabUiFlushTimer = setTimeout(run, 700);
  } catch (_) {}
}
const lsSet   = (k,v)=> {
  try { localStorage.setItem(k, String(v)); } catch {}
  ynabPluginSettingsFlush(!YNAB_UI_FLUSH_KEYS.has(k));
};
const lsJson  = (k,d)=> { try { const v = ls(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsJsonSet=(k,v)=> {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  ynabPluginSettingsFlush(!YNAB_UI_FLUSH_KEYS.has(k));
};
const sleep   = ms   => new Promise(r => setTimeout(r, ms));

/** Thymer datetime fields require DateTimeValue — not raw Date (SDK/runtime). */
function ynabSetDateTimeProp(prop, date) {
  if (!prop || !date) return;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return;
  try {
    if (typeof prop.setFromDate === 'function') {
      prop.setFromDate(d);
      return;
    }
  } catch (_) {}
  try {
    if (typeof DateTime !== 'undefined' && typeof DateTime.fromDate === 'function') {
      prop.set(DateTime.fromDate(d).value());
      return;
    }
  } catch (_) {}
  try {
    if (typeof DateTime !== 'undefined' && typeof DateTime.parseDateTimeString === 'function') {
      const pad = (n) => String(n).padStart(2, '0');
      const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      prop.set(DateTime.parseDateTimeString(s).value());
    }
  } catch (_) {}
}

function ynabSetYmdDateProp(prop, ymd) {
  if (!prop || !ymd) return;
  const parts = String(ymd).trim().split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return;
  ynabSetDateTimeProp(prop, new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0));
}

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function journalDateFromGuid(guid) {
  if (!guid || guid.length < 8) return null;
  const s = guid.slice(-8);
  if (!/^\d{8}$/.test(s)) return null;
  const year  = parseInt(s.slice(0, 4), 10);
  const month = parseInt(s.slice(4, 6), 10);
  const day   = parseInt(s.slice(6, 8), 10);
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, yyyymmdd: s };
}

/** Same shape as journalDateFromGuid; falls back to journal details when GUID suffix is not YYYYMMDD. */
function journalDateFromRecord(record) {
  if (!record) return null;
  const fromGuid = journalDateFromGuid(record.guid);
  if (fromGuid) return fromGuid;
  try {
    const jd = record.getJournalDetails?.();
    const d = jd?.date;
    if (d instanceof Date && !isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const day = d.getDate();
      const yyyymmdd = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      return { year, month, day, yyyymmdd };
    }
  } catch {}
  return null;
}

/** Local calendar YYYY-MM-DD (avoid toISOString UTC day-shift). */
function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Normalize any date-ish value to YYYY-MM-DD for reliable string compares. */
function ymd(v) {
  if (v == null) return '';
  // Thymer datetime prop value: { d: "20250701", formatted: "Tue Jul 1 2025" }
  if (typeof v === 'object' && !(v instanceof Date)) {
    try {
      if (typeof v.value === 'function') {
        const inner = v.value();
        if (inner && inner !== v) return ymd(inner);
      }
    } catch (_) {}
    if (v.d != null) {
      const raw = String(v.d).replace(/\D/g, '');
      if (raw.length >= 8) {
        return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      }
    }
    try {
      if (typeof v.toDate === 'function') {
        const d = v.toDate();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return dateStr(d);
      }
    } catch (_) {}
    // Don't leak "[object Object]" into range compares — that zeros the whole dash.
    return '';
  }
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : dateStr(v);
  }
  const s = String(v).trim();
  if (!s || s === '[object Object]') return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Compact YYYMMDD (sometimes appears in caches / Thymer exports)
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return dateStr(d);
  return '';
}

function inYmdRange(dateVal, from, to) {
  const d = ymd(dateVal);
  if (!d) return false;
  if (from && d < ymd(from)) return false;
  if (to && d > ymd(to)) return false;
  return true;
}

/** Month axis label with full 4-digit year (e.g. "Jan 2025"). */
function monthYearLabel(d) {
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

const MAX_DAY_BARS = 45;
const MAX_WEEK_BARS = 26;

/**
 * Bucket a date range for the dashboard chart.
 * Honors daily|weekly|monthly preference — never silently switches Daily → Monthly.
 * Long daily/weekly ranges window to the end of the selection instead.
 */
function buildRangeBuckets(from, to, prefer = 'monthly') {
  const fromDate = new Date(`${ymd(from)}T12:00:00`);
  const toDate = new Date(`${ymd(to)}T12:00:00`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    return { keys: [], labels: [], grain: 'month', windowNote: '', prefer };
  }
  const dayMs = 86400000;
  const daysApprox = Math.round((toDate - fromDate) / dayMs) + 1;
  const monthsApprox =
    (toDate.getFullYear() - fromDate.getFullYear()) * 12 +
    (toDate.getMonth() - fromDate.getMonth()) + 1;

  let grain = 'month';
  let windowNote = '';
  let viewFrom = new Date(fromDate);
  let viewTo = new Date(toDate);

  if (prefer === 'daily') {
    grain = 'day';
    if (daysApprox > MAX_DAY_BARS) {
      viewFrom = new Date(toDate);
      viewFrom.setDate(viewFrom.getDate() - (MAX_DAY_BARS - 1));
      if (viewFrom < fromDate) viewFrom = new Date(fromDate);
      windowNote = `last ${MAX_DAY_BARS} days`;
    }
  } else if (prefer === 'weekly') {
    grain = 'week';
    if (daysApprox > MAX_WEEK_BARS * 7) {
      viewFrom = new Date(toDate);
      viewFrom.setDate(viewFrom.getDate() - (MAX_WEEK_BARS * 7 - 1));
      if (viewFrom < fromDate) viewFrom = new Date(fromDate);
      windowNote = `last ${MAX_WEEK_BARS} weeks`;
    }
  } else {
    grain = monthsApprox > 48 ? 'year' : monthsApprox > 24 ? 'quarter' : 'month';
  }

  const keys = [];
  const labels = [];
  let guard = 0;
  if (grain === 'day') {
    const d = new Date(viewFrom);
    while (d <= viewTo && guard++ < 800) {
      const k = dateStr(d);
      keys.push(k);
      labels.push(k.slice(5).replace('-', '.'));
      d.setDate(d.getDate() + 1);
    }
  } else if (grain === 'week') {
    const wkStart = (d) => {
      const dt = new Date(d);
      dt.setDate(dt.getDate() - dt.getDay());
      dt.setHours(12, 0, 0, 0);
      return dt;
    };
    let s = wkStart(viewFrom);
    const end = wkStart(viewTo);
    while (s <= end && guard++ < 400) {
      const k = dateStr(s);
      keys.push(`W:${k}`);
      labels.push(k.slice(5).replace('-', '.'));
      s.setDate(s.getDate() + 7);
    }
  } else if (grain === 'year') {
    let y = fromDate.getFullYear();
    const yEnd = toDate.getFullYear();
    while (y <= yEnd && guard++ < 200) {
      keys.push(String(y));
      labels.push(String(y));
      y += 1;
    }
  } else if (grain === 'quarter') {
    let y = fromDate.getFullYear();
    let q = Math.floor(fromDate.getMonth() / 3);
    const endY = toDate.getFullYear();
    const endQ = Math.floor(toDate.getMonth() / 3);
    while ((y < endY || (y === endY && q <= endQ)) && guard++ < 400) {
      keys.push(`${y}-Q${q + 1}`);
      labels.push(`Q${q + 1} ${y}`);
      q += 1;
      if (q > 3) { q = 0; y += 1; }
    }
  } else {
    const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    const end = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
    while (d <= end && guard++ < 600) {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      keys.push(`${y}-${String(m).padStart(2, '0')}`);
      labels.push(monthYearLabel(d));
      d.setMonth(d.getMonth() + 1);
    }
  }
  return { keys, labels, grain, windowNote, prefer };
}

function txnInRangeBucket(t, key, grain) {
  const d = ymd(t?.date);
  if (!d) return false;
  if (grain === 'day') return d === key;
  if (grain === 'week') {
    const start = key.startsWith('W:') ? key.slice(2) : key;
    const s = new Date(`${start}T12:00:00`);
    if (Number.isNaN(s.getTime())) return false;
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    return d >= dateStr(s) && d <= dateStr(e);
  }
  if (grain === 'year') return d.startsWith(key);
  if (grain === 'quarter') {
    const [y, qStr] = key.split('-Q');
    const q = parseInt(qStr, 10);
    if (!y || !(q >= 1 && q <= 4)) return false;
    const m0 = (q - 1) * 3 + 1;
    for (let i = 0; i < 3; i++) {
      if (d.startsWith(`${y}-${String(m0 + i).padStart(2, '0')}`)) return true;
    }
    return false;
  }
  return d.startsWith(key);
}

/** Oldest YYYY-MM-DD among loaded txns (empty string if none). */
function oldestTxnYmd(txns) {
  let min = '';
  for (const t of txns || []) {
    const d = ymd(t?.date);
    if (d && (!min || d < min)) min = d;
  }
  return min;
}

// Date range presets — all return { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
// All Time starts at the oldest loaded txn (not a hardcoded epoch).
function presets(oldestYmd) {
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = now.getMonth();

  const firstOfMonth = new Date(y, m, 1);
  const lastOfMonth  = new Date(y, m + 1, 0);
  const firstOfLastMonth = new Date(y, m - 1, 1);
  const lastOfLastMonth  = new Date(y, m, 0);
  const firstOfYear  = new Date(y, 0, 1);
  const firstOfLastYear  = new Date(y - 1, 0, 1);
  const lastOfLastYear   = new Date(y - 1, 11, 31);
  const allFrom = (oldestYmd && /^\d{4}-\d{2}-\d{2}/.test(oldestYmd))
    ? oldestYmd.slice(0, 10)
    : dateStr(now);

  return [
    { label: 'This Month',  from: dateStr(firstOfMonth),    to: dateStr(lastOfMonth) },
    { label: 'Last Month',  from: dateStr(firstOfLastMonth), to: dateStr(lastOfLastMonth) },
    { label: 'YTD',         from: dateStr(firstOfYear),     to: dateStr(now) },
    { label: 'Last Year',   from: dateStr(firstOfLastYear), to: dateStr(lastOfLastYear) },
    { label: 'Last 90d',    from: dateStr(new Date(now - 90*864e5)), to: dateStr(now) },
    { label: 'All Time',    from: allFrom,                 to: dateStr(now) },
  ];
}

// Income filter — returns true if transaction should be counted as income.
// Uses the explicit payee include list if configured, else falls back to
// excluding payees that contain "transfer" or "starting".
function isIncomeTransaction(t, allTxns) {
  if (t.type !== 'income') return false;
  const raw = ls(SK.INCL_PAYEES);
  if (raw) {
    const incl = JSON.parse(raw).map((p) => String(p).trim().toLowerCase());
    return incl.includes(String(t.payee || '').trim().toLowerCase());
  }
  // Default: exclude transfer-like payees
  return !['transfer','starting'].some(kw => t.payee.toLowerCase().includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART.JS LOADER
// ─────────────────────────────────────────────────────────────────────────────

let _chartLoad = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (_chartLoad) return _chartLoad;
  _chartLoad = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = CHART_JS_URL; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return _chartLoad;
}

// ─────────────────────────────────────────────────────────────────────────────
// YNAB API
// ─────────────────────────────────────────────────────────────────────────────

async function ynabGet(path, token) {
  const r = await fetch(`https://api.ynab.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.detail || `YNAB ${r.status}`);
  }
  return r.json();
}

async function apiFetchBudgets(token) {
  return (await ynabGet('/budgets', token)).data.budgets;
}

async function apiFetchTransactions(token, budgetId) {
  return (await ynabGet(`/budgets/${budgetId}/transactions`, token)).data.transactions;
}

async function apiFetchCategories(token, budgetId) {
  const d = await ynabGet(`/budgets/${budgetId}/categories`, token);
  return d.data.category_groups;
}

// Build a map of category_id → group_name from the categories endpoint
async function buildCategoryGroupMap(token, budgetId) {
  const ts = ls(SK.CACHE_CATS_TS);
  if (ts && Date.now() - parseInt(ts, 10) < CACHE_TTL_MS) {
    const cached = lsJson(SK.CACHE_CATS, null);
    if (cached) return cached;
  }
  const groups = await apiFetchCategories(token, budgetId);
  const map = {};
  for (const group of groups) {
    for (const cat of (group.categories || [])) {
      map[cat.id] = group.name;
    }
  }
  lsJsonSet(SK.CACHE_CATS, map);
  lsSet(SK.CACHE_CATS_TS, Date.now());
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION PROCESSING  — transfers are DROPPED here, never synced
// ─────────────────────────────────────────────────────────────────────────────

function processTxns(raw, groupMap = {}) {
  const results = [];

  for (const t of raw) {
    if (t.deleted) continue;
    if (t.transfer_account_id) continue; // skip top-level transfers

    const isSplit = Array.isArray(t.subtransactions) && t.subtransactions.length > 0;

    if (isSplit) {
      // Expand each subtransaction into its own record.
      // The parent has the payee, date, account, cleared — subs have amount + category.
      for (const sub of t.subtransactions) {
        if (sub.deleted) continue;
        if (sub.transfer_account_id) continue; // skip transfer legs within splits

        results.push({
          id:             `${t.id}_${sub.id}`, // unique ID per sub-line
          date:           ymd(t.date),
          payee:          t.payee_name || '',
          amount:         sub.amount / 1000,
          category:       sub.category_name || 'Uncategorized',
          category_group: (sub.category_id && groupMap[sub.category_id]) || 'Uncategorized',
          memo:           sub.memo || t.memo || '',
          account:        t.account_name || '',
          cleared:        t.cleared,
          type:           sub.amount > 0 ? 'income' : 'expense',
          is_split:       true,
        });
      }
    } else {
      // Normal (non-split) transaction
      results.push({
        id:             t.id,
        date:           ymd(t.date),
        payee:          t.payee_name || '',
        amount:         t.amount / 1000,
        category:       t.category_name || 'Uncategorized',
        category_group: (t.category_id && groupMap[t.category_id]) || 'Uncategorized',
        memo:           t.memo || '',
        account:        t.account_name || '',
        cleared:        t.cleared,
        type:           t.amount > 0 ? 'income' : 'expense',
        is_split:       false,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────

function getCached() {
  const ts = ls(SK.CACHE_TS);
  if (!ts || Date.now() - parseInt(ts, 10) > CACHE_TTL_MS) return null;
  const raw = lsJson(SK.CACHE_TXN, null);
  if (!Array.isArray(raw)) return null;
  // Normalize dates on read so older cache entries still compare correctly.
  return raw.map((t) => (t && t.date && t.date.length !== 10 ? { ...t, date: ymd(t.date) } : t));
}
function setCache(txns) {
  try {
    localStorage.setItem(SK.CACHE_TXN, JSON.stringify(txns));
    localStorage.setItem(SK.CACHE_TS, String(Date.now()));
  } catch (e) {
    try { console.warn('[YNAB] cache write failed (quota?)', e); } catch (_) {}
  }
  ynabPluginSettingsFlush(true);
}
function bustCache()    { lsSet(SK.CACHE_TS, '0'); try { localStorage.removeItem(SK.CACHE_TXN); } catch (_) {} }

async function getTransactions(force = false) {
  if (!force) { const c = getCached(); if (c) return c; }
  const token = ls(SK.TOKEN), budgetId = ls(SK.BUDGET_ID);
  if (!token || !budgetId) throw new Error('YNAB not configured');
  // Fetch both in parallel — categories for the group lookup map
  const [rawTxns, groupMap] = await Promise.all([
    apiFetchTransactions(token, budgetId),
    buildCategoryGroupMap(token, budgetId),
  ]);
  const txns = processTxns(rawTxns, groupMap);
  setCache(txns);
  return txns;
}

/** Read a Thymer record field with several SDK shapes. */
function ynabRecField(record, id) {
  try {
    if (typeof record.text === 'function') {
      const t = record.text(id);
      if (t != null && t !== '') return t;
    }
  } catch (_) {}
  try {
    const p = record.prop?.(id);
    if (!p) return null;
    if (typeof p.getChoice === 'function') {
      try {
        const c = p.getChoice();
        if (c != null && c !== '') return c;
      } catch (_) {}
    }
    if (typeof p.get === 'function') {
      const v = p.get();
      // MCP/SDK sometimes returns ["datetime", { d: "20250701" }] / ["text", "…"]
      if (Array.isArray(v) && v.length >= 2) return v[1];
      return v;
    }
  } catch (_) {}
  return null;
}

function ynabRecDateYmd(record) {
  // Prefer title — sync always writes "YYYY-MM-DD · payee · $amount"
  try {
    const name = (typeof record.getName === 'function' ? record.getName() : '') || record.name || '';
    const m = String(name).match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  } catch (_) {}
  // Thymer datetime accessor (same pattern as other plugins)
  try {
    const dt = record.datetime?.('date') || record.prop?.('date')?.datetime?.();
    if (dt) {
      const fromDt = ymd(dt);
      if (fromDt) return fromDt;
      try {
        if (typeof dt.value === 'function') {
          const fromVal = ymd(dt.value());
          if (fromVal) return fromVal;
        }
      } catch (_) {}
      try {
        if (typeof dt.toDate === 'function') {
          const fromDate = ymd(dt.toDate());
          if (fromDate) return fromDate;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return ymd(ynabRecField(record, 'date'));
}

/** Map YNAB collection rows → dashboard txn shape (source of truth the user can see). */
function txnsFromYnabRecords(records) {
  const out = [];
  let skipped = 0;
  for (const r of records || []) {
    const date = ynabRecDateYmd(r);
    if (!date) { skipped++; continue; }
    const rawAmt = Number(ynabRecField(r, 'amount'));
    if (!Number.isFinite(rawAmt)) { skipped++; continue; }
    const typeRaw = String(ynabRecField(r, 'transaction_type') || '').toLowerCase();
    let type;
    if (typeRaw.includes('income')) type = 'income';
    else if (typeRaw.includes('expense')) type = 'expense';
    else type = rawAmt >= 0 ? 'income' : 'expense';
    out.push({
      id: String(ynabRecField(r, 'ynab_id') || r.guid || ''),
      date,
      payee: String(ynabRecField(r, 'payee') || ''),
      amount: Math.abs(rawAmt),
      category: String(ynabRecField(r, 'category') || 'Uncategorized'),
      category_group: String(ynabRecField(r, 'category_group') || 'Uncategorized'),
      memo: String(ynabRecField(r, 'memo') || ''),
      account: String(ynabRecField(r, 'account') || ''),
      cleared: String(ynabRecField(r, 'cleared') || ''),
      type,
      is_split: false,
    });
  }
  if (!out.length && (records || []).length) {
    try { console.warn('[YNAB] collection rows present but none parsed', { total: records.length, skipped }); } catch (_) {}
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUCKETING  (widget chart only)
// ─────────────────────────────────────────────────────────────────────────────

function bucketData(txns, refDate, period, compare, showAvg) {
  // txns is expected to already be filtered to income-only transactions
  const income = txns;
  let labels = [], cur = [], prev = null, curTotal = 0, prevTotal = null, avg = null;

  if (period === 'daily') {
    const N = 30;
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(refDate); d.setDate(d.getDate() - i);
      const k = dateStr(d);
      labels.push(k.slice(5).replace('-', '.'));
      cur.push(income.filter(t => ymd(t.date) === k).reduce((a, t) => a + t.amount, 0));
    }
    curTotal = income.filter(t => ymd(t.date) === dateStr(refDate)).reduce((a, t) => a + t.amount, 0);
    if (compare) {
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const d = new Date(refDate); d.setDate(d.getDate() - i - N);
        prev.push(income.filter(t => ymd(t.date) === dateStr(d)).reduce((a, t) => a + t.amount, 0));
      }
      const yd = new Date(refDate); yd.setDate(yd.getDate() - 1);
      prevTotal = income.filter(t => ymd(t.date) === dateStr(yd)).reduce((a, t) => a + t.amount, 0);
    }
    if (showAvg) avg = cur.reduce((a, b) => a + b, 0) / cur.length;

  } else if (period === 'weekly') {
    const N = 12;
    const wkStart = d => { const dt = new Date(d); dt.setDate(dt.getDate() - dt.getDay()); dt.setHours(0,0,0,0); return dt; }; // Sunday start, matches Coda
    const ws = wkStart(refDate);
    for (let i = N - 1; i >= 0; i--) {
      const s = new Date(ws); s.setDate(s.getDate() - i*7);
      const e = new Date(s);  e.setDate(e.getDate() + 6);
      const wkNum = (() => {
        const tmp = new Date(s); tmp.setHours(0,0,0,0);
        const jan1 = new Date(tmp.getFullYear(), 0, 1);
        return Math.ceil(((tmp - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      })();
      const wkMMDD = dateStr(s).slice(5).replace('-', '.');
      labels.push(`w${String(wkNum).padStart(2,'0')} · ${wkMMDD}`);
      cur.push(income.filter(t => inYmdRange(t.date, dateStr(s), dateStr(e))).reduce((a,t)=>a+t.amount,0));
    }
    const wse = new Date(ws); wse.setDate(wse.getDate()+6);
    curTotal = income.filter(t => inYmdRange(t.date, dateStr(ws), dateStr(wse))).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      // Overlay: each bar's comparison is the equivalent week 1 year ago
      // prevTotal: simply the week immediately before the current one
      const lastWS = new Date(ws); lastWS.setDate(lastWS.getDate() - 7);
      const lastWE = new Date(lastWS); lastWE.setDate(lastWE.getDate() + 6);
      prevTotal = income.filter(t => inYmdRange(t.date, dateStr(lastWS), dateStr(lastWE))).reduce((a,t)=>a+t.amount,0);
      // Overlay line: shift each displayed week back by exactly 1 week
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const s = new Date(ws); s.setDate(s.getDate() - i*7 - 7);
        const e = new Date(s);  e.setDate(e.getDate()+6);
        prev.push(income.filter(t => inYmdRange(t.date, dateStr(s), dateStr(e))).reduce((a,t)=>a+t.amount,0));
      }
    }
    if (showAvg) { const nz = cur.filter(v=>v>0); avg = nz.length ? nz.reduce((a,b)=>a+b,0)/nz.length : 0; }

  } else { // monthly
    const N = 12;
    for (let i = N - 1; i >= 0; i--) {
      const d  = new Date(refDate.getFullYear(), refDate.getMonth()-i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      labels.push(monthYearLabel(d));
      cur.push(income.filter(t=>ymd(t.date).startsWith(key)).reduce((a,t)=>a+t.amount,0));
    }
    const ck = `${refDate.getFullYear()}-${String(refDate.getMonth()+1).padStart(2,'0')}`;
    curTotal = income.filter(t=>ymd(t.date).startsWith(ck)).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      const pd = new Date(refDate.getFullYear(), refDate.getMonth()-N, 1);
      prev = [];
      for (let i = 0; i < N; i++) {
        const d = new Date(pd.getFullYear(), pd.getMonth()+i, 1);
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        prev.push(income.filter(t=>ymd(t.date).startsWith(k)).reduce((a,t)=>a+t.amount,0));
      }
      prevTotal = prev[prev.length-1] ?? 0;
    }
    if (showAvg) { const nz = cur.filter(v=>v>0); avg = nz.length ? nz.reduce((a,b)=>a+b,0)/nz.length : 0; }
  }

  return { labels, cur, prev, curTotal, prevTotal, avg };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────

const CSS = `
  /* Inside JHS: no nested card (prod .jhs-body .ynab-widget). */
  .dawn-jhs-shell .dawn-jhs-body .ynab-widget {
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  .dawn-jhs-header-extra .jhs-ynab-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .dawn-jhs-header-extra .jhs-ynab-controls-left {
    display: flex;
    align-items: center;
    gap: 0;
    flex-wrap: wrap;
    min-width: 0;
  }
  .dawn-jhs-header-extra .jhs-ynab-controls-right {
    display: flex;
    align-items: center;
    margin-left: auto;
  }
  .dawn-jhs-header-extra .ynab-tgroup {
    background: transparent;
    border-radius: 0;
    padding: 0;
    gap: 10px;
  }
  .dawn-jhs-header-extra .ynab-tgroup + .ynab-tgroup {
    margin-left: 4px;
    padding-left: 14px;
    border-left: 1px solid rgba(255,255,255,0.075);
  }
  .dawn-jhs-header-extra .ynab-tbtn {
    padding: 1px 0;
    border-radius: 0;
    background: transparent;
    color: rgba(232, 224, 208, 0.5);
    font-size: 11px;
    letter-spacing: 0.015em;
  }
  .dawn-jhs-header-extra .ynab-tbtn:hover {
    background: transparent;
    color: rgba(232, 224, 208, 0.86);
  }
  .dawn-jhs-header-extra .ynab-tbtn.active {
    background: transparent;
    color: #3d8f58;
    font-weight: 600;
  }
  /* ── Standalone / dashboard card ── */
  .ynab-widget {
    background-color: ${C.cardBg};
    border: 1px solid ${C.cardBorder};
    border-radius: 10px;
    padding: 10px 16px 10px;
    margin-bottom: 12px;
    font-size: 13px;
    color: ${C.text};
  }
  .ynab-widget-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  .ynab-w-toggle {
    font-size: 13px;
    color: ${C.statLabel};
    cursor: pointer;
    padding: 0 3px;
    flex-shrink: 0;
    background: none;
    border: none;
    line-height: 1;
  }
  .ynab-w-title {
    font-weight: 600;
    font-size: 13px;
    flex-shrink: 0;
  }
  .ynab-w-controls {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-left: auto;
  }
  .ynab-tgroup {
    display: flex;
    gap: 2px;
    background: rgba(255,255,255,0.05);
    border-radius: 6px;
    padding: 2px;
  }
  .ynab-tbtn {
    background: transparent;
    border: none;
    color: ${C.statLabel};
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.12s;
    line-height: 1.4;
  }
  .ynab-tbtn:hover { color: ${C.text}; background: rgba(255,255,255,0.07); }
  .ynab-tbtn.active {
    background: rgba(${C.greenRgb}, 0.25);
    color: #3d8f58;
    font-weight: 600;
  }

  .ynab-widget-body { margin-top: 10px; }

  /* Filter chips in widget */
  .ynab-w-filter-row {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
    margin-bottom: 9px;
    align-items: center;
  }
  .ynab-w-filter-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: ${C.statLabel};
    flex-shrink: 0;
    margin-right: 2px;
  }
  .ynab-w-chip {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid rgba(${C.greenRgb}, 0.35);
    background: rgba(${C.greenRgb}, 0.14);
    color: #3d8f58;
    cursor: pointer;
    transition: all 0.12s;
    line-height: 1.5;
  }
  .ynab-w-chip:hover { background: rgba(${C.greenRgb}, 0.22); }
  .ynab-w-chip.off {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.09);
    color: ${C.statLabel};
    text-decoration: line-through;
  }

  .ynab-stat-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .ynab-stat-chip {
    background: rgba(255,255,255,0.05);
    border-radius: 6px;
    padding: 4px 10px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ynab-stat-chip.pos .ynab-sv { color: #3d8f58; }
  .ynab-stat-chip.neg .ynab-sv { color: #b84040; }
  .ynab-sl {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${C.statLabel};
  }
  .ynab-sv {
    font-size: 14px;
    font-weight: 600;
    color: ${C.text};
    font-variant-numeric: tabular-nums;
  }

  .ynab-canvas-wrap { position: relative; height: 140px; margin-bottom: 5px; }
  .ynab-status { font-size: 10px; color: ${C.statLabel}; text-align: right; font-style: italic; }
  .ynab-notice { font-size: 12px; color: ${C.statLabel}; padding: 6px 0; font-style: italic; }
  .ynab-cfg-link { color: #3d8f58; text-decoration: none; }
  .ynab-cfg-link:hover { text-decoration: underline; }

  /* ── Dashboard ── */
  .ynab-dash {
    padding: 20px 24px;
    font-size: 13px;
    color: ${C.text};
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .ynab-dash-loading, .ynab-dash-error {
    padding: 40px; text-align: center; color: ${C.statLabel}; font-style: italic;
  }

  /* Date range controls */
  .ynab-range-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ynab-preset-group {
    display: flex;
    gap: 3px;
    flex-wrap: wrap;
  }
  .ynab-preset-btn {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 5px;
    color: ${C.statLabel};
    font-size: 11px;
    padding: 4px 10px;
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }
  .ynab-preset-btn:hover { background: rgba(255,255,255,0.11); color: ${C.text}; }
  .ynab-preset-btn.active {
    background: rgba(${C.greenRgb}, 0.22);
    border-color: rgba(${C.greenRgb}, 0.45);
    color: #3d8f58;
    font-weight: 600;
  }
  .ynab-custom-range {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: ${C.statLabel};
  }
  .ynab-date-input {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 5px;
    color: ${C.text};
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .ynab-date-input:focus { outline: none; border-color: rgba(${C.greenRgb}, 0.45); }

  .ynab-action-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .ynab-btn {
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 6px;
    color: ${C.text};
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.12s;
  }
  .ynab-btn:hover { background: rgba(255,255,255,0.13); }
  .ynab-btn-primary {
    background: rgba(${C.greenRgb}, 0.22);
    border-color: rgba(${C.greenRgb}, 0.45);
    color: #3d8f58;
  }
  .ynab-btn-primary:hover { background: rgba(${C.greenRgb}, 0.32); }

  /* Filter chips — dashboard */
  .ynab-filter-wrap { display: flex; flex-direction: column; gap: 7px; }
  .ynab-filter-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: ${C.statLabel};
  }
  .ynab-filter-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .ynab-fchip {
    background: rgba(${C.greenRgb}, 0.14);
    border: 1px solid rgba(${C.greenRgb}, 0.32);
    border-radius: 14px;
    color: #3d8f58;
    font-size: 11px;
    padding: 3px 10px;
    cursor: pointer;
    transition: all 0.12s;
    user-select: none;
  }
  .ynab-fchip:hover { background: rgba(${C.greenRgb}, 0.22); }
  .ynab-fchip.off {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.09);
    color: ${C.statLabel};
    text-decoration: line-through;
  }

  /* Stat cards */
  .ynab-stat-cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .ynab-big-card {
    flex: 1; min-width: 130px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 14px 18px;
  }
  .ynab-big-card.inc { border-color: rgba(${C.greenRgb}, 0.30); }
  .ynab-big-card.exp { border-color: rgba(184, 64, 64, 0.28); }
  .ynab-card-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
    color: ${C.statLabel}; margin-bottom: 5px;
  }
  .ynab-card-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ynab-big-card.inc .ynab-card-value { color: #3d8f58; }
  .ynab-big-card.exp .ynab-card-value { color: #b84040; }
  .ynab-big-card.net-pos .ynab-card-value { color: #3d8f58; }
  .ynab-big-card.net-neg .ynab-card-value { color: #b84040; }

  .ynab-section-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: ${C.statLabel}; margin-bottom: 7px;
  }
  .ynab-dash-chart-wrap { position: relative; height: 180px; }
  .ynab-dash-trends-controls {
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px;
  }

  /* Tables */
  /* Secondary stat row (wages/draw) */
  .ynab-secondary-row {
    display: flex; gap: 10px; flex-wrap: wrap;
  }
  .ynab-secondary-chip {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; padding: 10px 16px;
    display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 120px;
  }
  .ynab-secondary-chip .ynab-card-label { font-size: 9px; }
  .ynab-secondary-chip .ynab-card-value { font-size: 16px; color: #c0625a; }

  /* Taxes collapsible section */
  .ynab-taxes-section {
    border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; overflow: hidden;
  }
  .ynab-taxes-header {
    display: flex; align-items: center; gap: 10px; padding: 12px 16px;
    cursor: pointer; background: rgba(255,255,255,0.03); user-select: none;
  }
  .ynab-taxes-header:hover { background: rgba(255,255,255,0.05); }
  .ynab-taxes-toggle { font-size: 11px; color: #8a7e6a; flex-shrink: 0; }
  .ynab-taxes-title { font-weight: 600; font-size: 13px; flex: 1; }
  .ynab-taxes-total { font-size: 13px; font-weight: 600; color: #c0625a; font-variant-numeric: tabular-nums; }
  .ynab-taxes-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .ynab-taxes-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .ynab-group-table, .ynab-txn-table {
    width: 100%; border-collapse: collapse; font-size: 12px;
  }
  .ynab-group-table th, .ynab-txn-table th {
    text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
    color: ${C.statLabel}; padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .ynab-group-table td, .ynab-txn-table td {
    padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.035); color: ${C.text};
  }
  .ynab-group-table tr:hover td, .ynab-txn-table tr:hover td {
    background: rgba(255,255,255,0.03);
  }
  .ynab-amt-pos { color: #3d8f58 !important; }
  .ynab-amt-neg { color: #b84040 !important; }
  .ynab-badge { font-size: 10px; padding: 2px 7px; border-radius: 10px; background: rgba(255,255,255,0.07); color: ${C.statLabel}; }
  .ynab-badge.cleared { background: rgba(${C.greenRgb}, 0.15); color: #3d8f58; }
  .ynab-badge.reconciled { background: rgba(99,132,200,0.14); color: #7aacf8; }

  /* Config dialog — must stack above the floating dashboard (z-index 99998) */
  .ynab-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.62); z-index: 100050;
    display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);
  }
  .ynab-dialog {
    background: #1c1a16; border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
    padding: 24px; width: 420px; max-width: 90vw; display: flex; flex-direction: column;
    gap: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.55);
  }
  .ynab-dlg-title { font-size: 16px; font-weight: 700; color: ${C.text}; }
  .ynab-dlg-form { display: flex; flex-direction: column; gap: 10px; }
  .ynab-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: ${C.statLabel}; }
  .ynab-input {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.11);
    border-radius: 6px; color: ${C.text}; padding: 8px 12px; font-size: 13px;
    width: 100%; box-sizing: border-box;
  }
  .ynab-input:focus { outline: none; border-color: rgba(${C.greenRgb}, 0.5); }
  .ynab-hint { font-size: 10px; color: ${C.statLabel}; font-style: italic; }
  .ynab-dlg-status { font-size: 12px; color: ${C.statLabel}; min-height: 16px; }
  .ynab-dlg-btns { display: flex; justify-content: flex-end; gap: 8px; }

  /* Settings modal — above dashboard backdrop so Filter Settings is usable while dash is open */
  .ynab-settings-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 100050;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .ynab-settings-modal {
    background: #1c1a16; border: 1px solid rgba(255,255,255,0.13); border-radius: 14px;
    width: 540px; max-width: 94vw; max-height: 80vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 70px rgba(0,0,0,0.6);
  }
  .ynab-settings-header {
    display: flex; align-items: center; gap: 10px;
    padding: 18px 20px 0; flex-shrink: 0;
  }
  .ynab-settings-title { font-size: 15px; font-weight: 700; color: #e8e0d0; flex: 1; }
  .ynab-settings-close {
    background: none; border: none; color: #8a7e6a; font-size: 18px;
    cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1;
  }
  .ynab-settings-close:hover { color: #e8e0d0; background: rgba(255,255,255,0.07); }
  .ynab-settings-tabs {
    display: flex; gap: 0; padding: 14px 20px 0; flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }
  .ynab-stab {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: #8a7e6a; font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; padding: 6px 14px 8px; cursor: pointer; transition: all 0.12s;
  }
  .ynab-stab.active { color: #3d8f58; border-bottom-color: #3d8f58; }
  .ynab-stab:hover:not(.active) { color: #e8e0d0; }
  .ynab-settings-search {
    margin: 12px 20px 0; padding: 7px 12px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10);
    border-radius: 6px; color: #e8e0d0; font-size: 12px; flex-shrink: 0;
    box-sizing: border-box; width: calc(100% - 40px);
  }
  .ynab-settings-search:focus { outline: none; border-color: rgba(30,92,53,0.5); }
  .ynab-settings-list {
    flex: 1; overflow-y: auto; padding: 8px 12px 16px; margin: 6px 8px 0;
  }
  .ynab-settings-list::-webkit-scrollbar { width: 4px; }
  .ynab-settings-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
  .ynab-scheck-row {
    display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px;
    cursor: pointer; transition: background 0.1s;
  }
  .ynab-scheck-row:hover { background: rgba(255,255,255,0.05); }
  .ynab-scheck {
    width: 15px; height: 15px; border-radius: 3px; flex-shrink: 0; cursor: pointer;
    border: 1.5px solid rgba(255,255,255,0.25); background: transparent;
    appearance: none; -webkit-appearance: none; position: relative;
    transition: all 0.12s;
  }
  .ynab-scheck:checked { background: #1e5c35; border-color: #1e5c35; }
  .ynab-scheck:checked::after {
    content: ''; position: absolute; left: 3px; top: 0px;
    width: 5px; height: 9px; border: 2px solid #e8e0d0;
    border-top: none; border-left: none; transform: rotate(45deg);
  }
  .ynab-scheck-label { font-size: 12px; color: #e8e0d0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ynab-scheck-amount { font-size: 11px; color: #8a7e6a; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .ynab-settings-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.07); flex-shrink: 0; gap: 10px;
  }
  .ynab-settings-summary { font-size: 11px; color: #8a7e6a; }
  .ynab-settings-footer-btns { display: flex; gap: 8px; }
  /* Settings gear button */
  .ynab-gear-btn {
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09);
    border-radius: 5px; color: #8a7e6a; font-size: 11px; padding: 2px 8px;
    cursor: pointer; transition: all 0.12s; white-space: nowrap; line-height: 1.5;
  }
  .ynab-gear-btn:hover { background: rgba(255,255,255,0.10); color: #e8e0d0; }
  .ynab-filter-summary { font-size: 10px; color: #6e6458; font-style: italic; padding: 2px 0; }

  /* Config prompt */
  .ynab-cfg-prompt { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 24px; text-align: center; }
  .ynab-cfg-icon { font-size: 48px; opacity: 0.45; }
  .ynab-cfg-title { font-size: 18px; font-weight: 600; color: ${C.text}; }
  .ynab-cfg-sub { font-size: 13px; color: ${C.statLabel}; }

  .ynab-dash-backdrop {
    position: fixed; inset: 0; z-index: 99998;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 24px 16px; overflow: auto;
    background: rgba(0,0,0,0.62);
    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  }
  .ynab-dash-card {
    width: min(1200px, 100%); max-height: calc(100vh - 48px);
    display: flex; flex-direction: column; border-radius: 12px;
    color: ${C.text}; background: rgba(28, 26, 22, 0.92);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 20px 60px rgba(0,0,0,0.55);
    -webkit-backdrop-filter: blur(24px) saturate(1.45);
    backdrop-filter: blur(24px) saturate(1.45);
  }
  .ynab-dash-head {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 20px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0;
  }
  .ynab-dash-head h2 { margin: 0; font-size: 18px; font-weight: 700; color: ${C.text}; }
  .ynab-dash-body { overflow: auto; flex: 1; min-height: 0; padding: 0 4px 12px; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// PLUGIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True if `document.activeElement` is a typeable element inside `container` —
 * input / textarea / select / contenteditable. We use this to *defer* dashboard
 * re-renders while the user is mid-type so we don’t blow away their cursor and
 * focus on every plugin-backend `onRefresh`. Buttons / checkboxes / radios are
 * intentionally skipped so a click toggle still re-renders immediately.
 */
function _ynabIsUserEditingInside(container) {
  if (!container) return false;
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || a === document.body) return false;
  if (!container.contains(a)) return false;
  const tag = a.tagName;
  if (tag === 'INPUT') {
    const type = String(a.type || '').toLowerCase();
    if (
      type === 'checkbox' ||
      type === 'radio' ||
      type === 'button' ||
      type === 'submit' ||
      type === 'reset' ||
      type === 'file'
    ) {
      return false;
    }
    return true;
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable === true;
}

/**
 * Wrap a view object so missing `on*` lifecycle hooks return a no-op instead of throwing.
 * Without this, Thymer core's `view.onKeyboardNavigation()` / `onFocus()` / `onBlur()` /
 * `onPanelResize()` calls throw `TypeError` on every keystroke and mouse event when those
 * hooks aren't implemented, which fires `window.onerror` 30+ times per second and stalls
 * the main thread (each error → sync localStorage write in the diag runtime).
 */
function _ynabThymerNoop() {}
function _ynabStubViewMethods(view) {
  if (!view || typeof view !== 'object') return view;
  return new Proxy(view, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^on[A-Z]/.test(prop)) return _ynabThymerNoop;
      return undefined;
    },
  });
}

class DawnYnab {
  constructor(app) {
    this.ui = app.ui;
    this.data = app.data;
    this.events = app.events;
    this._host = app;
    this._ynabCollsKey = null;
    this._ynabCollsResolved = false;
    this._ynabTxnColl = null;
    this._dashBackdrop = null;
    this._dashRefreshTimer = null;
    this._ynabUiCssInstalled = false;
    this._ynabDashRenderGen = 0;
  }

  getConfiguration() {
    try {
      return this._host.getConfiguration?.() || {};
    } catch (_) {
      return {};
    }
  }

  _ynabCollName(c) {
    try { return String(c?.getName?.() || c?.name || '').trim(); } catch (_) { return ''; }
  }

  _ynabCollGuid(c) {
    try { return String(c?.guid || c?.getGuid?.() || ''); } catch (_) { return ''; }
  }

  _isYnabTxnCollection(c) {
    if (!c) return false;
    const guid = this._ynabCollGuid(c);
    if (guid && guid === YNAB_COLLECTION_GUID) return true;
    return this._ynabCollName(c).toLowerCase() === YNAB_COLLECTION_NAME.toLowerCase();
  }

  async _listCollections() {
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    let collections = [];
    try {
      if (boot?.getAllCollections) collections = (await boot.getAllCollections(this.data)) || [];
    } catch (_) {}
    if (!collections.length) {
      try { collections = (await this.data.getAllCollections?.()) || []; } catch (_) {}
    }
    return collections || [];
  }

  async _findYnabTxnCollection() {
    const list = await this._listCollections();
    let coll = (list || []).find((c) => this._isYnabTxnCollection(c)) || null;
    if (coll) return coll;
    try {
      coll = this.data.getPluginByGuid?.(YNAB_COLLECTION_GUID) || this.data.getCollection?.(YNAB_COLLECTION_GUID) || null;
    } catch (_) { coll = null; }
    if (this._isYnabTxnCollection(coll) || coll) return coll;
    return null;
  }

  async _ensureYnabTxnCollection() {
    let key = '';
    try {
      key = String(this.data.getActiveUsers?.()?.[0]?.workspaceGuid || '');
    } catch (_) {}
    if (this._ynabCollsKey === key && this._ynabCollsResolved && this._ynabTxnColl) return this._ynabTxnColl;
    const coll = await this._findYnabTxnCollection();
    this._ynabTxnColl = coll;
    this._ynabCollsKey = key;
    this._ynabCollsResolved = !!coll;
    return coll;
  }

  attach() {
    globalThis.__ynabPluginSettingsPlugin = this;
    globalThis.__ynabBusinessPlugin = this;
    try {
      globalThis.__dawnYnab = {
        plugin: this,
        incomeSummary: (dayKey) => this._dashIncomeSummary(dayKey),
      };
    } catch (_) {}
    this._mountJournalIncomeWidget = true;
    this._panelStates    = new Map();
    this._eventIds       = [];
    this._chartInstances = new Map();
    this._ynNavTimers    = new Map();
    this._unregTab = null;
    this._ynabPathBReadyPromise = null;
    ynabCopyProdLsIfEmpty();

    if (!this._ynabUiCssInstalled) {
      try {
        this.ui.injectCSS(CSS);
        this._ynabUiCssInstalled = true;
      } catch (_) {
        this._ynabUiCssInstalled = false;
      }
    }

    this._cmdOpenDash = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Open dashboard', icon: 'ti-dashboard',
      onSelected: () => void this.openDashboardModal(),
    });
    this._cmdSync = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Sync Transactions Now', icon: 'ti-refresh',
      onSelected: () => void this._syncAll(true),
    });
    this._cmdCfg = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Configure Token & Budget', icon: 'ti-settings',
      onSelected: () => void this._showConfigDialog(),
    });

    this._waitForShell((shell) => {
      try {
        this._unregTab = (shell.registerTab || shell.registerAddon).call(shell, {
          id: 'ynab',
          label: 'YNAB',
          icon: 'ti-coin',
          mode: 'inline',
          order: 10,
          mount: (el) => this._mountJhsTab(el),
          onDay: (dayLabel, meta) => this._onJhsDay(dayLabel, meta || {}),
          onExpand: (expanded) => {
            this._syncJhsHeaderControls(!!expanded && this._jhsTabActive);
            if (expanded) void this._populateJhsFromCache();
          },
          onTab: (active) => {
            this._jhsTabActive = !!active;
            this._syncJhsHeaderControls(!!active);
            if (active) void this._populateJhsFromCache();
          },
        });
      } catch (e) {
        console.warn('[Dawn/YNAB] registerTab', e);
      }
    });
  }

  _waitForShell(cb) {
    let n = 0;
    const tick = () => {
      const shell = globalThis.__dawnJhsShell;
      if (shell?.registerTab || shell?.registerAddon) {
        cb(shell);
        return;
      }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 40);
    };
    tick();
  }

  _parseDayKey(meta, dayLabel) {
    const key = String(meta?.dayKey || '').trim();
    let m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) {
      const raw = String(dayLabel || '').replace(/\D/g, '');
      if (raw.length >= 8) m = [null, raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8)];
    }
    if (!m) {
      const d = new Date();
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        yyyymmdd: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
      };
    }
    return {
      year: +m[1],
      month: +m[2],
      day: +m[3],
      yyyymmdd: `${m[1]}${m[2]}${m[3]}`,
    };
  }

  _mountJhsTab(el) {
    this._jhsHost = el;
    if (!el) return;
    el.innerHTML = '';
    const jd = this._jhsDay || this._parseDayKey({}, null);
    const state = {
      panelId: 'jhs',
      panel: null,
      recordGuid: null,
      ...jd,
      rootEl: null,
      observer: null,
      loaded: false,
      loading: false,
      _pendingPopulateWidget: false,
    };
    this._panelStates.set('jhs', state);
    state.rootEl = this._buildJhsWidget(state);
    el.appendChild(state.rootEl);
    this._jhsTabActive = true;
    this._syncJhsHeaderControls(true);
    void this._populateJhsFromCache();
  }

  _buildJhsWidget(state) {
    const root = document.createElement('div');
    root.className = 'ynab-widget';
    root.dataset.panelId = state.panelId;
    const body = document.createElement('div');
    body.className = 'ynab-widget-body';
    const statRow = document.createElement('div');
    statRow.className = 'ynab-stat-row';
    statRow.dataset.role = 'stats';
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'ynab-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'chart';
    canvas.height = 140;
    canvasWrap.appendChild(canvas);
    const statusEl = document.createElement('div');
    statusEl.className = 'ynab-status';
    statusEl.dataset.role = 'status';
    body.append(statRow, canvasWrap, statusEl);
    const cfgHost = document.createElement('div');
    cfgHost.dataset.role = 'ynab-cfg-host';
    body.appendChild(cfgHost);
    root.appendChild(body);
    this._paintJhsCfgPrompt(state);
    return root;
  }

  _ynabIsConfigured() {
    return !!(ls(SK.TOKEN) && ls(SK.BUDGET_ID));
  }

  _paintJhsCfgPrompt(state) {
    const host = state?.rootEl?.querySelector?.('[data-role="ynab-cfg-host"]');
    if (!host) return;
    host.innerHTML = '';
    if (this._ynabIsConfigured()) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.appendChild(this._cfgPrompt());
  }

  _syncJhsHeaderControls(visible) {
    const shell = globalThis.__dawnJhsShell;
    const host = shell?.getHeaderExtra?.();
    if (!host) return;
    if (!visible) {
      host.innerHTML = '';
      try {
        shell.syncHeaderExtra?.();
      } catch (_) {}
      return;
    }
    const state = this._panelStates.get('jhs');
    if (!state) return;
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'jhs-ynab-controls';
    const period = ls(SK.WIDGET_PERIOD) || 'weekly';
    const ctype = ls(SK.WIDGET_CHART) || 'bar';
    const left = document.createElement('div');
    left.className = 'jhs-ynab-controls-left';
    left.append(
      this._tgroup(
        [
          ['daily', 'Daily'],
          ['weekly', 'Weekly'],
          ['monthly', 'Monthly'],
        ],
        SK.WIDGET_PERIOD,
        period,
        () => this._populateWidget(this._panelStates.get('jhs'))
      ),
      this._tgroup(
        [
          ['bar', '▊ Bar'],
          ['line', '╱ Line'],
        ],
        SK.WIDGET_CHART,
        ctype,
        () => this._populateWidget(this._panelStates.get('jhs'))
      )
    );
    const right = document.createElement('div');
    right.className = 'jhs-ynab-controls-right';
    right.append(this._optGroup(state));
    wrap.append(left, right);
    host.appendChild(wrap);
    try {
      shell.syncHeaderExtra?.();
    } catch (_) {}
  }

  _dashIncomeSummary(dayKey) {
    const raw = lsJson(SK.CACHE_TXN, null);
    const txns = Array.isArray(raw)
      ? raw.map((t) => (t && t.date ? { ...t, date: ymd(t.date) } : t))
      : [];
    const income = txns.filter((t) => isIncomeTransaction(t, txns));
    const m = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const ref = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0)
      : new Date();
    const money = (n) => {
      const v = Number(n) || 0;
      const sign = v < 0 ? '-' : '';
      return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    };
    const vs = (cur, prev) => {
      if (prev == null || !Number.isFinite(prev)) return '—';
      const d = cur - prev;
      const sign = d > 0 ? '+' : '';
      return `${sign}${money(d)} vs last`;
    };
    const daily = bucketData(income, ref, 'daily', true, true);
    const weekly = bucketData(income, ref, 'weekly', true, true);
    const monthly = bucketData(income, ref, 'monthly', true, true);
    return {
      today: {
        label: 'Today',
        total: daily.curTotal || 0,
        avg: daily.avg || 0,
        vs: vs(daily.curTotal || 0, daily.prevTotal),
      },
      week: {
        label: 'This week',
        total: weekly.curTotal || 0,
        avg: weekly.avg || 0,
        vs: vs(weekly.curTotal || 0, weekly.prevTotal),
      },
      month: {
        label: 'This month',
        total: monthly.curTotal || 0,
        avg: monthly.avg || 0,
        vs: vs(monthly.curTotal || 0, monthly.prevTotal),
      },
    };
  }

  _onJhsDay(dayLabel, meta) {
    this._jhsDay = this._parseDayKey(meta, dayLabel);
    const state = this._panelStates.get('jhs');
    if (!state) return;
    Object.assign(state, this._jhsDay);
    // Cache paint only — Chart.js / API stay on expand / tab.
  }

  async _populateJhsFromCache() {
    void this._ynabEnsurePathBReady();
    const state = this._panelStates.get('jhs');
    if (!state?.rootEl) return;
    if (this._jhsDay) Object.assign(state, this._jhsDay);
    this._paintJhsCfgPrompt(state);
    await this._populateWidget(state);
  }

  _ynabEnsurePathBReady() {
    if (this._ynabPathBReadyPromise) return this._ynabPathBReadyPromise;
    this._ynabPathBReadyPromise = this._ynabRunDeferredPathB().catch(() => {});
    return this._ynabPathBReadyPromise;
  }

  async _ynabRunDeferredPathB() {
    try {
      const api = globalThis.ThymerPluginSettings;
      if (!api?.init || (api.__pathBStub && !api.__dawnPathBHost)) {
        ynabCopyProdLsIfEmpty();
        return;
      }
      await api.init({
        plugin: this._host || this,
        pluginId: 'ynab',
        label: 'YNAB',
        data: this.data,
        ui: this.ui,
        mirrorKeys: SK_PATHB_MIRROR,
        awaitHydrate: false,
        onHydrated: () => {
          ynabCopyProdLsIfEmpty();
          this._paintJhsCfgPrompt(this._panelStates.get('jhs'));
          void this._populateJhsFromCache();
        },
      });
      const host = this._host || this;
      host._pluginSettingsPluginId = 'ynab';
      host._pluginSettingsSyncMode = 'synced';
      this._pluginSettingsPluginId = 'ynab';
      this._pluginSettingsSyncMode = 'synced';
    } catch (e) {
      try {
        console.warn('[YNAB] Path B init', e);
      } catch (_) {}
    }
    ynabCopyProdLsIfEmpty();
  }

  detach() {
    if (globalThis.__ynabBusinessPlugin === this) globalThis.__ynabBusinessPlugin = undefined;
    if (globalThis.__ynabPluginSettingsPlugin === this) globalThis.__ynabPluginSettingsPlugin = undefined;
    try {
      if (globalThis.__dawnYnab?.plugin === this) globalThis.__dawnYnab = undefined;
    } catch (_) {}
    this._closeDashboardModal();
    try { this._unregTab?.(); } catch (_) {}
    this._unregTab = null;
    this._jhsTabActive = false;
    this._syncJhsHeaderControls(false);
    this._ynabUiCssInstalled = false;
    this._ynabCollsKey = null;
    this._ynabCollsResolved = false;
    this._ynabTxnColl = null;
    for (const id of (this._eventIds || [])) { try { this.events.off(id); } catch {} }
    this._eventIds = [];
    for (const t of (this._ynNavTimers || new Map()).values()) { try { clearTimeout(t); } catch {} }
    this._ynNavTimers?.clear();
    this._cmdOpenDash?.remove?.();
    this._cmdSync?.remove?.();
    this._cmdCfg?.remove?.();
    this._cmdStorage?.remove?.();
    this._cmdJournalWidgetOn?.remove?.();
    this._cmdJournalWidgetOff?.remove?.();
    this._cmdJournalWidgetClear?.remove?.();
    for (const [pid] of (this._panelStates || new Map())) this._disposePanel(pid);
    this._panelStates?.clear();
    this._dashRefreshers?.clear();
    for (const [, ch] of (this._chartInstances || new Map())) { try { ch.destroy(); } catch {} }
    this._chartInstances?.clear();
  }

  /**
   * Prefer YNAB collection rows (what the Income vs Expenses view shows). Fall back
   * to API cache / live fetch when the collection is empty or unreadable.
   */
  async _loadDashTxns(forceApi = false) {
    // Dawn: LS/API cache only — never getAllRecords the YNAB collection on open.
    if (!forceApi && this._lastSyncTxns?.length) return this._lastSyncTxns;
    const apiTxns = await getTransactions(!!forceApi);
    this._lastSyncTxns = apiTxns;
    return apiTxns;
  }

  // ── Dashboard view ──────────────────────────────────────────────────────────

  _closeDashboardModal() {
    globalThis.__thymerDiag?.record?.('YNAB_PANEL_CLOSE');
    if (this._dashRefreshTimer != null) {
      try { clearTimeout(this._dashRefreshTimer); } catch (_) {}
      this._dashRefreshTimer = null;
    }
    try { this._dashRefreshers?.delete('modal'); } catch (_) {}
    try { this._dashBackdrop?.remove?.(); } catch (_) {}
    this._dashBackdrop = null;
  }

  async openDashboardModal() {
    if (this._dashBackdrop) return;
    void this._ynabEnsurePathBReady();
    globalThis.__thymerDiag?.record?.('YNAB_PANEL_OPEN');
    const self = this;
    const backdrop = document.createElement('div');
    backdrop.className = 'ynab-dash-backdrop';
    const card = document.createElement('div');
    card.className = 'ynab-dash-card';
    const head = document.createElement('div');
    head.className = 'ynab-dash-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'YNAB';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ynab-btn';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => self._closeDashboardModal());
    head.appendChild(h2);
    head.appendChild(closeBtn);
    card.appendChild(head);
    const container = document.createElement('div');
    container.className = 'ynab-dash-body';
    card.appendChild(container);
    backdrop.appendChild(card);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) self._closeDashboardModal();
    });
    document.body.appendChild(backdrop);
    this._dashBackdrop = backdrop;

    const tick = () => {
      this._dashRefreshTimer = null;
      if (!container) return;
      if (_ynabIsUserEditingInside(container)) {
        globalThis.__thymerDiag?.record?.('YNAB_PANEL_REFRESH_DEFERRED_TYPING');
        this._dashRefreshTimer = setTimeout(tick, 1200);
        return;
      }
      void this._renderDash(container);
    };
    const debouncedRefresh = () => {
      globalThis.__thymerDiag?.record?.('YNAB_PANEL_REFRESH_FIRED');
      if (this._dashRefreshTimer != null) clearTimeout(this._dashRefreshTimer);
      this._dashRefreshTimer = setTimeout(tick, 400);
    };
    if (!this._dashRefreshers) this._dashRefreshers = new Map();
    this._dashRefreshers.set('modal', debouncedRefresh);
    void this._renderDash(container);
  }

  /**
   * Atomic, non-destructive dashboard render.
   *  - First render shows a “Preparing…” spinner so the user knows something’s happening.
   *  - **Subsequent renders keep the existing DOM visible** while the new tree is built,
   *    then swap with `replaceChildren()` in one shot. No more wiping date inputs out
   *    from under your fingers, no more flicker on every Plugin Backend write.
   *  - `gen` is a generation counter — if a newer render starts before this one
   *    finishes its async work, we abort the older one before any DOM swap.
   */
  async _renderDash(container) {
    const gen = ++this._ynabDashRenderGen;
    const diag = globalThis.__thymerDiag;
    const diagStart = diag ? Date.now() : 0;
    diag?.record?.('YNAB_RENDER_START', { gen });
    /** Only the very first render gets the loading placeholder. */
    const isFirstRender = container.childElementCount === 0;
    if (isFirstRender) {
      const placeholder = document.createElement('div');
      placeholder.className = 'ynab-dash-loading';
      placeholder.textContent = 'Preparing…';
      container.replaceChildren(placeholder);
    }
    if (!ls(SK.TOKEN) || !ls(SK.BUDGET_ID)) {
      if (gen !== this._ynabDashRenderGen) return;
      container.replaceChildren(this._cfgPrompt());
      return;
    }
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (gen !== this._ynabDashRenderGen) return;
      if (isFirstRender) {
        const loadEl = container.querySelector('.ynab-dash-loading');
        if (loadEl) loadEl.textContent = 'Loading chart library…';
      }
      await loadChartJs();
      if (gen !== this._ynabDashRenderGen) return;
      if (isFirstRender) {
        const loadEl = container.querySelector('.ynab-dash-loading');
        if (loadEl) loadEl.textContent = 'Loading transactions…';
      }
      const txns = await this._loadDashTxns(false);
      if (gen !== this._ynabDashRenderGen) return;
      /**
       * One more “user editing?” check right before the swap — `_renderDash` may
       * have been kicked off before the user grabbed an input. If they’re typing
       * now, abort the swap; the panel’s debounce loop will retry shortly.
       */
      if (_ynabIsUserEditingInside(container)) {
        diag?.record?.('YNAB_RENDER_ABORT_TYPING', { gen });
        return;
      }
      const newDash = this._buildDash(txns);
      if (gen !== this._ynabDashRenderGen) return;
      container.replaceChildren(newDash);
      diag?.record?.('YNAB_RENDER_END', {
        gen,
        ms: diag ? Date.now() - diagStart : 0,
        txns: Array.isArray(txns) ? txns.length : 0,
      });
    } catch (e) {
      diag?.record?.('YNAB_RENDER_ERROR', {
        gen,
        ms: diag ? Date.now() - diagStart : 0,
        err: String(e?.message || e).slice(0, 200),
      });
      if (gen !== this._ynabDashRenderGen) return;
      const errEl = document.createElement('div');
      errEl.className = 'ynab-dash-error';
      errEl.textContent = `Error: ${e.message}`;
      container.replaceChildren(errEl);
    }
  }

  _buildDash(allTxns) {
    const now = new Date();
    const oldest = oldestTxnYmd(allTxns);
    const thisMonthPreset = presets(oldest)[0];
    let fromVal = ls(SK.DASH_FROM) || thisMonthPreset.from;
    const toVal   = ls(SK.DASH_TO)   || thisMonthPreset.to;
    // Migrate stale "All Time" epochs (e.g. 2000-01-01) to the real oldest txn.
    if (oldest && fromVal && fromVal < oldest) {
      fromVal = oldest;
      lsSet(SK.DASH_FROM, fromVal);
    }

    const wrap = document.createElement('div');
    wrap.className = 'ynab-dash';

    // ── Date range row ──
    const rangeRow = document.createElement('div');
    rangeRow.className = 'ynab-range-row';
    const presetGroup = document.createElement('div');
    presetGroup.className = 'ynab-preset-group';
    const customRange = document.createElement('div');
    customRange.className = 'ynab-custom-range';
    const fromInput = document.createElement('input'); fromInput.type='date'; fromInput.className='ynab-date-input'; fromInput.value=fromVal;
    const toInput   = document.createElement('input'); toInput.type='date';   toInput.className='ynab-date-input'; toInput.value=toVal;
    const rangeSep  = document.createElement('span'); rangeSep.textContent='→';
    customRange.append(fromInput, rangeSep, toInput);

    let activePreset = null;
    const ps = presets(oldest);
    for (const p of ps) { if (p.from===fromVal && p.to===toVal) { activePreset=p.label; break; } }

    const applyPreset = (p) => {
      activePreset=p.label; fromInput.value=p.from; toInput.value=p.to;
      lsSet(SK.DASH_FROM, p.from); lsSet(SK.DASH_TO, p.to);
      presetGroup.querySelectorAll('.ynab-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.label===p.label));
      rebuild();
    };
    for (const p of ps) {
      const btn=document.createElement('button'); btn.type='button';
      btn.className=`ynab-preset-btn${activePreset===p.label?' active':''}`; btn.textContent=p.label; btn.dataset.label=p.label;
      btn.addEventListener('click', ()=>applyPreset(p));
      presetGroup.appendChild(btn);
    }
    const onDateChange = () => {
      activePreset=null; lsSet(SK.DASH_FROM,fromInput.value); lsSet(SK.DASH_TO,toInput.value);
      presetGroup.querySelectorAll('.ynab-preset-btn').forEach(b=>b.classList.remove('active'));
      rebuild();
    };
    fromInput.addEventListener('change', onDateChange);
    toInput.addEventListener('change', onDateChange);
    rangeRow.append(presetGroup, customRange);
    wrap.appendChild(rangeRow);

    // ── Action row ──
    const actionRow=document.createElement('div'); actionRow.className='ynab-action-row';
    const syncBtn=document.createElement('button'); syncBtn.type='button'; syncBtn.className='ynab-btn ynab-btn-primary'; syncBtn.textContent='↻ Sync Now';
    syncBtn.addEventListener('click', ()=>this._syncAll(true));
    /**
     * Manual repaint button. Thymer's `onRefresh` is now a no-op (see `_dashboardView`)
     * so this is the user-facing way to recompute the dashboard from cached transactions
     * after, say, changing settings outside this panel or just wanting a fresh paint.
     */
    const refreshBtn=document.createElement('button'); refreshBtn.type='button'; refreshBtn.className='ynab-btn'; refreshBtn.textContent='⟳ Refresh';
    refreshBtn.title = 'Recompute the dashboard from cached transactions and current settings';
    refreshBtn.addEventListener('click', ()=>this._fireDashRefreshers());
    const exportBtn=document.createElement('button'); exportBtn.type='button'; exportBtn.className='ynab-btn'; exportBtn.textContent='⬇ Export CSV';
    exportBtn.addEventListener('click', ()=>this._exportCSV(allTxns, fromInput.value, toInput.value, lsJson(SK.EXCLUDED_GROUPS, DEFAULT_EXCLUDED)));
    actionRow.append(syncBtn, refreshBtn, exportBtn);
    wrap.appendChild(actionRow);

    // ── Filter row — gear button opens settings modal ──
    const filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
    const gearBtn = document.createElement('button');
    gearBtn.className = 'ynab-btn ynab-btn-primary'; gearBtn.textContent = '⚙ Filter Settings';
    const filterSummaryEl = document.createElement('span');
    filterSummaryEl.className = 'ynab-filter-summary';
    filterRow.append(gearBtn, filterSummaryEl);
    wrap.appendChild(filterRow);

    const updateFilterSummary = () => {
      const raw = ls(SK.INCL_PAYEES);
      const allIncomePayers = [...new Set(allTxns.filter(t=>t.type==='income').map(t=>t.payee))];
      const inclCount = raw ? JSON.parse(raw).length : allIncomePayers.filter(p=>!['transfer','starting'].some(kw=>p.toLowerCase().includes(kw))).length;
      const exclGroups = lsJson(SK.EXCLUDED_GROUPS, DEFAULT_EXCLUDED);
      const from = ymd(fromInput.value), to = ymd(toInput.value);
      const inRange = allTxns.filter(t => inYmdRange(t.date, from, to)).length;
      filterSummaryEl.textContent = `${allTxns.length} txns loaded · ${inRange} in range · ${inclCount} income payees · ${exclGroups.length} expense groups excluded`;
    };
    updateFilterSummary();
    gearBtn.addEventListener('click', () => {
      this._showFilterSettings(allTxns, () => { updateFilterSummary(); rebuild(); });
    });

    // ── Stat cards ──
    const statsEl=document.createElement('div'); statsEl.className='ynab-stat-cards';
    wrap.appendChild(statsEl);

    // ── Secondary row: Wages + Draw (unfiltered) ──
    const secondaryEl=document.createElement('div'); secondaryEl.className='ynab-secondary-row';
    wrap.appendChild(secondaryEl);

    // ── Single cashflow chart (period / avg / compare + income & expenses) ──
    const chartSection = document.createElement('div');
    const chartTitle = document.createElement('div');
    chartTitle.className = 'ynab-section-title';
    const chartControls = document.createElement('div');
    chartControls.className = 'ynab-dash-trends-controls';
    const chartChips = document.createElement('div');
    chartChips.className = 'ynab-stat-row';
    const chartWrap = document.createElement('div');
    chartWrap.className = 'ynab-dash-chart-wrap';
    const canvas = document.createElement('canvas');
    chartWrap.appendChild(canvas);
    chartSection.append(chartTitle, chartControls, chartChips, chartWrap);
    wrap.appendChild(chartSection);

    const period0 = ls(SK.WIDGET_PERIOD) || 'weekly';
    const ctype0 = ls(SK.WIDGET_CHART) || 'bar';
    const refreshChartOnly = () => { rebuildChart(); };
    chartControls.append(
      this._tgroup([['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']], SK.WIDGET_PERIOD, period0, refreshChartOnly),
      this._tgroup([['bar', '▊ Bar'], ['line', '╱ Line']], SK.WIDGET_CHART, ctype0, refreshChartOnly),
      (() => {
        const g = document.createElement('div');
        g.className = 'ynab-tgroup';
        g.append(
          this._optBtn('⇄ vs Last', SK.WIDGET_COMPARE, refreshChartOnly),
          this._optBtn('~ Avg', SK.WIDGET_AVG, refreshChartOnly),
        );
        return g;
      })(),
    );

    // ── Group totals ──
    const groupWrap=document.createElement('div'); wrap.appendChild(groupWrap);

    let dashChart=null;
    const taxesRef = { fn: null }; // ref to rebuildTaxes, set after declaration
    const self = this;

    const rebuildChart = () => {
      const from = ymd(fromInput.value), to = ymd(toInput.value);
      const ex = lsJson(SK.EXCLUDED_GROUPS, DEFAULT_EXCLUDED);
      const isIncluded = t => isIncomeTransaction(t, allTxns);
      const rangeTxns = allTxns.filter(t => inYmdRange(t.date, from, to));
      const period = ls(SK.WIDGET_PERIOD) || 'weekly';
      const compare = ls(SK.WIDGET_COMPARE) === 'true';
      const showAvg = ls(SK.WIDGET_AVG) === 'true';
      const ctype = ls(SK.WIDGET_CHART) || 'bar';

      const { keys, labels, grain, windowNote } = buildRangeBuckets(from, to, period);
      const preferLabel = ({ daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' })[period] || 'Monthly';
      const grainLabel = ({ day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' })[grain] || preferLabel;
      const incByBucket = keys.map(k => rangeTxns.filter(t => isIncluded(t) && txnInRangeBucket(t, k, grain)).reduce((a, t) => a + t.amount, 0));
      const expByBucket = keys.map(k => rangeTxns.filter(t => t.type === 'expense' && !ex.includes(t.category_group) && txnInRangeBucket(t, k, grain)).reduce((a, t) => a + Math.abs(t.amount), 0));

      // Journal-style chips for the active period window (relative to range end)
      const incomeTxns = allTxns.filter(t => isIncluded(t));
      const refRaw = to || dateStr(new Date());
      const refDate = new Date(`${refRaw}T12:00:00`);
      const safeRef = Number.isNaN(refDate.getTime()) ? new Date() : refDate;
      const { curTotal, prevTotal, avg } = bucketData(incomeTxns, safeRef, period, compare, showAvg);

      chartChips.innerHTML = '';
      const toIsToday = refRaw === dateStr(new Date());
      const pl = {
        daily: toIsToday ? 'Today' : 'End day',
        weekly: 'End week',
        monthly: 'End month',
      }[period];
      chartChips.appendChild(self._chip(pl + ' Income', curTotal));
      if (compare && prevTotal !== null) {
        const diff = curTotal - prevTotal;
        chartChips.append(self._chip('vs Last', prevTotal), self._chip('Δ', diff, diff >= 0 ? 'pos' : 'neg'));
      }
      if (showAvg && avg !== null) chartChips.appendChild(self._chip('Avg', avg));

      // Prior-year income overlay when Compare is on (same buckets, shifted −1 year)
      let prevInc = null;
      if (compare) {
        prevInc = keys.map((k) => allTxns.filter((t) => {
          if (!isIncluded(t) || !ymd(t.date)) return false;
          const d0 = ymd(t.date);
          const y = parseInt(d0.slice(0, 4), 10);
          if (!Number.isFinite(y)) return false;
          const asNextYear = `${y + 1}${d0.slice(4)}`;
          return asNextYear >= from && asNextYear <= to && txnInRangeBucket({ date: asNextYear }, k, grain);
        }).reduce((a, t) => a + t.amount, 0));
      }

      const nzInc = incByBucket.filter(v => v > 0);
      const avgLine = showAvg && nzInc.length ? nzInc.reduce((a, b) => a + b, 0) / nzInc.length : (showAvg ? 0 : null);

      const titleGrain = windowNote ? `${preferLabel} · ${windowNote}` : grainLabel;
      chartTitle.textContent = `Income & Expenses (${titleGrain}) — ${from} → ${to}`;
      if (dashChart) { try { dashChart.destroy(); } catch {} }

      const greenFill = ctype === 'line' ? `rgba(${C.greenRgb}, 0.12)` : `rgba(${C.greenRgb}, 0.75)`;
      const redFill = ctype === 'line' ? 'rgba(184,64,64,0.12)' : 'rgba(184,64,64,0.55)';
      const datasets = [
        {
          label: 'Income', data: incByBucket,
          backgroundColor: greenFill, borderColor: C.green, borderWidth: ctype === 'bar' ? 1 : 2,
          tension: 0.35, fill: ctype === 'line',
          pointRadius: ctype === 'line' ? 2 : 0, pointBackgroundColor: C.green,
          type: ctype,
        },
        {
          label: 'Expenses', data: expByBucket,
          backgroundColor: redFill, borderColor: '#b84040', borderWidth: ctype === 'bar' ? 1 : 2,
          tension: 0.35, fill: ctype === 'line',
          pointRadius: ctype === 'line' ? 2 : 0, pointBackgroundColor: '#b84040',
          type: ctype,
        },
      ];
      if (compare && prevInc) {
        datasets.push({
          label: 'Income −1y', data: prevInc, type: 'line',
          backgroundColor: 'transparent', borderColor: C.prevLine, borderWidth: 1.4,
          borderDash: [4, 4], tension: 0.35, fill: false, pointRadius: 0,
        });
      }
      if (showAvg && avgLine !== null) {
        datasets.push({
          label: 'Avg Income', data: Array(labels.length).fill(avgLine), type: 'line',
          borderColor: C.avgLine, borderWidth: 1.2, borderDash: [5, 3], pointRadius: 0, fill: false,
        });
      }

      dashChart = new window.Chart(canvas, {
        type: ctype,
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
          plugins: {
            legend: { labels: { color: C.axisText, font: { size: 10 }, boxWidth: 14 } },
            tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.parsed.y)}` } },
          },
          scales: {
            x: { ticks: { color: C.axisText, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 18 }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: C.axisText, font: { size: 10 }, callback: v => `$${v}` }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
          },
        },
      });
    };

    const rebuild = () => {
      const from=ymd(fromInput.value), to=ymd(toInput.value);
      const ex=lsJson(SK.EXCLUDED_GROUPS,DEFAULT_EXCLUDED);

      const isIncluded = t => isIncomeTransaction(t, allTxns);

      const rangeTxns   = allTxns.filter(t=>inYmdRange(t.date, from, to));
      const incomeAmt   = rangeTxns.filter(t=>isIncluded(t)).reduce((a,t)=>a+t.amount,0);
      const expenseAmt  = rangeTxns.filter(t=>t.type==='expense' && !ex.includes(t.category_group)).reduce((a,t)=>a+Math.abs(t.amount),0);
      const net         = incomeAmt - expenseAmt;

      // Wages and Draw — always unfiltered, calculated from specific category groups
      const wagesAmt = rangeTxns.filter(t=>t.type==='expense' && /wages/i.test(t.category_group)).reduce((a,t)=>a+Math.abs(t.amount),0);
      const drawAmt  = rangeTxns.filter(t=>t.type==='expense' && /owner.*draw|draw.*owner/i.test(t.category_group)).reduce((a,t)=>a+Math.abs(t.amount),0);

      // Stat cards — main 3 cards in flex row
      const cardsRow = document.createElement('div');
      cardsRow.style.display = 'flex';
      cardsRow.style.gap = '12px';
      cardsRow.style.flexWrap = 'wrap';
      cardsRow.style.marginBottom = '12px';
      cardsRow.style.width = '100%';
      cardsRow.append(
        this._bigCard('Income', incomeAmt, 'inc'),
        this._bigCard('Expenses', expenseAmt, 'exp'),
        this._bigCard('Net', net, net>=0?'net-pos':'net-neg'),
      );
      statsEl.innerHTML = '';
      statsEl.appendChild(cardsRow);

      // Secondary row — Wages + Draw, always visible regardless of filters
      secondaryEl.innerHTML='';
      if (wagesAmt > 0 || drawAmt > 0) {
        const makeChip = (label, amount) => {
          const c=document.createElement('div'); c.className='ynab-secondary-chip';
          c.innerHTML=`<div class="ynab-card-label">${label}</div><div class="ynab-card-value">${fmt(amount)}</div>`;
          return c;
        };
        if (wagesAmt > 0) secondaryEl.appendChild(makeChip('Wages', wagesAmt));
        if (drawAmt  > 0) secondaryEl.appendChild(makeChip("Owner's Draw", drawAmt));
      }

      rebuildChart();

      // Group totals — income by payee, expenses by group
      groupWrap.innerHTML='';

      // Income breakdown by payee
      const incTitle=document.createElement('div'); incTitle.className='ynab-section-title'; incTitle.textContent='Income by Payee';
      const incTbl=document.createElement('table'); incTbl.className='ynab-group-table';
      const incHdr=incTbl.insertRow();
      ['Payee','Total'].forEach(h=>{const th=document.createElement('th');th.textContent=h;incHdr.appendChild(th);});
      const payeeMap={};
      for (const t of rangeTxns.filter(t=>isIncluded(t))) {
        payeeMap[t.payee]=(payeeMap[t.payee]||0)+t.amount;
      }
      for (const [p,v] of Object.entries(payeeMap).sort((a,b)=>b[1]-a[1])) {
        const row=incTbl.insertRow(); row.insertCell().textContent=p;
        const c=row.insertCell(); c.textContent=fmt(v); c.className='ynab-amt-pos'; c.style.textAlign='right';
      }
      groupWrap.append(incTitle, incTbl);

      // Expense breakdown by category group
      const expTitle=document.createElement('div'); expTitle.className='ynab-section-title'; expTitle.style.marginTop='16px'; expTitle.textContent='Expenses by Category Group';
      const expTbl=document.createElement('table'); expTbl.className='ynab-group-table';
      const expHdr=expTbl.insertRow();
      ['Category Group','Total'].forEach(h=>{const th=document.createElement('th');th.textContent=h;expHdr.appendChild(th);});
      const groupMap={};
      for (const t of rangeTxns.filter(t=>t.type==='expense' && !ex.includes(t.category_group))) {
        groupMap[t.category_group]=(groupMap[t.category_group]||0)+Math.abs(t.amount);
      }
      for (const [g,v] of Object.entries(groupMap).sort((a,b)=>b-a)) {
        const row=expTbl.insertRow(); row.insertCell().textContent=g;
        const c=row.insertCell(); c.textContent=fmt(v); c.className='ynab-amt-neg'; c.style.textAlign='right';
      }
      groupWrap.append(expTitle, expTbl);

      // Taxes section follows the main date range
      if (taxesRef.fn) taxesRef.fn();
    };

    rebuild();

    // ── Taxes Paid collapsible section ──
    const taxesSection = document.createElement('div'); taxesSection.className='ynab-taxes-section';
    wrap.appendChild(taxesSection);

    const taxesHeader = document.createElement('div'); taxesHeader.className='ynab-taxes-header';
    const taxesToggle = document.createElement('span'); taxesToggle.className='ynab-taxes-toggle'; taxesToggle.textContent='−';
    const taxesTitle  = document.createElement('span'); taxesTitle.className='ynab-taxes-title'; taxesTitle.textContent='🏦 Taxes Paid';
    const taxesTotalEl= document.createElement('span'); taxesTotalEl.className='ynab-taxes-total';
    const taxesHeaderExportBtn = document.createElement('button');
    taxesHeaderExportBtn.type='button'; taxesHeaderExportBtn.className='ynab-btn';
    taxesHeaderExportBtn.textContent='⬇ Export'; taxesHeaderExportBtn.style.fontSize='11px'; taxesHeaderExportBtn.style.padding='3px 8px';
    taxesHeaderExportBtn.addEventListener('click', e => { e.stopPropagation(); taxesExportHandler(); });
    taxesHeader.append(taxesToggle, taxesTitle, taxesHeaderExportBtn, taxesTotalEl);
    taxesSection.appendChild(taxesHeader);

    const taxesBody = document.createElement('div'); taxesBody.className='ynab-taxes-body';
    taxesSection.appendChild(taxesBody);

    // Taxes date range — defaults to YTD
    // (export button is in the header)

    const taxesTableWrap = document.createElement('div');
    taxesBody.appendChild(taxesTableWrap);

    let taxesCollapsed = false;
    taxesHeader.addEventListener('click', () => {
      taxesCollapsed = !taxesCollapsed;
      taxesBody.style.display = taxesCollapsed ? 'none' : 'flex';
      taxesToggle.textContent = taxesCollapsed ? '+' : '−';
      taxesHeaderExportBtn.style.display = taxesCollapsed ? 'none' : '';
    });

    // rebuildTaxes reads from the main date inputs — called by rebuild() automatically
    const rebuildTaxes = () => {
      const tf = fromInput.value, tt = toInput.value;
      const taxTxns = allTxns.filter(t =>
        t.type === 'expense' &&
        /taxes?/i.test(t.category_group) &&
        inYmdRange(t.date, tf, tt)
      );
      const total = taxTxns.reduce((a,t) => a + Math.abs(t.amount), 0);
      taxesTotalEl.textContent = fmt(total);

      taxesTableWrap.innerHTML = '';
      if (taxTxns.length === 0) {
        taxesTableWrap.innerHTML = '<div style="font-size:12px;color:#8a7e6a;font-style:italic;">No tax transactions in this range.</div>';
        return;
      }
      const tbl = document.createElement('table'); tbl.className='ynab-group-table';
      const hdr = tbl.insertRow();
      ['Date','Payee','Category','Amount','Memo'].forEach(h=>{const th=document.createElement('th');th.textContent=h;hdr.appendChild(th);});
      for (const t of taxTxns.sort((a,b)=>b.date.localeCompare(a.date))) {
        const row=tbl.insertRow();
        row.insertCell().textContent=t.date;
        row.insertCell().textContent=t.payee;
        row.insertCell().textContent=t.category;
        const ac=row.insertCell(); ac.textContent=fmt(Math.abs(t.amount)); ac.className='ynab-amt-neg'; ac.style.textAlign='right';
        row.insertCell().textContent=t.memo;
      }
      taxesTableWrap.appendChild(tbl);
    };

    const taxesExportHandler = () => {
      const tf=fromInput.value, tt=toInput.value;
      const taxTxns = allTxns.filter(t=>t.type==='expense' && /taxes?/i.test(t.category_group) && inYmdRange(t.date, tf, tt));
      const rows = [['Date','Payee','Category','Amount','Memo','Period']];
      for (const t of taxTxns.sort((a,b)=>b.date.localeCompare(a.date))) {
        rows.push([t.date, t.payee, t.category, Math.abs(t.amount).toFixed(2), t.memo, `${tf} to ${tt}`]);
      }
      const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob=new Blob([csv],{type:'text/csv'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download=`ynab-taxes-${tf}-${tt}.csv`; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };

    taxesRef.fn = rebuildTaxes;
    rebuildTaxes();

    return wrap;
  }

  _bigCard(label, amount, cls) {
    const c = document.createElement('div'); c.className = `ynab-big-card ${cls}`;
    c.innerHTML = `<div class="ynab-card-label">${label}</div><div class="ynab-card-value">${fmt(Math.abs(amount))}</div>`;
    return c;
  }

  _cfgPrompt() {
    const w = document.createElement('div'); w.className = 'ynab-cfg-prompt';
    w.innerHTML = `<div class="ynab-cfg-icon">💰</div><div class="ynab-cfg-title">YNAB Not Configured</div><div class="ynab-cfg-sub">Add your Personal Access Token to sync your business budget.</div>`;
    const btn = document.createElement('button'); btn.type='button'; btn.className='ynab-btn ynab-btn-primary'; btn.textContent='⚙️ Configure YNAB';
    btn.addEventListener('click', () => this._showConfigDialog());
    w.appendChild(btn); return w;
  }

  // ── Journal widget ───────────────────────────────────────────────────────────

  _effectiveMountJournalIncomeWidget() {
    try {
      const o = localStorage.getItem(YNAB_JWIDGET_OVERRIDE_LS);
      if (o === 'on') return true;
      if (o === 'off') return false;
    } catch (_) {}
    return !!this._mountJournalIncomeWidget;
  }

  _refreshJournalWidgetPanelsAfterOverrideChange() {
    const ids = Array.from(this._panelStates?.keys?.() || []);
    for (const id of ids) this._disposePanel(id);
    try {
      const p = this.ui.getActivePanel?.() || this.ui.getCurrentPanel?.();
      if (p) requestAnimationFrame(() => this._handlePanel(p));
    } catch (_) {}
    setTimeout(() => {
      try {
        const p = this.ui.getActivePanel?.() || this.ui.getCurrentPanel?.();
        if (p) this._handlePanel(p);
      } catch (_) {}
    }, 80);
  }

  _deferHandlePanel(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;
    if (!this._effectiveMountJournalIncomeWidget()) {
      this._disposePanel(panelId);
      return;
    }
    const prev = this._ynNavTimers.get(panelId);
    if (prev) clearTimeout(prev);
    this._ynNavTimers.set(panelId, setTimeout(() => {
      this._ynNavTimers.delete(panelId);
      this._handlePanel(panel);
    }, 120));
  }

  _handlePanel(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;
    if (!this._effectiveMountJournalIncomeWidget()) {
      this._disposePanel(panelId);
      return;
    }
    const navType = panel?.getNavigation?.()?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') { this._disposePanel(panelId); return; }

    const panelEl = panel?.getElement?.();
    if (!panelEl) { this._disposePanel(panelId); return; }

    const container = this._findContainer(panelEl);
    if (!container) {
      let state = this._panelStates.get(panelId);
      if (!state) {
        state = {
          panelId, panel,
          recordGuid: null,
          yyyymmdd: null, year: null, month: null, day: null,
          rootEl: null, observer: null, loaded: false, loading: false,
          _pendingPopulateWidget: false,
          _containerWatcher: null,
        };
        this._panelStates.set(panelId, state);
        state._containerWatcher = new MutationObserver(() => {
          if (this._findContainer(panelEl)) {
            try { state._containerWatcher?.disconnect(); } catch {}
            state._containerWatcher = null;
            this._handlePanel(panel);
          }
        });
        try {
          state._containerWatcher.observe(panelEl, { childList: true, subtree: true });
        } catch (_) {
          state._containerWatcher = null;
          this._disposePanel(panelId);
        }
      }
      return;
    }

    const record = panel?.getActiveRecord?.();
    if (!record) { this._disposePanel(panelId); return; }
    const jd = journalDateFromRecord(record);
    if (!jd) { this._disposePanel(panelId); return; }

    let state = this._panelStates.get(panelId);
    const wasPlaceholder = state && (state.recordGuid == null || state.yyyymmdd == null);
    const dateChanged = state != null && state.yyyymmdd != null && state.yyyymmdd !== jd.yyyymmdd;
    const recordChanged = state != null && state.recordGuid != null && state.recordGuid !== record.guid;

    if (!state) {
      state = {
        panelId, panel, recordGuid: record.guid, ...jd,
        rootEl: null, observer: null, loaded: false, loading: false,
        _pendingPopulateWidget: false,
        _containerWatcher: null,
      };
      this._panelStates.set(panelId, state);
    } else {
      try { state._containerWatcher?.disconnect(); } catch {}
      state._containerWatcher = null;
      Object.assign(state, { panel, recordGuid: record.guid, ...jd });
      if (dateChanged || recordChanged || wasPlaceholder) state.loaded = false;
    }

    const rebuilt = this._mountWidget(state, container, panelEl);
    if (rebuilt) state.loading = false;

    const needPopulate = dateChanged || recordChanged || wasPlaceholder || !state.loaded || rebuilt;
    if (needPopulate) {
      if (state.loading) state._pendingPopulateWidget = true;
      else this._populateWidget(state);
    }
  }

  _disposePanel(panelId) {
    if (!panelId) return;
    const nt = this._ynNavTimers?.get(panelId);
    if (nt) { try { clearTimeout(nt); } catch {} this._ynNavTimers.delete(panelId); }
    const s = this._panelStates.get(panelId);
    if (!s) return;
    try { s.observer?.disconnect(); } catch {}
    try { s._containerWatcher?.disconnect(); } catch {}
    try { clearTimeout(s._navTimer); } catch {}
    try { s.rootEl?.remove(); }       catch {}
    const ch = this._chartInstances.get(panelId);
    if (ch) { try { ch.destroy(); } catch {} this._chartInstances.delete(panelId); }
    this._panelStates.delete(panelId);
  }

  /** Returns true if the widget DOM was rebuilt — caller should re-populate and cancel stale async work. */
  _mountWidget(state, container, panelEl) {
    const correctlyPlaced = state.rootEl && state.rootEl.isConnected
      && state.rootEl.parentElement === container
      && container.firstChild === state.rootEl;
    if (correctlyPlaced) {
      if (!state.observer) state.observer = this._createWidgetObserver(state, panelEl);
      return false;
    }

    if (state.observer) {
      try { state.observer.disconnect(); } catch {}
      state.observer = null;
    }
    try { clearTimeout(state._navTimer); } catch {}

    const ch0 = this._chartInstances.get(state.panelId);
    if (ch0) { try { ch0.destroy(); } catch {} this._chartInstances.delete(state.panelId); }

    for (const el of container.querySelectorAll(':scope > .ynab-widget')) {
      if (el.dataset?.panelId === state.panelId) { try { el.remove(); } catch {} }
    }

    state.rootEl = this._buildWidget(state);
    container.insertBefore(state.rootEl, container.firstChild);

    state.observer = this._createWidgetObserver(state, panelEl);
    return true;
  }

  _createWidgetObserver(state, panelEl) {
    const obs = new MutationObserver(() => {
      const c = this._findContainer(panelEl);
      if (state.rootEl && c && state.rootEl.isConnected && state.rootEl.parentElement === c && c.firstChild !== state.rootEl) {
        c.insertBefore(state.rootEl, c.firstChild);
      }
      if (state.rootEl && !state.rootEl.isConnected) {
        try { clearTimeout(state._navTimer); } catch {}
        state._navTimer = setTimeout(() => {
          if (state.panel && state.rootEl && !state.rootEl.isConnected) {
            this._handlePanel(state.panel);
          }
        }, 300);
      }
    });
    obs.observe(panelEl, { childList: true, subtree: true });
    return obs;
  }

  /** Prefer the last match — after journal navigation Thymer may leave multiple layers; first match can be stale. */
  _findContainer(panelEl) {
    if (!panelEl) return null;
    for (const sel of ['.page-content', '.editor-wrapper', '.editor-panel', '#editor']) {
      if (panelEl.matches?.(sel)) return panelEl;
      const all = panelEl.querySelectorAll?.(sel);
      if (all && all.length) return all[all.length - 1];
    }
    return null;
  }

  _buildWidget(state) {
    const collapsed = ls(SK.WIDGET_COLLAPSE) === 'true';
    const root = document.createElement('div');
    root.className = 'ynab-widget'; root.dataset.panelId = state.panelId;

    // Header
    const header = document.createElement('div'); header.className = 'ynab-widget-header';
    const toggle = document.createElement('button'); toggle.type='button'; toggle.className='ynab-w-toggle'; toggle.innerHTML = collapsed ? '<i class="ti ti-chevron-down"></i>' : '<i class="ti ti-chevron-up"></i>';
    const title  = document.createElement('span');  title.className='ynab-w-title'; title.innerHTML = '<i class="ti ti-coin"></i> YNAB Income';

    const controls = document.createElement('div'); controls.className='ynab-w-controls'; controls.style.display = collapsed ? 'none' : 'flex';
    const period = ls(SK.WIDGET_PERIOD) || 'weekly';
    const ctype  = ls(SK.WIDGET_CHART)  || 'bar';
    controls.append(
      this._tgroup([['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']], SK.WIDGET_PERIOD, period, () => this._populateWidget(this._panelStates.get(state.panelId))),
      this._tgroup([['bar','▊ Bar'],['line','╱ Line']], SK.WIDGET_CHART, ctype, () => this._populateWidget(this._panelStates.get(state.panelId))),
      this._optGroup(state),
    );

    toggle.addEventListener('click', () => {
      const wasCollapsed = body.style.display === 'none';
      const nowCollapsed = !wasCollapsed;
      body.style.display     = nowCollapsed ? 'none' : 'block';
      controls.style.display = nowCollapsed ? 'none' : 'flex';
      toggle.innerHTML       = nowCollapsed ? '<i class="ti ti-chevron-down"></i>' : '<i class="ti ti-chevron-up"></i>';
      lsSet(SK.WIDGET_COLLAPSE, nowCollapsed);
      if (wasCollapsed) {
        const st = this._panelStates.get(state.panelId);
        if (st) void this._populateWidget(st);
      }
    });
    header.append(toggle, title, controls);

    // Body
    const body = document.createElement('div'); body.className='ynab-widget-body'; body.style.display = collapsed ? 'none' : 'block';

    const filterRow = document.createElement('div'); filterRow.className='ynab-w-filter-row'; filterRow.dataset.role='filters';
    const statRow   = document.createElement('div'); statRow.className='ynab-stat-row'; statRow.dataset.role='stats';
    const canvasWrap= document.createElement('div'); canvasWrap.className='ynab-canvas-wrap';
    const canvas    = document.createElement('canvas'); canvas.dataset.role='chart'; canvas.height=140;
    canvasWrap.appendChild(canvas);
    const statusEl  = document.createElement('div'); statusEl.className='ynab-status'; statusEl.dataset.role='status';

    body.append(filterRow, statRow, canvasWrap, statusEl);

    if (!ls(SK.TOKEN)) {
      const notice = document.createElement('div'); notice.className='ynab-notice';
      notice.innerHTML='⚙️ <a href="#" class="ynab-cfg-link">Configure YNAB token</a> to enable.';
      notice.querySelector('.ynab-cfg-link').addEventListener('click', e => { e.preventDefault(); this._showConfigDialog(); });
      body.appendChild(notice);
    }

    root.append(header, body);
    return root;
  }

  _optGroup(state) {
    const g = document.createElement('div'); g.className='ynab-tgroup';
    g.append(
      this._optBtn('⇄ vs Last', SK.WIDGET_COMPARE, () => this._populateWidget(this._panelStates.get(state.panelId))),
      this._optBtn('~ Avg',     SK.WIDGET_AVG,     () => this._populateWidget(this._panelStates.get(state.panelId))),
    );
    return g;
  }

  _tgroup(options, storageKey, current, onChange) {
    const g = document.createElement('div'); g.className='ynab-tgroup';
    for (const [val, label] of options) {
      const btn = document.createElement('button'); btn.type='button';
      btn.className = `ynab-tbtn${current===val?' active':''}`;
      btn.dataset.val = val; btn.textContent = label;
      btn.addEventListener('click', () => {
        lsSet(storageKey, val);
        g.querySelectorAll('.ynab-tbtn').forEach(b => b.classList.toggle('active', b.dataset.val===val));
        onChange();
      });
      g.appendChild(btn);
    }
    return g;
  }

  _optBtn(label, storageKey, onChange) {
    const btn = document.createElement('button'); btn.type='button';
    btn.className = `ynab-tbtn${ls(storageKey)==='true'?' active':''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      const next = ls(storageKey) !== 'true';
      lsSet(storageKey, next);
      btn.classList.toggle('active', next);
      onChange();
    });
    return btn;
  }

  // ── Widget data & chart ─────────────────────────────────────────────────────

  _finishWidgetPopulate(state) {
    if (!state) return;
    state.loading = false;
    if (state._pendingPopulateWidget) {
      state._pendingPopulateWidget = false;
      this._populateWidget(state);
    }
  }

  async _populateWidget(state) {
    if (!state) return;
    if (!ls(SK.TOKEN) || !ls(SK.BUDGET_ID)) {
      state.loading = false;
      state._pendingPopulateWidget = false;
      return;
    }
    if (state.loading) {
      state._pendingPopulateWidget = true;
      return;
    }
    state.loading = true;

    const snapY = state.year, snapM = state.month, snapD = state.day;

    const root      = state.rootEl;
    const statsEl   = root?.querySelector('[data-role="stats"]');
    const statusEl  = root?.querySelector('[data-role="status"]');
    const filterRow = root?.querySelector('[data-role="filters"]');
    const widgetBody = root?.querySelector('.ynab-widget-body');

    if (widgetBody && widgetBody.style.display === 'none') {
      state.loading = false;
      if (statusEl) statusEl.textContent = '';
      this._finishWidgetPopulate(state);
      return;
    }

    if (statusEl) statusEl.textContent = 'Loading chart…';

    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (statusEl) statusEl.textContent = 'Loading chart library…';
      await loadChartJs();
      if (statusEl) statusEl.textContent = 'Loading transactions…';
      const txns    = await getTransactions();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (state.year !== snapY || state.month !== snapM || state.day !== snapD) {
        this._finishWidgetPopulate(state);
        return;
      }
      if (!root?.isConnected) { this._finishWidgetPopulate(state); return; }

      const isIncome = t => isIncomeTransaction(t, txns);
      const filtered = txns.filter(t => isIncome(t));

      // Render filter row — gear button + live summary
      if (filterRow) {
        filterRow.innerHTML = '';
        const gearBtn = document.createElement('button');
        gearBtn.className = 'ynab-gear-btn';
        gearBtn.textContent = '⚙ Filters';
        gearBtn.addEventListener('click', () => {
          this._showFilterSettings(txns, () => {
            this._populateWidget(this._panelStates.get(state.panelId));
          });
        });
        const summary = document.createElement('span');
        summary.className = 'ynab-filter-summary';
        const raw = ls(SK.INCL_PAYEES);
        const inclCount = raw ? JSON.parse(raw).length : txns.filter(t=>t.type==='income').map(t=>t.payee).filter((p,i,a)=>a.indexOf(p)===i).filter(p=>!['transfer','starting'].some(kw=>p.toLowerCase().includes(kw))).length;
        const exclCount = lsJson(SK.EXCLUDED_GROUPS, DEFAULT_EXCLUDED).length;
        summary.textContent = `${inclCount} payees · ${exclCount} groups excluded`;
        filterRow.append(gearBtn, summary);
      }

      const period  = ls(SK.WIDGET_PERIOD) || 'weekly';
      const compare = ls(SK.WIDGET_COMPARE) === 'true';
      const showAvg = ls(SK.WIDGET_AVG)     === 'true';
      const ctype   = ls(SK.WIDGET_CHART)   || 'bar';
      const refDate = new Date(state.year, state.month-1, state.day);

      const { labels, cur, prev, curTotal, prevTotal, avg } = bucketData(filtered, refDate, period, compare, showAvg);

      // Stat chips — income only
      if (statsEl) {
        statsEl.innerHTML = '';
        const pl = { daily:'Today', weekly:'This Week', monthly:'This Month' }[period];
        statsEl.appendChild(this._chip(pl + ' Income', curTotal));
        if (compare && prevTotal !== null) {
          const diff = curTotal - prevTotal;
          statsEl.append(this._chip('vs Last', prevTotal), this._chip('Δ', diff, diff>=0?'pos':'neg'));
        }
        if (showAvg && avg !== null) statsEl.appendChild(this._chip('Avg', avg));
      }

      // Chart
      const canvasEl = root.querySelector('[data-role="chart"]');
      if (canvasEl) {
        const ex = this._chartInstances.get(state.panelId);
        if (ex) { try { ex.destroy(); } catch {} }

        const greenFill = ctype==='line' ? `rgba(${C.greenRgb}, 0.12)` : `rgba(${C.greenRgb}, 0.75)`;

        const datasets = [{
          label: 'Income', data: cur,
          backgroundColor: greenFill, borderColor: C.green, borderWidth: ctype==='bar'?1:2,
          tension: 0.35, fill: ctype==='line',
          pointRadius: ctype==='line'?2:0, pointBackgroundColor: C.green,
          type: ctype,
        }];
        if (compare && prev) datasets.push({
          label:'Last Period', data:prev, type:'line',
          backgroundColor:'transparent', borderColor: C.prevLine, borderWidth:1,
          borderDash:[4,4], tension:0.35, fill:false, pointRadius:0,
        });
        if (showAvg && avg !== null) datasets.push({
          label:'Avg', data:Array(labels.length).fill(avg), type:'line',
          borderColor: C.avgLine, borderWidth:1, borderDash:[5,3], pointRadius:0, fill:false,
        });

        const chart = new window.Chart(canvasEl, {
          type: ctype,
          data: { labels, datasets },
          options: {
            responsive:true, maintainAspectRatio:false, animation:{duration:220},
            plugins:{
              legend:{ display: compare||showAvg, labels:{color:C.axisText,font:{size:10},boxWidth:18} },
              tooltip:{ callbacks:{label:c=>`${c.dataset.label}: ${fmt(c.parsed.y)}`} },
            },
            scales:{
              x:{ticks:{color:C.axisText,font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'}},
              y:{ticks:{color:C.axisText,font:{size:10},callback:v=>`$${v}`},grid:{color:'rgba(255,255,255,0.04)'},beginAtZero:true},
            },
          },
        });
        this._chartInstances.set(state.panelId, chart);
      }

      const ts = ls(SK.CACHE_TS);
      if (statusEl) statusEl.textContent = ts ? `Synced ${new Date(parseInt(ts,10)).toLocaleTimeString()}` : '';

    } catch (e) {
      console.error('[YNAB widget]', e);
      if (statusEl && state.year === snapY && state.month === snapM && state.day === snapD) {
        statusEl.textContent = `Error: ${e.message}`;
      }
    }

    state.loaded = true;
    this._finishWidgetPopulate(state);
  }

  _chip(label, amount, mod='') {
    const c = document.createElement('div'); c.className=`ynab-stat-chip${mod?' '+mod:''}`;
    c.innerHTML=`<span class="ynab-sl">${label}</span><span class="ynab-sv">${fmt(amount)}</span>`;
    return c;
  }

  // ── Sync ────────────────────────────────────────────────────────────────────
  // Manual-only. Uses a batched approach: build a set of existing IDs first,
  // then create new records in batches of 10 with a single getAllRecords() call
  // per batch — instead of one getAllRecords() per record (which froze at scale).

  async _syncAll(force = false) {
    void this._ynabEnsurePathBReady();
    const token = ls(SK.TOKEN), budgetId = ls(SK.BUDGET_ID);
    if (!token || !budgetId) {
      this.ui.addToaster({title:'YNAB',message:'Configure token first',dismissible:true,autoDestroyTime:5000});
      return;
    }
    try {
      this.ui.addToaster({title:'YNAB',message:'Fetching transactions…',dismissible:false,autoDestroyTime:3000});
      const txns = await getTransactions(force);
      this._lastSyncTxns = txns;

      const coll = await this._findYnabTxnCollection();
      if (!coll) {
        this.ui.addToaster({title:'YNAB',message:`Collection "${YNAB_COLLECTION_NAME}" not found.`,dismissible:true,autoDestroyTime:5000});
        return;
      }

      // Build existing ID set — one getAllRecords() call total
      const existing    = await coll.getAllRecords();
      const existingMap = new Map();
      for (const r of existing) {
        const id = r.text?.('ynab_id') || r.prop('ynab_id')?.get?.() || r.prop('ynab_id')?.text?.() || '';
        if (id) existingMap.set(id, r);
      }

      // Separate new vs existing
      const toCreate = txns.filter(t => !existingMap.has(t.id));
      let updated = 0;

      // Update memos on existing records (fast — no record creation)
      for (const txn of txns) {
        if (!existingMap.has(txn.id)) continue;
        const rec = existingMap.get(txn.id);
        if (txn.memo && rec.prop('memo')?.get?.() !== txn.memo) {
          rec.prop('memo')?.set(txn.memo);
          updated++;
        }
      }

      if (toCreate.length === 0) {
        this.ui.addToaster({title:'YNAB Sync',message:`Up to date · ${updated} memo updates`,dismissible:true,autoDestroyTime:4000});
        this._fireDashRefreshers();
        return;
      }

      this.ui.addToaster({title:'YNAB',message:`Creating ${toCreate.length} new records…`,dismissible:false,autoDestroyTime:5000});

      // Create in batches of 20 — one getAllRecords() per batch
      const BATCH = 20;
      let created = 0;
      for (let i = 0; i < toCreate.length; i += BATCH) {
        const batch = toCreate.slice(i, i + BATCH);

        // Fire all createRecord calls for the batch
        const guids = batch.map(txn => ({
          txn,
          guid: coll.createRecord(`${txn.date} · ${txn.payee} · ${fmt(txn.amount)}`),
        }));

        // Wait once for the whole batch to land
        await sleep(120 + batch.length * 15);

        // Single getAllRecords() for the batch
        const allRecords = await coll.getAllRecords();
        const guidSet    = new Set(guids.map(g => g.guid));
        const newRecords = allRecords.filter(r => guidSet.has(r.guid));
        const byGuid     = new Map(newRecords.map(r => [r.guid, r]));

        const clearedMap = {cleared:'Cleared',uncleared:'Uncleared',reconciled:'Reconciled'};
        for (const { txn, guid } of guids) {
          const record = byGuid.get(guid);
          if (!record) continue;
          ynabSetYmdDateProp(record.prop('date'), txn.date);
          record.prop('payee')?.set(txn.payee);
          record.prop('amount')?.set(txn.amount);
          record.prop('category')?.set(txn.category);
          record.prop('category_group')?.set(txn.category_group);
          record.prop('memo')?.set(txn.memo);
          record.prop('account')?.set(txn.account);
          record.prop('ynab_id')?.set(txn.id);
          ynabSetDateTimeProp(record.prop('synced_at'), new Date());
          record.prop('cleared')?.setChoice?.(clearedMap[txn.cleared] || 'Uncleared');
          record.prop('transaction_type')?.setChoice?.(txn.type === 'income' ? 'Income' : 'Expense');
          created++;
        }

        // Brief pause between batches to let Thymer breathe
        if (i + BATCH < toCreate.length) await sleep(200);
      }

      this.ui.addToaster({
        title: 'YNAB Sync Complete',
        message: `${created} new · ${updated} updated`,
        dismissible: true, autoDestroyTime: 5000,
      });
      this._fireDashRefreshers();
    } catch (e) {
      console.error('[YNAB sync]', e);
      this.ui.addToaster({title:'YNAB Sync Error',message:e.message,dismissible:true,autoDestroyTime:6000});
    }
  }

  /**
   * Trigger the per-panel debounced refresh for every open YNAB dashboard. Used by
   * `_syncAll` and any other internal write site that needs to invalidate cached
   * render output. Safe to call when no dashboards are open (the map is empty).
   */
  _fireDashRefreshers() {
    if (!this._dashRefreshers || this._dashRefreshers.size === 0) return;
    for (const fn of this._dashRefreshers.values()) {
      try {
        fn();
      } catch (_) {}
    }
  }

  // ── Export CSV ───────────────────────────────────────────────────────────────

  _exportCSV(allTxns, from, to, excluded) {
    // Format matches the spreadsheet layout: Income by payee, Expenses by category group
    // Income filter uses the same payee inclusion list as the dashboard
    const rangeTxns = allTxns.filter(t => inYmdRange(t.date, from, to));

    // Income by payee (filtered using current payee settings)
    const payeeMap = {};
    for (const t of rangeTxns.filter(t => isIncomeTransaction(t, allTxns))) {
      payeeMap[t.payee] = (payeeMap[t.payee] || 0) + t.amount;
    }
    const incomeTotal = Object.values(payeeMap).reduce((a,b)=>a+b, 0);

    // Expenses by category group (respecting exclusions)
    const groupMap = {};
    for (const t of rangeTxns.filter(t => t.type==='expense' && !excluded.includes(t.category_group))) {
      groupMap[t.category_group] = (groupMap[t.category_group] || 0) + Math.abs(t.amount);
    }
    const expenseTotal = Object.values(groupMap).reduce((a,b)=>a+b, 0);

    const rows = [];
    rows.push(['Date Range', `${from} - ${to}`]);
    rows.push([]);
    rows.push(['Income', '']);
    for (const [p, v] of Object.entries(payeeMap).sort((a,b)=>b[1]-a[1])) {
      rows.push([p, v.toFixed(2)]);
    }
    rows.push(['', '']);
    rows.push(['Total', incomeTotal.toFixed(2)]);
    rows.push([]);
    rows.push(['Expenses', '']);
    for (const [g, v] of Object.entries(groupMap).sort((a,b)=>b-a)) {
      rows.push([g, v.toFixed(2)]);
    }
    rows.push(['', '']);
    rows.push(['Total', expenseTotal.toFixed(2)]);

    const csv  = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href=url; a.download=`ynab-${from}-${to}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Filter settings modal ──────────────────────────────────────────────────
  // Shared between widget and dashboard. Two tabs: Income (payees) and Expenses (groups).
  // Income tab: checkboxes for every unique payee. Checked = included in income totals.
  //   Defaults: all income payees checked except those containing "Transfer" or "Starting".
  // Expenses tab: checkboxes for every category group. Checked = included in expense totals.
  //   Defaults: all groups except DEFAULT_EXCLUDED.

  _showFilterSettings(allTxns, onSave) {
    // Build unique payees from income transactions
    const allPayees  = [...new Set(allTxns.filter(t=>t.type==='income').map(t=>t.payee))].sort();
    const allGroups  = [...new Set(allTxns.filter(t=>t.type==='expense').map(t=>t.category_group||'Uncategorized'))].sort();

    // Load current state — null means "never configured", use smart defaults
    const rawIncl = ls(SK.INCL_PAYEES);
    const inclPayees = rawIncl
      ? new Set(JSON.parse(rawIncl))
      : new Set(allPayees.filter(p => !['transfer','starting','balance'].some(kw => p.toLowerCase().includes(kw))));

    const rawExcl = ls(SK.EXCLUDED_GROUPS);
    const exclGroups = rawExcl
      ? new Set(JSON.parse(rawExcl))
      : new Set(DEFAULT_EXCLUDED);

    // Amount totals for context
    const payeeTotals = {};
    for (const t of allTxns.filter(t=>t.type==='income')) {
      payeeTotals[t.payee] = (payeeTotals[t.payee]||0) + t.amount;
    }
    const groupTotals = {};
    for (const t of allTxns.filter(t=>t.type==='expense')) {
      const g = t.category_group||'Uncategorized';
      groupTotals[g] = (groupTotals[g]||0) + Math.abs(t.amount);
    }

    // Working state (mutated by checkboxes before save)
    const workingIncl  = new Set(inclPayees);
    const workingExcl  = new Set(exclGroups);

    // ── DOM ──
    const overlay = document.createElement('div'); overlay.className='ynab-settings-overlay';
    // Inline z-index so this stays above the floating dash even if CSS inject was skipped on hot reload.
    overlay.style.zIndex = '100050';
    const modal   = document.createElement('div'); modal.className='ynab-settings-modal';

    // Header
    const header = document.createElement('div'); header.className='ynab-settings-header';
    const htitle = document.createElement('div'); htitle.className='ynab-settings-title'; htitle.textContent='⚙️ Filter Settings';
    const closeBtn = document.createElement('button'); closeBtn.className='ynab-settings-close'; closeBtn.textContent='✕';
    closeBtn.addEventListener('click', ()=>overlay.remove());
    header.append(htitle, closeBtn);
    modal.appendChild(header);

    // Tabs
    const tabs = document.createElement('div'); tabs.className='ynab-settings-tabs';
    const incTab = document.createElement('button'); incTab.className='ynab-stab active'; incTab.textContent='Income Payees';
    const expTab = document.createElement('button'); expTab.className='ynab-stab'; expTab.textContent='Expense Groups';
    tabs.append(incTab, expTab);
    modal.appendChild(tabs);

    // Search
    const searchInput = document.createElement('input');
    searchInput.type='text'; searchInput.className='ynab-settings-search'; searchInput.placeholder='Search…';
    modal.appendChild(searchInput);

    // List
    const list = document.createElement('div'); list.className='ynab-settings-list';
    modal.appendChild(list);

    // Footer
    const footer = document.createElement('div'); footer.className='ynab-settings-footer';
    const summaryEl = document.createElement('div'); summaryEl.className='ynab-settings-summary';
    const footerBtns = document.createElement('div'); footerBtns.className='ynab-settings-footer-btns';

    const selectAllBtn = document.createElement('button'); selectAllBtn.className='ynab-btn'; selectAllBtn.textContent='Select All';
    const noneBtn      = document.createElement('button'); noneBtn.className='ynab-btn'; noneBtn.textContent='None';
    const saveBtn      = document.createElement('button'); saveBtn.className='ynab-btn ynab-btn-primary'; saveBtn.textContent='Apply';

    footerBtns.append(selectAllBtn, noneBtn, saveBtn);
    footer.append(summaryEl, footerBtns);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e=>{ if(e.target===overlay) overlay.remove(); });

    // ── Render helpers ──
    let activeTab = 'income';

    const updateSummary = () => {
      if (activeTab==='income') {
        summaryEl.textContent = `${workingIncl.size} of ${allPayees.length} payees included`;
      } else {
        summaryEl.textContent = `${workingExcl.size} of ${allGroups.length} groups excluded`;
      }
    };

    const renderList = () => {
      list.innerHTML='';
      const query = searchInput.value.toLowerCase();
      const items = activeTab==='income' ? allPayees : allGroups;

      for (const item of items) {
        if (query && !item.toLowerCase().includes(query)) continue;
        const row   = document.createElement('label'); row.className='ynab-scheck-row';
        const check = document.createElement('input'); check.type='checkbox'; check.className='ynab-scheck';
        check.checked = activeTab==='income' ? workingIncl.has(item) : !workingExcl.has(item);

        check.addEventListener('change', ()=>{
          if (activeTab==='income') {
            check.checked ? workingIncl.add(item) : workingIncl.delete(item);
          } else {
            check.checked ? workingExcl.delete(item) : workingExcl.add(item);
          }
          updateSummary();
        });

        const label = document.createElement('span'); label.className='ynab-scheck-label'; label.textContent=item;
        const total = activeTab==='income' ? payeeTotals[item] : groupTotals[item];
        const amt   = document.createElement('span'); amt.className='ynab-scheck-amount';
        amt.textContent = total ? fmt(total) : '';

        row.append(check, label, amt);
        list.appendChild(row);
      }
      updateSummary();
    };

    incTab.addEventListener('click', ()=>{
      activeTab='income'; incTab.classList.add('active'); expTab.classList.remove('active');
      searchInput.value=''; renderList();
    });
    expTab.addEventListener('click', ()=>{
      activeTab='expense'; expTab.classList.add('active'); incTab.classList.remove('active');
      searchInput.value=''; renderList();
    });
    searchInput.addEventListener('input', renderList);

    selectAllBtn.addEventListener('click', ()=>{
      if (activeTab==='income') { allPayees.forEach(p=>workingIncl.add(p)); }
      else { allGroups.forEach(g=>workingExcl.delete(g)); }
      renderList();
    });
    noneBtn.addEventListener('click', ()=>{
      if (activeTab==='income') { workingIncl.clear(); }
      else { allGroups.forEach(g=>workingExcl.add(g)); }
      renderList();
    });

    saveBtn.addEventListener('click', ()=>{
      lsJsonSet(SK.INCL_PAYEES, [...workingIncl]);
      lsJsonSet(SK.EXCLUDED_GROUPS, [...workingExcl]);
      overlay.remove();
      if (onSave) onSave();
    });

    renderList();
  }

  // ── Config dialog ───────────────────────────────────────────────────────────

  async _showConfigDialog() {
    void this._ynabEnsurePathBReady();
    this.ui.addToaster?.({
      title: 'YNAB',
      message: 'Opening configure…',
      dismissible: true,
      autoDestroyTime: 1600,
    });
    try {
      document.querySelectorAll('.ynab-overlay').forEach((n) => n.remove());
    } catch (_) {}
    const overlay = document.createElement('div'); overlay.className='ynab-overlay';
    overlay.style.zIndex = '100050';
    const dialog  = document.createElement('div'); dialog.className='ynab-dialog';

    const title   = document.createElement('div'); title.className='ynab-dlg-title'; title.textContent='⚙️ YNAB Configuration';
    const form    = document.createElement('div'); form.className='ynab-dlg-form';

    const tokenLabel = document.createElement('label');
    tokenLabel.className = 'ynab-label';
    tokenLabel.textContent = 'Personal Access Token';

    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.className = 'ynab-input';
    tokenInput.placeholder = 'Paste your YNAB PAT';
    tokenInput.value = ls(SK.TOKEN) || '';

    const tokenHint = document.createElement('div');
    tokenHint.className = 'ynab-hint';
    tokenHint.textContent = 'app.ynab.com - Account Settings - Developer Settings';

    const budgetLabel = document.createElement('label');
    budgetLabel.className = 'ynab-label';
    budgetLabel.textContent = 'Budget';

    const budgetSelect = document.createElement('select');
    budgetSelect.className = 'ynab-input';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'ynab-btn';
    loadBtn.textContent = 'Load Budgets';

    const statusEl = document.createElement('div');
    statusEl.className = 'ynab-dlg-status';

    loadBtn.addEventListener('click', async () => {
      const tok = (tokenInput ? tokenInput.value : '').trim();
      if (!tok) { statusEl.textContent='Enter your token first.'; return; }
      statusEl.textContent='Loading…';
      try {
        const budgets = await apiFetchBudgets(tok);
        budgetSelect.innerHTML='';
        for (const b of budgets) {
          const opt=document.createElement('option'); opt.value=b.id; opt.textContent=b.name;
          if (b.id===ls(SK.BUDGET_ID)) opt.selected=true;
          budgetSelect.appendChild(opt);
        }
        statusEl.textContent=`${budgets.length} budget(s) found.`;
      } catch(e) { statusEl.textContent=`Error: ${e.message}`; }
    });

    form.append(tokenLabel,tokenInput,tokenHint,budgetLabel,loadBtn,budgetSelect);

    const btnRow    = document.createElement('div'); btnRow.className='ynab-dlg-btns';
    const cancelBtn = document.createElement('button'); cancelBtn.type='button'; cancelBtn.className='ynab-btn'; cancelBtn.textContent='Cancel';
    cancelBtn.addEventListener('click',()=>overlay.remove());

    const saveBtn = document.createElement('button'); saveBtn.type='button'; saveBtn.className='ynab-btn ynab-btn-primary'; saveBtn.textContent='Save & Sync';
    saveBtn.addEventListener('click', async () => {
      const tok=(tokenInput ? tokenInput.value : '').trim();
      if (!tok){statusEl.textContent='Token required.';return;}
      lsSet(SK.TOKEN,tok);
      const sel=budgetSelect.options[budgetSelect.selectedIndex];
      if (sel){lsSet(SK.BUDGET_ID,sel.value);lsSet(SK.BUDGET_NAME,sel.text);}
      bustCache(); overlay.remove();
      await this._syncAll(true);
    });

    btnRow.append(cancelBtn,saveBtn);
    dialog.append(title,form,statusEl,btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('click',e=>{if(e.target===overlay)overlay.remove();});
    if (ls(SK.TOKEN)) loadBtn.click();
  }
}
