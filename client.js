window.__ModuleLoader__.load({
  id: 'dsh-web-tool-provider',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/web-tool-provider/state'
    const VENDORS = ['tavily', 'exa', 'firecrawl']
    const TOPICS = ['general', 'news', 'finance']
    const TYPES = ['auto', 'lite', 'deep']
    const VERSIONS = ['v2', 'v1']

    const DICT = {
      en: {
        tab: 'Web tools',
        title: 'Web tool provider',
        subtitle:
          'One provider in front of web_search and web_fetch. Shared options are set once per tool; each backend keeps its own connection settings.',
        tabsSearch: 'web_search',
        tabsFetch: 'web_fetch',
        common: 'Shared search options',
        commonFetch: 'Shared fetch options',
        keys: 'API keys',
        active: 'active',
        use: 'Use for this tool',
        save: 'Save',
        clear: 'Clear',
        saved: 'Saved',
        cleared: 'Cleared',
        localOnly: 'Applied now, but not persisted: ',
        configured: 'configured',
        fromEnv: 'from environment',
        fromConfig: 'from plugin config',
        missing: 'not configured',
        partial: 'partial',
        includeDomains: 'Only these domains',
        excludeDomains: 'Exclude these domains',
        answer: 'Return a synthesized answer',
        fallback: 'Fall back to a direct HTTP fetch when the backend fails',
        baseURL: 'API base URL',
        timeoutMs: 'Timeout (ms)',
        maxChars: 'Max characters',
        topic: 'Topic',
        searchDepth: 'Depth (basic / advanced)',
        searchType: 'Depth (lite / auto / deep)',
        version: 'API version',
        mainContent: 'Only main content',
        maxAge: 'Cache max age (ms)',
        loading: 'Loading…',
        loadFailed: 'Could not read the plugin state: ',
        keyPlaceholder: 'Paste the key',
        perCall: 'Applies to the next call — no restart needed.',
        domainsPlaceholder: 'a.com, b.com',
        auto: 'auto',
        fast: 'fast',
        balanced: 'balanced',
        deep: 'deep',
        general: 'general',
        news: 'news',
        finance: 'finance',
        lite: 'lite',
        basic: 'basic',
        advanced: 'advanced',
        v1: 'v1',
        v2: 'v2',
      },
      zh: {
        tab: '网页工具',
        title: '网页工具后端',
        subtitle:
          'web_search 与 web_fetch 共用一个 provider。通用参数按工具各设一次，各家只保留自己的连接与行为设置。',
        tabsSearch: '搜索 web_search',
        tabsFetch: '抓取 web_fetch',
        common: '通用搜索参数',
        commonFetch: '通用抓取参数',
        keys: 'API 密钥',
        active: '使用中',
        use: '设为该工具后端',
        save: '保存',
        clear: '清除',
        saved: '已保存',
        cleared: '已清除',
        localOnly: '已生效，但未能持久化：',
        configured: '已配置',
        fromEnv: '来自环境变量',
        fromConfig: '来自插件配置',
        missing: '未配置',
        partial: '部分支持',
        includeDomains: '只搜这些域名',
        excludeDomains: '排除这些域名',
        answer: '返回合成答案',
        fallback: '后端失败时退回直接 HTTP 抓取',
        baseURL: '接口地址',
        timeoutMs: '超时（毫秒）',
        maxChars: '正文上限（字符）',
        topic: '主题',
        searchDepth: '深度（基础 / 进阶）',
        searchType: '深度（轻量 / 自动 / 深度）',
        version: '接口版本',
        mainContent: '只取正文',
        maxAge: '缓存有效期（毫秒）',
        loading: '加载中…',
        loadFailed: '读取插件状态失败：',
        keyPlaceholder: '粘贴密钥',
        perCall: '下一次调用即生效，不用重启。',
        domainsPlaceholder: 'a.com, b.com',
        auto: '自动',
        fast: '快',
        balanced: '均衡',
        deep: '深度',
        general: '综合',
        news: '新闻',
        finance: '财经',
        lite: '轻量',
        basic: '基础',
        advanced: '进阶',
        v1: 'v1',
        v2: 'v2',
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
      page: { padding: '4px 0 24px', maxWidth: 780, color: 'var(--dsw-alias-label-primary)' },
      title: { margin: '0 0 6px', fontSize: 15, fontWeight: 600 },
      subtitle: { margin: '0 0 16px', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        marginBottom: 14,
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px', flexWrap: 'wrap' },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, minWidth: 150, color: 'var(--dsw-alias-label-secondary)' },
      select: {
        flex: '1 1 170px',
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
        flex: '1 1 200px',
        minWidth: 160,
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
      tabBar: { display: 'flex', gap: 6, marginBottom: 14 },
      tab: (active) => ({
        height: 30,
        padding: '0 14px',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        background: active ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
        border: `1px solid ${active ? 'var(--dsw-alias-border-l2)' : 'transparent'}`,
        borderRadius: 8,
        cursor: 'pointer',
      }),
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid currentColor',
        whiteSpace: 'nowrap',
      },
      vendorName: { fontSize: 12, fontWeight: 600, minWidth: 76 },
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

    const clone = (value) => JSON.parse(JSON.stringify(value))
    const joinDomains = (value) => (Array.isArray(value) ? value.join(', ') : '')
    const splitDomains = (value) =>
      String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)

    function badgeStyle(kind) {
      if (kind === 'no') return { ...styles.badge, color: 'var(--dsw-alias-state-error-primary)' }
      if (kind === 'partial') return { ...styles.badge, color: 'var(--dsw-alias-state-warn-primary)' }
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
      const [tab, setTab] = React.useState('search')
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
        const next = clone(state)
        mutate(next)
        setState(next)
      }

      const optionTag = (value) => h('option', { key: value, value }, t(value))

      const numericRow = (label, value, onInput) =>
        h(
          'div',
          { style: styles.row, key: label },
          h('span', { style: styles.label }, label),
          h('input', {
            style: styles.input,
            type: 'number',
            value: value,
            disabled: busy,
            onChange: (event) => onInput(Number(event.target.value)),
          }),
        )

      const textRow = (label, value, onInput, placeholder) =>
        h(
          'div',
          { style: styles.row, key: label },
          h('span', { style: styles.label }, label),
          h('input', {
            style: styles.input,
            type: 'text',
            value: value,
            placeholder: placeholder || '',
            disabled: busy,
            onChange: (event) => onInput(event.target.value),
          }),
        )

      const selectRow = (label, value, values, onChange) =>
        h(
          'div',
          { style: styles.row, key: label },
          h('span', { style: styles.label }, label),
          h(
            'select',
            {
              style: styles.select,
              value: value,
              disabled: busy,
              onChange: (event) => onChange(event.target.value),
            },
            values.map(optionTag),
          ),
        )

      const searchCommon = h(
        'div',
        { style: styles.card },
        h('h3', { style: styles.cardTitle }, t('common')),
        textRow(
          t('includeDomains'),
          joinDomains(state.search.options.includeDomains),
          (value) =>
            edit((next) => {
              next.search.options.includeDomains = splitDomains(value)
            }),
          t('domainsPlaceholder'),
        ),
        textRow(
          t('excludeDomains'),
          joinDomains(state.search.options.excludeDomains),
          (value) =>
            edit((next) => {
              next.search.options.excludeDomains = splitDomains(value)
            }),
          t('domainsPlaceholder'),
        ),
      )

      const fetchCommon = h(
        'div',
        { style: styles.card },
        h('h3', { style: styles.cardTitle }, t('commonFetch')),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, ''),
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(state.fetch.options.fallbackToHttp),
              disabled: busy,
              onChange: (event) =>
                edit((next) => {
                  next.fetch.options.fallbackToHttp = event.target.checked
                }),
            }),
            t('fallback'),
          ),
        ),
        h('p', { style: styles.note }, t('perCall')),
      )

      const providerCard = (vendor) => {
        const provider = state.providers[vendor]
        const activeBackend = tab === 'search' ? state.search.backend : state.fetch.backend
        const isActive = activeBackend === vendor
        const rows = [
          textRow(
            t('baseURL'),
            provider.baseURL,
            (value) =>
              edit((next) => {
                next.providers[vendor].baseURL = value
              }),
            '',
          ),
          numericRow(t('timeoutMs'), provider.timeoutMs, (value) =>
            edit((next) => {
              next.providers[vendor].timeoutMs = value
            }),
          ),
          numericRow(t('maxChars'), provider.maxChars, (value) =>
            edit((next) => {
              next.providers[vendor].maxChars = value
            }),
          ),
        ]

        if (tab === 'search' && vendor === 'tavily') {
          rows.push(
            selectRow(t('topic'), provider.topic, TOPICS, (value) =>
              edit((next) => {
                next.providers.tavily.topic = value
              }),
            ),
            selectRow(t('searchDepth'), provider.searchDepth, ['basic', 'advanced'], (value) =>
              edit((next) => {
                next.providers.tavily.searchDepth = value
              }),
            ),
            h(
              'div',
              { style: styles.row, key: 'answer' },
              h('span', { style: styles.label }, ''),
              h(
                'label',
                { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(provider.answer),
                  disabled: busy,
                  onChange: (event) =>
                    edit((next) => {
                      next.providers.tavily.answer = event.target.checked
                    }),
                }),
                t('answer'),
              ),
            ),
          )
        }
        if (tab === 'search' && vendor === 'exa') {
          rows.push(
            selectRow(t('searchType'), provider.searchType, TYPES, (value) =>
              edit((next) => {
                next.providers.exa.searchType = value
              }),
            ),
          )
        }
        if (vendor === 'firecrawl') {
          rows.push(
            selectRow(t('version'), provider.version, VERSIONS, (value) =>
              edit((next) => {
                next.providers.firecrawl.version = value
              }),
            ),
          )
          if (tab === 'fetch') {
            rows.push(
              h(
                'div',
                { style: styles.row, key: 'mainContent' },
                h('span', { style: styles.label }, ''),
                h(
                  'label',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(provider.mainContent),
                    disabled: busy,
                    onChange: (event) =>
                      edit((next) => {
                        next.providers.firecrawl.mainContent = event.target.checked
                      }),
                  }),
                  t('mainContent'),
                ),
              ),
              numericRow(t('maxAge'), provider.maxAge, (value) =>
                edit((next) => {
                  next.providers.firecrawl.maxAge = value
                }),
              ),
            )
          }
        }

        return h(
          'div',
          { style: styles.card, key: vendor },
          h(
            'div',
            { style: styles.cardHead },
            h('span', { style: styles.vendorName }, vendor),
            keyBadge(t, provider.key),
            isActive ? h('span', { style: badgeStyle('yes') }, t('active')) : null,
            isActive
              ? null
              : h(
                  'button',
                  {
                    style: styles.button,
                    disabled: busy,
                    onClick: () =>
                      apply(
                        tab === 'search' ? { search: { backend: vendor } } : { fetch: { backend: vendor } },
                        'saved',
                      ),
                  },
                  t('use'),
                ),
          ),
          rows,
        )
      }

      const saveTab = () => {
        const body =
          tab === 'search'
            ? {
                search: { backend: state.search.backend, options: state.search.options },
                providers: state.providers,
              }
            : {
                fetch: { backend: state.fetch.backend, options: state.fetch.options },
                providers: state.providers,
              }
        apply(body, 'saved')
      }

      const keyRows = VENDORS.map((vendor) => {
        const key = state.providers[vendor].key || {}
        const draft = draftKeys[vendor] === undefined ? '' : draftKeys[vendor]
        return h(
          'div',
          { key: vendor, style: styles.row },
          h('span', { style: styles.vendorName }, vendor),
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
        h('div', { style: styles.card }, h('h3', { style: styles.cardTitle }, t('keys')), keyRows),
        h(
          'div',
          { style: styles.tabBar },
          h('button', { style: styles.tab(tab === 'search'), onClick: () => setTab('search') }, t('tabsSearch')),
          h('button', { style: styles.tab(tab === 'fetch'), onClick: () => setTab('fetch') }, t('tabsFetch')),
        ),
        tab === 'search' ? searchCommon : fetchCommon,
        VENDORS.map(providerCard),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.label }, ''),
          h('button', { style: styles.primary, disabled: busy, onClick: saveTab }, t('save')),
        ),
        notice === '' ? null : h('p', { style: styles.ok }, notice),
        error === '' ? null : h('p', { style: styles.error }, error),
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
