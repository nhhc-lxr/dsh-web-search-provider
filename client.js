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
        backends: 'Backends',
        searchBackend: 'web_search',
        fetchBackend: 'web_fetch',
        keys: 'API keys',
        save: 'Save',
        clear: 'Clear',
        edit: 'Edit',
        cancel: 'Cancel',
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
      },
      zh: {
        tab: '网页工具',
        title: '网页工具后端',
        backends: '后端选择',
        searchBackend: 'web_search',
        fetchBackend: 'web_fetch',
        keys: 'API 密钥',
        save: '保存',
        clear: '清除',
        edit: '编辑',
        cancel: '取消',
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
      title: { margin: '0 0 14px', fontSize: 15, fontWeight: 600 },
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
        boxSizing: 'border-box',
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
        boxSizing: 'border-box',
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
        boxSizing: 'border-box',
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
      iconButton: {
        boxSizing: 'border-box',
        height: 30,
        width: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 7,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
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

    const ICONS = {
      edit: ['M11.3 2.4a1.7 1.7 0 0 1 2.4 2.4L5.9 12.6l-3.3.6.6-3.3z'],
      trash: ['M2.8 4.4h10.4', 'M6.4 4.4V2.9h3.2v1.5', 'M4.3 4.4l.7 8.1h6l.7-8.1'],
      check: ['M3.1 8.4l3.2 3.2 6.6-6.8'],
      close: ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6'],
    }

    function Icon({ name }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        (ICONS[name] || []).map((d, index) => h('path', { key: index, d })),
      )
    }

    const clone = (value) => JSON.parse(JSON.stringify(value))
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
      const [editingKeys, setEditingKeys] = React.useState({})
      const t = React.useMemo(() => createTranslate({ get: () => undefined }), [])

      const stateRef = React.useRef(null)
      const timerRef = React.useRef(null)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await readState()
          stateRef.current = payload
          setState(payload)
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      React.useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        },
        [],
      )

      /** Auto-save: keep local edits, only refresh the fields the host owns. */
      const commit = React.useCallback(
        async (body) => {
          try {
            const payload = await writeState(body)
            setError('')
            setState((current) =>
              current
                ? { ...current, keys: payload.keys || current.keys, stateFile: payload.stateFile || current.stateFile }
                : current,
            )
            if (payload.persistence && payload.persistence.persisted === false) {
              setNotice(`${t('localOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t('saved'))
            }
          } catch (cause) {
            setError(String(cause && cause.message ? cause.message : cause))
          }
        },
        [t],
      )

      const snapshotBody = (current) => ({
        search: { backend: current.search.backend },
        fetch: { backend: current.fetch.backend },
      })
      const edit = (mutate) => {
        const next = clone(stateRef.current)
        mutate(next)
        stateRef.current = next
        setState(next)
        return next
      }

      const saveNow = (next) => commit(snapshotBody(next))

      const applyKeys = React.useCallback(
        async (body, kind) => {
          setBusy(true)
          setNotice('')
          try {
            const payload = await writeState(body)
            stateRef.current = payload
            setState(payload)
            setError('')
            if (payload.persistence && payload.persistence.persisted === false) {
              setNotice(`${t('localOnly')}${payload.persistence.reason || ''}`)
            } else {
              setNotice(t(kind))
            }
            const touched = body.setKey ? body.setKey.vendor : body.clearKey ? body.clearKey.vendor : undefined
            if (body.setKey) setDraftKeys((current) => ({ ...current, [body.setKey.vendor]: '' }))
            if (touched !== undefined) setEditingKeys((current) => ({ ...current, [touched]: false }))
          } catch (cause) {
            setError(String(cause && cause.message ? cause.message : cause))
          } finally {
            setBusy(false)
          }
        },
        [t],
      )

      if (state === null && error === '') {
        return h('div', { style: styles.page }, h('p', { style: styles.note }, t('loading')))
      }
      if (state === null) {
        return h('div', { style: styles.page }, h('p', { style: styles.error }, `${t('loadFailed')}${error}`))
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
              onChange: (event) =>
                saveNow(
                  edit((next) => {
                    next.search.backend = event.target.value
                  }),
                ),
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
              onChange: (event) =>
                saveNow(
                  edit((next) => {
                    next.fetch.backend = event.target.value
                  }),
                ),
            },
            VENDORS.map(optionTag),
          ),
        ),
      )

      const iconButton = (name, label, onClick, options = {}) =>
        h(
          'button',
          {
            type: 'button',
            style: { ...styles.iconButton, color: options.color || styles.iconButton.color },
            title: label,
            'aria-label': label,
            disabled: options.disabled === true,
            onClick,
          },
          h(Icon, { name }),
        )

      const keyRows = VENDORS.map((vendor) => {
        const key = (state.keys && state.keys[vendor]) || {}
        const draft = draftKeys[vendor] === undefined ? '' : draftKeys[vendor]
        const configured = Boolean(key.configured)
        const editing = editingKeys[vendor] === true || !configured
        const actions = []

        if (editing) {
          actions.push(
            iconButton('check', t('save'), () => applyKeys({ setKey: { vendor, value: draft.trim() } }, 'saved'), {
              color: 'var(--dsw-alias-brand-primary)',
              disabled: busy || draft.trim() === '',
            }),
          )
          if (configured) {
            actions.push(
              iconButton('close', t('cancel'), () => setEditingKeys((current) => ({ ...current, [vendor]: false }))),
            )
          }
        } else {
          actions.push(
            iconButton('edit', t('edit'), () => setEditingKeys((current) => ({ ...current, [vendor]: true }))),
            iconButton('trash', t('clear'), () => applyKeys({ clearKey: { vendor } }, 'cleared'), {
              color: 'var(--dsw-alias-state-error-primary)',
              disabled: busy,
            }),
          )
        }

        return h(
          'div',
          { key: vendor, style: { ...styles.row, flexWrap: 'nowrap', height: 34, marginBottom: 4 } },
          h('span', { style: styles.vendor }, labelOf(vendor)),
          keyBadge(t, key),
          editing
            ? h('input', {
                key: 'input',
                style: { ...styles.input, flex: '1 1 160px', minWidth: 130 },
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: `${t('keyPlaceholder')} (${key.ref || vendor})`,
                value: draft,
                disabled: busy,
                onChange: (event) => setDraftKeys({ ...draftKeys, [vendor]: event.target.value }),
              })
            : h('div', { key: 'spacer', style: { flex: '1 1 160px', minWidth: 130, height: 30 } }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flex: '0 0 auto' } },
            ...actions,
          ),
        )
      })

      return h(
        'div',
        { style: styles.page },
        h('h2', { style: styles.title }, t('title')),
        backends,
        h('div', { style: styles.card }, h('h3', { style: styles.cardTitle }, t('keys')), keyRows),
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
