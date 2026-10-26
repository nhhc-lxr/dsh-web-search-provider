window.__ModuleLoader__.load({
  id: 'dsh-web-tool-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/web-tool-provider/state'
    const VENDORS = ['tavily', 'exa', 'firecrawl']
    const LABELS = { tavily: 'Tavily', exa: 'Exa', firecrawl: 'Firecrawl' }
    const labelOf = (vendor) => LABELS[vendor] || vendor

    const DICT = {
      en: {
        tab: 'Web tools',
        title: 'Web tool provider',
        subtitle:
          'Pick one backend for each tool. Keys live in the harness credential store; every other vendor parameter is handled by the plugin.',
        backends: 'Backends',
        searchBackend: 'web_search',
        fetchBackend: 'web_fetch',
        options: 'Shared options',
        includeDomains: 'Only these domains',
        excludeDomains: 'Exclude these domains',
        fallback: 'Fall back to a direct HTTP fetch when the backend fails',
        keys: 'API keys',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved',
        cleared: 'Cleared',
        localOnly: 'Applied now, but not persisted: ',
        configured: 'configured',
        fromEnv: 'from environment',
        fromConfig: 'from plugin config',
        missing: 'not configured',
        loading: 'Loading…',
        loadFailed: 'Could not read the plugin state: ',
        keyPlaceholder: 'Paste the key',
        domainsPlaceholder: 'a.com, b.com',
        perCall: 'Applies to the next call — no restart needed.',
      },
      zh: {
        tab: '网页工具',
        title: '网页工具后端',
        subtitle: '给两个工具各选一个后端。密钥存在 Harness 凭据库里，其余厂商参数由插件负责。',
        backends: '后端选择',
        searchBackend: '搜索 web_search',
        fetchBackend: '抓取 web_fetch',
        options: '通用选项',
        includeDomains: '只搜这些域名',
        excludeDomains: '排除这些域名',
        fallback: '后端失败时退回直接 HTTP 抓取',
        keys: 'API 密钥',
        save: '保存',
        clear: '清除',
        saved: '已保存',
        cleared: '已清除',
        localOnly: '已生效，但未能持久化：',
        configured: '已配置',
        fromEnv: '来自环境变量',
        fromConfig: '来自插件配置',
        missing: '未配置',
        loading: '加载中…',
        loadFailed: '读取插件状态失败：',
        keyPlaceholder: '粘贴密钥',
        domainsPlaceholder: 'a.com, b.com',
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
      page: { padding: '4px 0 24px', maxWidth: 640, color: 'var(--dsw-alias-label-primary)' },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      subtitle: { margin: '0 0 16px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        marginBottom: 14,
      },
      cardTitle: { margin: '0 0 12px', fontSize: 13, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, minWidth: 130, color: 'var(--dsw-alias-label-secondary)' },
      select: {
        flex: '1 1 180px',
        minWidth: 150,
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
        minWidth: 170,
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
      vendor: { fontSize: 12, fontWeight: 600, minWidth: 76 },
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid currentColor',
        whiteSpace: 'nowrap',
      },
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

    const joinDomains = (value) => (Array.isArray(value) ? value.join(', ') : '')
    const splitDomains = (value) =>
      String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)

    function badgeStyle(kind) {
      if (kind === 'no') return { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' }
      return { ...styles.badge, color: 'var(--dsw-alias-state-success-primary)' }
    }

    function keyBadge(t, key) {
      const configured = key && key.configured
      const source = key && key.source
      let label = configured ? t('configured') : t('missing')
      if (configured && source === 'env') label = `${t('configured')} · ${t('fromEnv')}`
      else if (configured && source === 'config') label = `${t('configured')} · ${t('fromConfig')}`
      return h('span', { style: badgeStyle(configured ? 'yes' : 'no') }, label)
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
              setNotice(`${t('localOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t(kind))
            }
            if (kind === 'saved' && body.setKey) {
              setDraftKeys((current) => ({ ...current, [body.setKey.vendor]: '' }))
            }
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

      const edit = (mutate) => {
        const next = JSON.parse(JSON.stringify(state))
        mutate(next)
        setState(next)
      }

      const optionTag = (value) => h('option', { key: value, value }, labelOf(value))

      const backends = h(
        'div',
        { style: styles.card },
        h('h3', { style: styles.cardTitle }, t('backends')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('searchBackend')),
          h(
            'select',
            {
              style: styles.select,
              value: state.search.backend,
              disabled: busy,
              onChange: (event) =>
                edit((next) => {
                  next.search.backend = event.target.value
                }),
            },
            VENDORS.map(optionTag),
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
              value: state.fetch.backend,
              disabled: busy,
              onChange: (event) =>
                edit((next) => {
                  next.fetch.backend = event.target.value
                }),
            },
            VENDORS.map(optionTag),
          ),
        ),
      )

      const options = h(
        'div',
        { style: styles.card },
        h('h3', { style: styles.cardTitle }, t('options')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('includeDomains')),
          h('input', {
            style: styles.input,
            type: 'text',
            placeholder: t('domainsPlaceholder'),
            value: joinDomains(state.search.options.includeDomains),
            disabled: busy,
            onChange: (event) =>
              edit((next) => {
                next.search.options.includeDomains = splitDomains(event.target.value)
              }),
          }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('excludeDomains')),
          h('input', {
            style: styles.input,
            type: 'text',
            placeholder: t('domainsPlaceholder'),
            value: joinDomains(state.search.options.excludeDomains),
            disabled: busy,
            onChange: (event) =>
              edit((next) => {
                next.search.options.excludeDomains = splitDomains(event.target.value)
              }),
          }),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, t('fallback')),
          h('input', {
            type: 'checkbox',
            checked: Boolean(state.fetch.options.fallbackToHttp),
            disabled: busy,
            onChange: (event) =>
              edit((next) => {
                next.fetch.options.fallbackToHttp = event.target.checked
              }),
          }),
        ),
      )

      const keyRows = VENDORS.map((vendor) => {
        const key = (state.keys && state.keys[vendor]) || {}
        const draft = draftKeys[vendor] === undefined ? '' : draftKeys[vendor]
        return h(
          'div',
          { key: vendor, style: styles.row },
          h('span', { style: styles.vendor }, labelOf(vendor)),
          keyBadge(t, key),
          h('input', {
            style: styles.input,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: `${t('keyPlaceholder')} (${key.ref || vendor})`,
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
        backends,
        options,
        h('div', { style: styles.card }, h('h3', { style: styles.cardTitle }, t('keys')), keyRows),
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
                apply(
                  {
                    search: {
                      backend: state.search.backend,
                      options: {
                        includeDomains: state.search.options.includeDomains,
                        excludeDomains: state.search.options.excludeDomains,
                      },
                    },
                    fetch: {
                      backend: state.fetch.backend,
                      options: { fallbackToHttp: state.fetch.options.fallbackToHttp },
                    },
                  },
                  'saved',
                ),
            },
            t('save'),
          ),
        ),
        notice === '' ? null : h('p', { style: styles.ok }, notice),
        error === '' ? null : h('p', { style: styles.error }, error),
        h('p', { style: styles.note }, t('perCall')),
        state.stateFile ? h('p', { style: styles.note }, state.stateFile) : null,
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
