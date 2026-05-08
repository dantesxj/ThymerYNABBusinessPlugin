// ==Plugin==
// name: YNAB
// description: YNAB dashboard and transaction sync
// icon: ti-coin
// ==/Plugin==

/**
 * Diagnostic instrumentation calls below (`globalThis.__thymerDiag?.record?.(...)` and
 * the panic gate) are no-ops unless the standalone **Thymer Diagnostics** plugin is
 * loaded. That plugin owns the runtime, command palette commands, and the live diag
 * dashboard — install/enable it when something feels wrong, disable it when not.
 */

// @generated BEGIN thymer-plugin-settings (source: plugins/public repo/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Create dedupe: Web Locks + **per-workspace** localStorage lease/recent-create keys (workspaceGuid from
 * `data.getActiveUsers()[0]`), plus abort if an exact-named Plugin Backend collection already exists.
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    let slugRegisterSavedOk = false;
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
        else slugRegisterSavedOk = true;
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    if (slugRegisterSavedOk) await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/public repo/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      if (changed) await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    for (const x of records) {
      if (isVaultRow(x, pluginId)) return x;
    }
    return null;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  /** Unscoped keys (legacy); runtime uses {@link scopedPbLsKey} per workspace. */
  const LS_CREATE_LEASE_BASE = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_BASE = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_BASE = 'thymerext_plugin_backend_recent_create_attempt_v1';

  function workspaceSlugFromData(data) {
    try {
      const u = data && typeof data.getActiveUsers === 'function' ? data.getActiveUsers() : null;
      const g = u && u[0] && u[0].workspaceGuid;
      const s = g != null ? String(g).trim() : '';
      if (s) return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120);
    } catch (_) {}
    return '_unknown_ws';
  }

  function scopedPbLsKey(base, data) {
    return `${base}__${workspaceSlugFromData(data)}`;
  }

  /** Count collections whose sidebar/title name is exactly Plugin Backend (or legacy). */
  async function countExactPluginBackendNamedCollections(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const c of all) {
      try {
        const nm = collectionDisplayName(c);
        if (nm === COL_NAME || nm === COL_NAME_LEGACY) n += 1;
      } catch (_) {}
    }
    return n;
  }

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * Lease keys are **per workspace** so switching workspaces does not inherit another vault’s lease / cooldown.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs, data) {
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) {
      if (locksOk) return noop;
      if (DEBUG_COLLECTIONS) {
        dlogPathB('lease_denied_no_localstorage_no_locks', { ws: workspaceSlugFromData(data) });
      }
      return { denied: true, release() {} };
    }
    const leaseKey = scopedPbLsKey(LS_CREATE_LEASE_BASE, data);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(leaseKey, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(leaseKey) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention, leaseKey });
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention, leaseKey });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(leaseKey);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  function pickCollFromAll(all) {
    try {
      const pick = (allIn) => {
        const list = Array.isArray(allIn) ? allIn : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  function hasPluginBackendInAll(all) {
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  async function findColl(data) {
    try {
      const all = await data.getAllCollections();
      return pickCollFromAll(all);
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return false;
    }
    return hasPluginBackendInAll(all);
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';
  /** Per-workspace: Plugin Backend already ensured — skip repeat bodies (avoids getAllCollections / lock storms). */
  const WS_ENSURE_OK_MAP = '__thymerExtPbWorkspaceEnsureOkMap_v1';

  function markWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      if (!h[WS_ENSURE_OK_MAP] || typeof h[WS_ENSURE_OK_MAP] !== 'object') h[WS_ENSURE_OK_MAP] = Object.create(null);
      h[WS_ENSURE_OK_MAP][slug] = true;
    } catch (_) {}
  }

  function isWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      const m = h[WS_ENSURE_OK_MAP];
      return !!(m && m[slug]);
    } catch (_) {
      return false;
    }
  }

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (data && isWorkspacePluginBackendEnsureDone(data)) return;
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await data.getAllCollections();
          const list = Array.isArray(a) ? a : [];
          const collNames = list.map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
          const dupExact = list.filter((c) => {
            try {
              const nm = collectionDisplayName(c);
              return nm === COL_NAME || nm === COL_NAME_LEGACY;
            } catch (__) {
              return false;
            }
          });
          if (dupExact.length > 1) {
            dlogPathB('duplicate_plugin_backend_named_collections', {
              count: dupExact.length,
              guids: dupExact.map((c) => {
                try {
                  return c.getGuid?.() || null;
                } catch (__) {
                  return null;
                }
              }),
              doc: 'docs/PLUGIN_BACKEND_DUPLICATE_HYGIENE.md',
            });
          }
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      const markPbOk = () => markWorkspacePluginBackendEnsureDone(data);
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let allAttempt;
        try {
          allAttempt = await data.getAllCollections();
        } catch (_) {
          allAttempt = null;
        }
        if (allAttempt != null) {
          existing = pickCollFromAll(allAttempt);
          if (existing) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allAttempt)) {
            markPbOk();
            return;
          }
        } else {
          existing = await findColl(data);
          if (existing) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      let allPost;
      try {
        allPost = await data.getAllCollections();
      } catch (_) {
        allPost = null;
      }
      if (allPost != null) {
        existing = pickCollFromAll(allPost);
        if (existing) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allPost)) {
          markPbOk();
          return;
        }
      } else {
        existing = await findColl(data);
        if (existing) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      let allAfterWait;
      try {
        allAfterWait = await data.getAllCollections();
      } catch (_) {
        allAfterWait = null;
      }
      if (allAfterWait != null) {
        if (pickCollFromAll(allAfterWait)) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allAfterWait)) {
          markPbOk();
          return;
        }
      } else {
        if (await findColl(data)) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await data.getAllCollections();
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await data.getAllCollections();
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          let allPre;
          try {
            allPre = await data.getAllCollections();
          } catch (_) {
            allPre = null;
          }
          if (allPre != null) {
            if (pickCollFromAll(allPre)) {
              markPbOk();
              return;
            }
            if (hasPluginBackendInAll(allPre)) {
              markPbOk();
              return;
            }
          } else {
            if (await findColl(data)) {
              markPbOk();
              return;
            }
            if (await hasPluginBackendOnWorkspace(data)) {
              markPbOk();
              return;
            }
          }
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000, data);
      if (lease.denied) return;
      try {
        let allLease;
        try {
          allLease = await data.getAllCollections();
        } catch (_) {
          allLease = null;
        }
        if (allLease != null) {
          if (pickCollFromAll(allLease)) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allLease)) {
            markPbOk();
            return;
          }
        } else {
          if (await findColl(data)) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs(data);
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            let allCont;
            try {
              allCont = await data.getAllCollections();
            } catch (_) {
              allCont = null;
            }
            if (allCont != null) {
              if (pickCollFromAll(allCont)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allCont)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs(data);
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            let allSettle;
            try {
              allSettle = await data.getAllCollections();
            } catch (_) {
              allSettle = null;
            }
            if (allSettle != null) {
              if (pickCollFromAll(allSettle)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allSettle)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
        }
        noteRecentPluginBackendCreateAttempt(data);
        const exactN = await countExactPluginBackendNamedCollections(data);
        if (exactN >= 1) {
          if (DEBUG_COLLECTIONS) {
            dlogPathB('abort_create_exact_backend_name_exists', { exactN, ws: workspaceSlugFromData(data) });
          }
          markPbOk();
          return;
        }
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate(data);
        markPbOk();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    if (isWorkspacePluginBackendEnsureDone(data)) {
      return Promise.resolve();
    }
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = findVaultRecord(records, pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,

    async init(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        for (const k of keys) {
          const v = remote.payload[k];
          if (typeof v === 'string') {
            try {
              localStorage.setItem(k, v);
            } catch (_) {}
          }
        }
      }

      if (plugin._pluginSettingsSyncMode === 'synced') {
        try {
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const YNAB_COLLECTION_NAME = 'YNAB';
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
  TOKEN:           'ynab_pat',
  BUDGET_ID:       'ynab_budget_id',
  BUDGET_NAME:     'ynab_budget_name',
  CACHE_TXN:       'ynab_txn_cache_v4',
  CACHE_CATS:      'ynab_cats_v4',
  CACHE_CATS_TS:   'ynab_cats_ts_v4',
  CACHE_TS:        'ynab_txn_cache_ts',
  EXCLUDED_GROUPS: 'ynab_excluded_groups',
  WIDGET_PERIOD:   'ynab_widget_period',
  WIDGET_CHART:    'ynab_widget_chart',
  WIDGET_COMPARE:  'ynab_widget_compare',
  WIDGET_AVG:      'ynab_widget_avg',
  WIDGET_COLLAPSE: 'ynab_widget_collapse',
  DASH_FROM:       'ynab_dash_from',
  DASH_TO:         'ynab_dash_to',
  EXCL_PAYEES:     'ynab_excl_payees',
  INCL_PAYEES:     'ynab_incl_payees_v4',   // null = not yet configured (use defaults)
};

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
function ynabPluginSettingsFlush() {
  try {
    const p = globalThis.__ynabPluginSettingsPlugin;
    if (p) globalThis.ThymerPluginSettings?.scheduleFlush?.(p, () => Object.values(SK));
  } catch (_) {}
}
const lsSet   = (k,v)=> { try { localStorage.setItem(k, String(v)); } catch {} ynabPluginSettingsFlush(); };
const lsJson  = (k,d)=> { try { const v = ls(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsJsonSet=(k,v)=> { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} ynabPluginSettingsFlush(); };
const sleep   = ms   => new Promise(r => setTimeout(r, ms));

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

// Returns YYYY-MM-DD string
function dateStr(d) { return d.toISOString().slice(0, 10); }

// Date range presets — all return { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
function presets() {
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

  return [
    { label: 'This Month',  from: dateStr(firstOfMonth),    to: dateStr(lastOfMonth) },
    { label: 'Last Month',  from: dateStr(firstOfLastMonth), to: dateStr(lastOfLastMonth) },
    { label: 'YTD',         from: dateStr(firstOfYear),     to: dateStr(now) },
    { label: 'Last Year',   from: dateStr(firstOfLastYear), to: dateStr(lastOfLastYear) },
    { label: 'Last 90d',    from: dateStr(new Date(now - 90*864e5)), to: dateStr(now) },
    { label: 'All Time',    from: '2000-01-01',             to: dateStr(now) },
  ];
}

// Income filter — returns true if transaction should be counted as income.
// Uses the explicit payee include list if configured, else falls back to
// excluding payees that contain "transfer" or "starting".
function isIncomeTransaction(t, allTxns) {
  if (t.type !== 'income') return false;
  const raw = ls(SK.INCL_PAYEES);
  if (raw) {
    const incl = new Set(JSON.parse(raw));
    return incl.has(t.payee);
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
          date:           t.date,
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
        date:           t.date,
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
  return lsJson(SK.CACHE_TXN, null);
}
function setCache(txns) { lsJsonSet(SK.CACHE_TXN, txns); lsSet(SK.CACHE_TS, Date.now()); }
function bustCache()    { lsSet(SK.CACHE_TS, '0'); }

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
      cur.push(income.filter(t => t.date === k).reduce((a, t) => a + t.amount, 0));
    }
    curTotal = income.filter(t => t.date === dateStr(refDate)).reduce((a, t) => a + t.amount, 0);
    if (compare) {
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const d = new Date(refDate); d.setDate(d.getDate() - i - N);
        prev.push(income.filter(t => t.date === dateStr(d)).reduce((a, t) => a + t.amount, 0));
      }
      const yd = new Date(refDate); yd.setDate(yd.getDate() - 1);
      prevTotal = income.filter(t => t.date === dateStr(yd)).reduce((a, t) => a + t.amount, 0);
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
      cur.push(income.filter(t => t.date >= dateStr(s) && t.date <= dateStr(e)).reduce((a,t)=>a+t.amount,0));
    }
    const wse = new Date(ws); wse.setDate(wse.getDate()+6);
    curTotal = income.filter(t => t.date >= dateStr(ws) && t.date <= dateStr(wse)).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      // Overlay: each bar's comparison is the equivalent week 1 year ago
      // prevTotal: simply the week immediately before the current one
      const lastWS = new Date(ws); lastWS.setDate(lastWS.getDate() - 7);
      const lastWE = new Date(lastWS); lastWE.setDate(lastWE.getDate() + 6);
      prevTotal = income.filter(t => t.date >= dateStr(lastWS) && t.date <= dateStr(lastWE)).reduce((a,t)=>a+t.amount,0);
      // Overlay line: shift each displayed week back by exactly 1 week
      prev = [];
      for (let i = N - 1; i >= 0; i--) {
        const s = new Date(ws); s.setDate(s.getDate() - i*7 - 7);
        const e = new Date(s);  e.setDate(e.getDate()+6);
        prev.push(income.filter(t => t.date >= dateStr(s) && t.date <= dateStr(e)).reduce((a,t)=>a+t.amount,0));
      }
    }
    if (showAvg) { const nz = cur.filter(v=>v>0); avg = nz.length ? nz.reduce((a,b)=>a+b,0)/nz.length : 0; }

  } else { // monthly
    const N = 12;
    for (let i = N - 1; i >= 0; i--) {
      const d  = new Date(refDate.getFullYear(), refDate.getMonth()-i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      labels.push(d.toLocaleString('default',{month:'short',year:'2-digit'}));
      cur.push(income.filter(t=>t.date.startsWith(key)).reduce((a,t)=>a+t.amount,0));
    }
    const ck = `${refDate.getFullYear()}-${String(refDate.getMonth()+1).padStart(2,'0')}`;
    curTotal = income.filter(t=>t.date.startsWith(ck)).reduce((a,t)=>a+t.amount,0);
    if (compare) {
      const pd = new Date(refDate.getFullYear(), refDate.getMonth()-N, 1);
      prev = [];
      for (let i = 0; i < N; i++) {
        const d = new Date(pd.getFullYear(), pd.getMonth()+i, 1);
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        prev.push(income.filter(t=>t.date.startsWith(k)).reduce((a,t)=>a+t.amount,0));
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
  /* ── Journal widget — bg matches Backreferences card exactly ── */
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

  /* Config dialog */
  .ynab-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.62); z-index: 9999;
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

  /* Settings modal */
  .ynab-settings-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 9999;
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

class Plugin extends CollectionPlugin {

  /** One `getAllCollections` per workspace after the YNAB collection is found (cleared on unload). */
  _ynabCollsKey = null;
  _ynabCollsResolved = false;
  _ynabTxnColl = null;
  /** `injectCSS` must run once — repeated calls (plugin reload) can thrash layout. */
  _ynabUiCssInstalled = false;
  /**
   * Plugin Backend writes (e.g. Bilt Value Tracker `scheduleFlush`) cause Thymer to fire
   * `onRefresh` on every open plugin panel. Without debounce, this re-runs the full YNAB
   * dashboard (Chart.js + transaction load) in a tight loop → flicker + app freeze.
   */
  _ynabDashRenderGen = 0;

  async _ensureYnabTxnCollection() {
    let key = '';
    try {
      key = String(this.data.getActiveUsers?.()?.[0]?.workspaceGuid || '');
    } catch (_) {}
    if (this._ynabCollsKey === key && this._ynabCollsResolved && this._ynabTxnColl) return this._ynabTxnColl;
    const collections = await this.data.getAllCollections();
    const coll = collections.find((c) => c.getName() === YNAB_COLLECTION_NAME) || null;
    this._ynabTxnColl = coll;
    this._ynabCollsKey = key;
    this._ynabCollsResolved = !!coll;
    return coll;
  }

  async onLoad() {
    const diag = globalThis.__thymerDiag;
    diag?.record?.('YNAB_ONLOAD_START');
    if (diag?.isPanic?.()) {
      diag.record('YNAB_ONLOAD_PANIC_SKIP');
      return;
    }
    globalThis.__ynabPluginSettingsPlugin = this;
    /**
     * Journal income widget on daily pages. Default off (Journal Header Suite embeds YNAB).
     * Set `custom.mount_journal_income_widget` to true in this collection’s config to mount the standalone widget.
     */
    const c = this.getConfiguration?.()?.custom;
    const hasMountKey = c && Object.prototype.hasOwnProperty.call(c, 'mount_journal_income_widget');
    this._mountJournalIncomeWidget = hasMountKey ? c.mount_journal_income_widget !== false : false;
    globalThis.__ynabBusinessPlugin = this;
    await (globalThis.ThymerPluginSettings?.init?.({
      plugin: this,
      pluginId: 'ynab',
      modeKey: 'thymerext_ps_mode_ynab',
      mirrorKeys: () => Object.values(SK),
      label: 'YNAB',
      data: this.data,
      ui: this.ui,
    }) ?? (console.warn('[YNAB] ThymerPluginSettings runtime missing (redeploy full plugin .js from repo).'), Promise.resolve()));
    this._panelStates    = new Map();
    this._eventIds       = [];
    this._chartInstances = new Map();
    this._ynNavTimers    = new Map();

    // Note: versioned cache keys (v4) mean old-format data auto-expires
    // without needing to manually bust the cache on every load
    if (!this._ynabUiCssInstalled) {
      try {
        this.ui.injectCSS(CSS);
        this._ynabUiCssInstalled = true;
      } catch (_) {
        this._ynabUiCssInstalled = false;
      }
    }
    this.views.register('Dashboard', ctx => this._dashboardView(ctx));

    this._eventIds.push(this.events.on('panel.navigated', ev => this._deferHandlePanel(ev.panel)));
    this._eventIds.push(this.events.on('panel.focused',   ev => this._handlePanel(ev.panel)));
    this._eventIds.push(this.events.on('panel.closed',    ev => this._disposePanel(ev.panel?.getId?.())));

    this._cmdSync = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Sync Transactions Now', icon: 'ti-refresh',
      onSelected: () => this._syncAll(true),
    });
    this._cmdCfg = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Configure Token & Budget', icon: 'ti-settings',
      onSelected: () => this._showConfigDialog(),
    });
    this._cmdStorage = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Storage location…',
      icon: 'ti-database',
      onSelected: () => {
        globalThis.ThymerPluginSettings?.openStorageDialog?.({
          plugin: this,
          pluginId: 'ynab',
          modeKey: 'thymerext_ps_mode_ynab',
          mirrorKeys: () => Object.values(SK),
          label: 'YNAB',
          data: this.data,
          ui: this.ui,
        });
      },
    });

    this._cmdJournalWidgetOn = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Enable standalone journal income widget',
      icon: 'ti-chart-line',
      onSelected: () => {
        try { localStorage.setItem(YNAB_JWIDGET_OVERRIDE_LS, 'on'); } catch (_) {}
        this._refreshJournalWidgetPanelsAfterOverrideChange();
        this.ui.addToaster?.({ title: 'YNAB', message: 'Standalone journal widget enabled.', autoDestroyTime: 2200, dismissible: true });
      },
    });
    this._cmdJournalWidgetOff = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Disable standalone journal income widget',
      icon: 'ti-chart-line',
      onSelected: () => {
        try { localStorage.setItem(YNAB_JWIDGET_OVERRIDE_LS, 'off'); } catch (_) {}
        this._refreshJournalWidgetPanelsAfterOverrideChange();
        this.ui.addToaster?.({ title: 'YNAB', message: 'Standalone journal widget disabled.', autoDestroyTime: 2200, dismissible: true });
      },
    });
    this._cmdJournalWidgetClear = this.ui.addCommandPaletteCommand({
      label: 'YNAB: Clear journal widget override (use collection config)',
      icon: 'ti-adjustments',
      onSelected: () => {
        try { localStorage.removeItem(YNAB_JWIDGET_OVERRIDE_LS); } catch (_) {}
        this._refreshJournalWidgetPanelsAfterOverrideChange();
        this.ui.addToaster?.({ title: 'YNAB', message: 'Journal widget follows collection config.', autoDestroyTime: 2200, dismissible: true });
      },
    });

    try {
      const p0 = this.ui.getActivePanel();
      if (p0) requestAnimationFrame(() => this._handlePanel(p0));
    } catch (_) {}
    setTimeout(() => { const p = this.ui.getActivePanel(); if (p) this._handlePanel(p); }, 120);
    // No auto-sync on load — sync is manual only (avoids freezing on large budgets)
  }

  onUnload() {
    if (globalThis.__ynabBusinessPlugin === this) globalThis.__ynabBusinessPlugin = undefined;
    if (globalThis.__ynabPluginSettingsPlugin === this) globalThis.__ynabPluginSettingsPlugin = undefined;
    this._ynabUiCssInstalled = false;
    this._ynabCollsKey = null;
    this._ynabCollsResolved = false;
    this._ynabTxnColl = null;
    for (const id of (this._eventIds || [])) { try { this.events.off(id); } catch {} }
    this._eventIds = [];
    for (const t of (this._ynNavTimers || new Map()).values()) { try { clearTimeout(t); } catch {} }
    this._ynNavTimers?.clear();
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

  // ── Dashboard view ──────────────────────────────────────────────────────────

  _dashboardView(ctx) {
    let el, container;
    let refreshTimer = null;
    const dashKey = `ynab-dash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    /**
     * If the user is mid-type (date range, filter input, search box, …) we don’t want
     * to wipe out their focus by re-rendering. Re-arm the timer for another 1200ms and
     * try again later. Otherwise the previous typing fix becomes “focus thrashing.”
     */
    const tick = () => {
      refreshTimer = null;
      if (!container) return;
      if (_ynabIsUserEditingInside(container)) {
        globalThis.__thymerDiag?.record?.('YNAB_PANEL_REFRESH_DEFERRED_TYPING');
        refreshTimer = setTimeout(tick, 1200);
        return;
      }
      void this._renderDash(container);
    };
    /**
     * `debouncedRefresh` is invoked exclusively by our own code now (see the
     * `onRefresh` block comment below). We register it in `_dashRefreshers` so
     * sync (`_syncAll`) and any future "data changed, please repaint" call sites
     * can iterate the map and fire each open dashboard. Coalesces a tight burst
     * of internal triggers into a single render.
     */
    const debouncedRefresh = () => {
      globalThis.__thymerDiag?.record?.('YNAB_PANEL_REFRESH_FIRED');
      if (refreshTimer != null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(tick, 400);
    };
    return _ynabStubViewMethods({
      onLoad: () => {
        globalThis.__thymerDiag?.record?.('YNAB_PANEL_OPEN');
        ctx.makeWideLayout?.();
        el = ctx.getElement();
        el.style.overflow = 'auto';
        container = document.createElement('div');
        el.appendChild(container);
        if (!this._dashRefreshers) this._dashRefreshers = new Map();
        this._dashRefreshers.set(dashKey, debouncedRefresh);
        void this._renderDash(container);
      },
      /**
       * **Manual refresh model** — Thymer fires `onRefresh` on every open panel for
       * every collection write, including from sibling plugins (e.g. Bilt writes
       * to Plugin Backend → all YNAB dashboards repaint). For a panel that parses
       * 1500+ cached transactions and rebuilds dozens of charts, that cascade was
       * causing visible jank and dashboard flicker.
       *
       * The dashboard now repaints only when:
       *  - The panel is opened (initial render)
       *  - The user clicks the in-dashboard "Refresh" button
       *  - `_syncAll` finishes (we iterate `_dashRefreshers` after the sync writes)
       *  - Any future internal write site explicitly fires its dashKey's refresher
       *
       * If you ever want the old auto-repaint-on-every-write behavior back, swap the
       * body below for `debouncedRefresh()`. Recorded as `YNAB_PANEL_REFRESH_IGNORED`
       * so the deep-instrumentation diagnostic can confirm we're skipping these.
       */
      onRefresh: () => {
        globalThis.__thymerDiag?.record?.('YNAB_PANEL_REFRESH_IGNORED');
      },
      onDestroy: () => {
        globalThis.__thymerDiag?.record?.('YNAB_PANEL_CLOSE');
        if (refreshTimer != null) {
          try {
            clearTimeout(refreshTimer);
          } catch (_) {}
          refreshTimer = null;
        }
        try {
          this._dashRefreshers?.delete(dashKey);
        } catch (_) {}
        container = null;
        el = null;
      },
    });
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
      const txns = await getTransactions();
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
    const thisMonthPreset = presets()[0];
    const fromVal = ls(SK.DASH_FROM) || thisMonthPreset.from;
    const toVal   = ls(SK.DASH_TO)   || thisMonthPreset.to;

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
    const ps = presets();
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
      filterSummaryEl.textContent = `${inclCount} income payees · ${exclGroups.length} expense groups excluded`;
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

    // ── Chart ──
    const chartSection=document.createElement('div');
    const chartTitle=document.createElement('div'); chartTitle.className='ynab-section-title';
    const chartWrap=document.createElement('div'); chartWrap.className='ynab-dash-chart-wrap';
    const canvas=document.createElement('canvas'); chartWrap.appendChild(canvas);
    chartSection.append(chartTitle, chartWrap);
    wrap.appendChild(chartSection);

    // ── Group totals ──
    const groupWrap=document.createElement('div'); wrap.appendChild(groupWrap);

    let dashChart=null;
    const taxesRef = { fn: null }; // ref to rebuildTaxes, set after declaration

    const rebuild = () => {
      const from=fromInput.value, to=toInput.value;
      const ex=lsJson(SK.EXCLUDED_GROUPS,DEFAULT_EXCLUDED);

      const isIncluded = t => isIncomeTransaction(t, allTxns);

      const rangeTxns   = allTxns.filter(t=>t.date>=from && t.date<=to);
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

      // Chart — monthly income and expenses for the range
      const fromDate=new Date(from+'T12:00:00'), toDate=new Date(to+'T12:00:00');
      const months=[];
      const d=new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
      while (d<=toDate) { months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); d.setMonth(d.getMonth()+1); }
      const incByMonth  = months.map(k=>rangeTxns.filter(t=>isIncluded(t) && t.date.startsWith(k)).reduce((a,t)=>a+t.amount,0));
      const expByMonth  = months.map(k=>rangeTxns.filter(t=>t.type==='expense' && !ex.includes(t.category_group) && t.date.startsWith(k)).reduce((a,t)=>a+Math.abs(t.amount),0));
      const mLabels     = months.map(k=>{ const [y,mo]=k.split('-'); return new Date(y,mo-1,1).toLocaleString('default',{month:'short',year:'2-digit'}); });

      chartTitle.textContent=`Income & Expenses — ${from} → ${to}`;
      if (dashChart) { try { dashChart.destroy(); } catch {} }
      dashChart=new window.Chart(canvas, {
        type:'bar',
        data:{ labels:mLabels, datasets:[
          { label:'Income',   data:incByMonth,  backgroundColor:`rgba(${C.greenRgb},0.75)`, borderColor:C.green,     borderWidth:1 },
          { label:'Expenses', data:expByMonth, backgroundColor:'rgba(184,64,64,0.55)',        borderColor:'#b84040', borderWidth:1 },
        ]},
        options:{
          responsive:true, maintainAspectRatio:false, animation:{duration:200},
          plugins:{ legend:{labels:{color:C.axisText,font:{size:10},boxWidth:14}} },
          scales:{
            x:{ticks:{color:C.axisText,font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'}},
            y:{ticks:{color:C.axisText,font:{size:10},callback:v=>`$${v}`},grid:{color:'rgba(255,255,255,0.04)'},beginAtZero:true},
          },
        },
      });

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
        t.date >= tf && t.date <= tt
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
      const taxTxns = allTxns.filter(t=>t.type==='expense' && /taxes?/i.test(t.category_group) && t.date>=tf && t.date<=tt);
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
    const token = ls(SK.TOKEN), budgetId = ls(SK.BUDGET_ID);
    if (!token || !budgetId) {
      this.ui.addToaster({title:'YNAB',message:'Configure token first',dismissible:true,autoDestroyTime:5000});
      return;
    }
    try {
      this.ui.addToaster({title:'YNAB',message:'Fetching transactions…',dismissible:false,autoDestroyTime:3000});
      const txns = await getTransactions(force);

      const collections = await this.data.getAllCollections();
      const coll = collections.find(c => c.getName() === YNAB_COLLECTION_NAME);
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
          // Use Thymer's DateTime.dateOnly() — month is 0-indexed per SDK reference
          const [dy, dm, dd] = txn.date.split('-').map(Number);
          const dateProp = record.prop('date');
          if (dateProp) {
            try {
              // DateTime.dateOnly is the correct Thymer SDK method for date-only fields
              const dt = DateTime.dateOnly(dy, dm - 1, dd);
              dateProp.set(dt.value());
            } catch(_) {
              // Fallback: plain Date object
              try { dateProp.set(new Date(dy, dm - 1, dd, 12, 0, 0)); } catch(__) {}
            }
          }
          record.prop('payee')?.set(txn.payee);
          record.prop('amount')?.set(txn.amount);
          record.prop('category')?.set(txn.category);
          record.prop('category_group')?.set(txn.category_group);
          record.prop('memo')?.set(txn.memo);
          record.prop('account')?.set(txn.account);
          record.prop('ynab_id')?.set(txn.id);
          record.prop('synced_at')?.set(new Date());
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
    const rangeTxns = allTxns.filter(t => t.date >= from && t.date <= to);

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

  _showConfigDialog() {
    const overlay = document.createElement('div'); overlay.className='ynab-overlay';
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
