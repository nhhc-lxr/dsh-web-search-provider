window.__ModuleLoader__.load({
  id: 'dsh-web-tool-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/web-tool-provider/state'
    const VENDORS = ['tavily', 'exa', 'firecrawl']

    const DICT = {
      en: {
        tab: 'Web tools',
        title: 'Web tool provider',
        subtitle:
          'Choose which backend answers web_search and web_fetch. Keys are stored by the harness credential store, never in the profile YAML.',
        searchBackend: 'web_search backend',
        fetchBackend: 'web_fetch backend',
        backendsTitle: 'Backends',
        saveBackends: 'Save backends',
        keys: 'API keys',
        configured: 'configured',
        fromEnv: 'from environment',
        fromConfig: 'from plugin config',
        missing: 'not configured',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved',
        cleared: 'Cleared',
        savedLocalOnly: 'Applied now, but not persisted: ',
        fallbackOn: 'web_fetch falls back to a credential-free local fetch when the backend fails.',
        fallbackOff: 'web_fetch has no fallback: a backend failure is returned to the model.',
        loading: 'Loading…',
        loadFailed: 'Could not read the plugin state: ',
        keyPlaceholder: 'Paste the key',
        perCall: 'Applies to the next call — no restart needed.',
      },
      zh: {
        tab: '网页工具',
        title: '网页工具后端',
        subtitle: '选择 web_search 与 web_fetch 走哪个后端。密钥存在 Harness 凭据库里，不写进 profile 的 YAML。',
        searchBackend: 'web_search 后端',
        fetchBackend: 'web_fetch 后端',
        backendsTitle: '后端选择',
        saveBackends: '保存后端',
        keys: 'API 密钥',
        configured: '已配置',
        fromEnv: '来自环境变量',
        fromConfig: '来自插件配置',
        missing: '未配置',
        save: '保存',
        clear: '清除',
        saved: '已保存',
        cleared: '已清除',
        savedLocalOnly: '已生效，但未能持久化：',
        fallbackOn: '后端失败时，web_fetch 会退回无需密钥的本地抓取。',
        fallbackOff: 'web_fetch 没有降级：后端失败会直接返回给模型。',
        loading: '加载中…',
        loadFailed: '读取插件状态失败：',
        loadingFailed: '读取插件状态失败：',
        keyPlaceholder: '粘贴密钥',
        perCall: '下一次调用即生效，不用重启。',
      },
    }

    function pickLanguage(ctx) {
      const candidates = []
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        const snapshot = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
        if (typeof snapshot === 'string') candidates.push(snapshot)
        else if (snapshot) candidates.push(snapshot.locale, snapshot.id, snapshot.current, snapshot.language)
        const live = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        if (live && typeof live === 'object') candidates.push(live.locale, live.id, live.current, live.language)
      } catch {
        /* locale service unavailable: fall back to the document */
      }
      try {
        candidates.push(document.documentElement.getAttribute('lang'), navigator.language)
      } catch {
        /* not a browser */
      }
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.toLowerCase().startsWith('zh')) return 'zh'
      }
      return 'en'
    }

    function createTranslate(ctx) {
      const language = pickLanguage(ctx)
      const dict = DICT[language] || DICT.en
      return (key) => dict[key] || DICT.en[key] || key
    }

    const styles = {
      page: { padding: '4px 0 24px', maxWidth: 720, color: 'var(--dsw-alias-label-primary)' },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      subtitle: { margin: '0 0 18px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        marginBottom: 14,
      },
      cardTitle: { margin: '0 0 12px', fontSize: 13, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, minWidth: 150, color: 'var(--dsw-alias-label-secondary)' },
      select: {
        flex: '1 1 180px',
        minWidth: 160,
        height: 30,
        padding: '0 8px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
      },
      input: {
        flex: '1 1 220px',
        minWidth: 180,
        height: 30,
        padding: '0 9px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
      },
      button: {
        height: 30,
        padding: '0 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
        cursor: 'pointer',
      },
      primary: {
        height: 30,
        padding: '0 14px',
        fontSize: 12,
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 7,
        cursor: 'pointer',
      },
      keyRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' },
      vendor: { fontSize: 12, fontWeight: 600, minWidth: 78 },
      badge: { fontSize: 11, padding: '2px 7px', borderRadius: 999, border: '1px solid currentColor', whiteSpace: 'nowrap' },
      note: { margin: '10px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' },
    }

    async function readState() {
      const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function writeState(body) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
      return payload
    }

    function badge(t, info) {
      const configured = info && info.configured
      const source = info && info.source
      let label = configured ? t('configured') : t('missing')
      if (configured && source === 'env') label = `${t('configured')} · ${t('fromEnv')}`
      else if (configured && source === 'config') label = `${t('configured')} · ${t('fromConfig')}`
      const color = configured
        ? 'var(--dsw-alias-state-success-primary)'
        : 'var(--dsw-alias-state-warn-primary)'
      return h('span', { style: { ...styles.badge, color } }, label)
    }

    function ProviderPage() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [draftKeys, setDraftKeys] = React.useState({})
      const t = React.useMemo(() => createTranslate({ get: () => undefined }), [])

      const refresh = React.useCallback(async () => {
        try {
          setState(await readState())
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const apply = React.useCallback(
        async (body, kind) => {
          setBusy(true)
          setNotice('')
          try {
            const payload = await writeState(body)
            setState(payload)
            setError('')
            if (payload && payload.persistence && payload.persistence.persisted === false) {
              setNotice(`${t('savedLocalOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t(kind))
            }
            if (kind === 'saved') setDraftKeys((current) => ({ ...current, ...(body.setKey ? { [body.setKey.vendor]: '' } : {}) }))
          } catch (cause) {
            setError(String(cause && cause.message ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        },
        [t],
      )

      if (state === null && error === '') {
        return h('div', { style: styles.page }, h('p', { style: styles.subtitle }, t('loading')))
      }
      if (state === null) {
        return h('div', { style: styles.page }, h('p', { style: styles.error }, `${t('loadFailed')}${error}`))
      }

      const backends = Array.isArray(state.backends) && state.backends.length > 0 ? state.backends : VENDORS
      const option = (value) => h('option', { key: value, value }, value)
      const selects = h(
        'div',
        { style: styles.card },
        h('h3', { style: styles.cardTitle }, t('backendsTitle')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('searchBackend')),
          h(
            'select',
            {
              style: styles.select,
              value: state.searchBackend,
              disabled: busy,
              onChange: (event) => setState({ ...state, searchBackend: event.target.value }),
            },
            backends.map(option),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('fetchBackend')),
          h(
            'select',
            {
              style: styles.select,
              value: state.fetchBackend,
              disabled: busy,
              onChange: (event) => setState({ ...state, fetchBackend: event.target.value }),
            },
            backends.map(option),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, ''),
          h(
            'button',
            {
              style: styles.primary,
              disabled: busy,
              onClick: () =>
                apply({ searchBackend: state.searchBackend, fetchBackend: state.fetchBackend }, 'saved'),
            },
            t('saveBackends'),
          ),
        ),
      )

      const keyRows = VENDORS.map((vendor) => {
        const info = (state.keys && state.keys[vendor]) || {}
        const draft = draftKeys[vendor] === undefined ? '' : draftKeys[vendor]
        return h(
          'div',
          { key: vendor, style: styles.keyRow },
          h('span', { style: styles.vendor }, vendor),
          badge(t, info),
          h('input', {
            style: styles.input,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: `${t('keyPlaceholder')} (${info.ref || vendor})`,
            value: draft,
            disabled: busy,
            onChange: (event) => setDraftKeys({ ...draftKeys, [vendor]: event.target.value }),
          }),
          h(
            'button',
            {
              style: styles.primary,
              disabled: busy || draft.trim() === '',
              onClick: () => apply({ setKey: { vendor, value: draft.trim() } }, 'saved'),
            },
            t('save'),
          ),
          h(
            'button',
            {
              style: styles.button,
              disabled: busy,
              onClick: () => apply({ clearKey: { vendor } }, 'cleared'),
            },
            t('clear'),
          ),
        )
      })

      return h(
        'div',
        { style: styles.page },
        h('h2', { style: styles.title }, t('title')),
        h('p', { style: styles.subtitle }, t('subtitle')),
        selects,
        h(
          'div',
          { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('keys')),
          keyRows,
          h('p', { style: styles.note }, state.fallbackToHttp ? t('fallbackOn') : t('fallbackOff')),
          h('p', { style: styles.note }, t('perCall')),
        ),
        notice === '' ? null : h('p', { style: styles.ok }, notice),
        error === '' ? null : h('p', { style: styles.error }, error),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'web-tool-provider',
              order: 65,
              label: () => createTranslate(ctx)('tab'),
            },
            ProviderPage,
          ),
        )
      },
    }
  },
})
