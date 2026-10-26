import assert from 'node:assert/strict'

const mod = await import('../index.js')

/* --------------------------------------------------------------- harness -- */

const calls = []
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const textResponse = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers })

const originalFetch = globalThis.fetch
function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined })
    if (init.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return handler(String(url), init)
  }
}

function register(config = {}) {
  const registry = []
  const ctx = {
    web: {
      registerSearchProvider: (provider) => { registry.push(provider); return () => {} },
      registerFetchProvider: (provider) => { registry.push(provider); return () => {} },
    },
  }
  mod.apply(ctx, config)
  const search = registry.find((provider) => provider.id === (config.searchProviderId || 'tavily'))
  const fetch = registry.find((provider) => provider.id === (config.fetchProviderId || 'firecrawl'))
  return { registry, search, fetch }
}

const results = []
async function check(name, run) {
  try {
    await run()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ tests -- */

await check('registers one search and one fetch provider with stable ids', async () => {
  const { registry } = register()
  assert.deepEqual(registry.map((provider) => provider.id), ['tavily', 'firecrawl'])
  assert.equal(mod.inject.length, 1)
  assert.equal(mod.inject[0], 'web')
  assert.equal(typeof mod.apply, 'function')
})

await check('availability follows the key source (literal, env, fallback)', async () => {
  delete process.env.TAVILY_API_KEY
  delete process.env.FIRECRAWL_API_KEY
  let { search, fetch } = register({ fallbackToHttp: false })
  assert.equal(search.available(), false)
  assert.equal(fetch.available(), false)

  process.env.TAVILY_API_KEY = 'tvly-env'
  ;({ search, fetch } = register({ fallbackToHttp: false }))
  assert.equal(search.available(), true)
  assert.equal(fetch.available(), false)

  ;({ search, fetch } = register({ tavilyApiKey: 'tvly-literal', tavilyApiKeyEnv: 'MISSING_ENV' }))
  assert.equal(search.available(), true)

  ;({ fetch } = register({ firecrawlApiKey: '', fallbackToHttp: true }))
  assert.equal(fetch.available(), true, 'fallback keeps fetch usable without a key')
  delete process.env.TAVILY_API_KEY
})

await check('rejects invalid provider ids and non-http endpoints', async () => {
  assert.throws(() => register({ searchProviderId: 'has space' }), /not a valid provider id/)
  assert.throws(() => register({ searchProviderId: 'x', fetchProviderId: 'x' }), /must differ/)
  assert.throws(() => register({ tavilyBaseURL: 'ftp://example.com' }), /http: or https:/)
  assert.throws(() => register({ firecrawlBaseURL: 'not-a-url' }), /absolute URL/)
})

await check('tavily: request shape, clamping, mapping, dedup', async () => {
  stubFetch(() =>
    json({
      answer: 'answer text',
      results: [
        { title: 'A', url: 'https://a.test/x', content: 'snippet a', published_date: '2026-01-02' },
        { title: 'A dup', url: 'https://a.test/x', content: 'dup' },
        { title: 'B', url: 'https://b.test/' },
        { url: '' },
      ],
    }),
  )
  const { search } = register({ tavilyApiKey: 'tvly-x', tavilyMaxResults: 6 })
  const result = await search.search({ query: 'hello', maxResults: 4 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.tavily.com/search')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-x')
  assert.deepEqual(calls[0].body, {
    query: 'hello',
    max_results: 4,
    search_depth: 'basic',
    topic: 'general',
    include_answer: true,
  })
  assert.equal(result.content, 'answer text')
  assert.equal(result.truncated, false)
  assert.deepEqual(result.sources, [
    { url: 'https://a.test/x', title: 'A', snippet: 'snippet a', publishedAt: '2026-01-02' },
    { url: 'https://b.test/', title: 'B' },
  ])
})

await check('tavily: request maxResults never exceeds the configured cap', async () => {
  stubFetch(() => json({ results: [] }))
  const { search } = register({ tavilyApiKey: 'tvly-x', tavilyMaxResults: 3 })
  await search.search({ query: 'q', maxResults: 50 })
  assert.equal(calls[0].body.max_results, 3)
})

await check('tavily: HTTP failures and missing credentials stay structured', async () => {
  stubFetch(() => json({ error: 'invalid api key' }, 401))
  const { search } = register({ tavilyApiKey: 'bad' })
  await assert.rejects(search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /HTTP 401/)
    return true
  })

  const { search: keyless } = register({ tavilyApiKey: '', tavilyApiKeyEnv: 'DEFINITELY_MISSING' })
  await assert.rejects(keyless.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    return true
  })
})

await check('firecrawl: markdown stays text, metadata is mapped', async () => {
  stubFetch(() =>
    json({
      success: true,
      data: {
        markdown: '# Title\n\nbody',
        metadata: { statusCode: 200, sourceURL: 'https://final.test/page' },
      },
    }),
  )
  const { fetch } = register({ firecrawlApiKey: 'fc-x' })
  const result = await fetch.fetch({ url: 'https://example.com/a' })

  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/scrape')
  assert.equal(calls[0].body.url, 'https://example.com/a')
  assert.deepEqual(calls[0].body.formats, ['markdown'])
  assert.equal(calls[0].body.onlyMainContent, true)
  assert.equal(result.body.kind, 'text')
  assert.equal(result.body.content, '# Title\n\nbody')
  assert.equal(result.statusCode, 200)
  assert.equal(result.url, 'https://final.test/page')
  assert.equal(result.truncated, false)
})

await check('firecrawl: long markdown is capped and flagged', async () => {
  const long = 'x'.repeat(4000)
  stubFetch(() => json({ success: true, data: { markdown: long, metadata: { statusCode: 200 } } }))
  const { fetch } = register({ firecrawlApiKey: 'fc-x', firecrawlMaxChars: 1000 })
  const result = await fetch.fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content.length, 1000)
  assert.equal(result.truncated, true)
  assert.equal(result.url, 'https://example.com/')
})

await check('firecrawl: non-2xx target status is a result, not an error', async () => {
  stubFetch(() => json({ success: true, data: { markdown: 'not found page', metadata: { statusCode: 404 } } }))
  const { fetch } = register({ firecrawlApiKey: 'fc-x' })
  const result = await fetch.fetch({ url: 'https://example.com/missing' })
  assert.equal(result.statusCode, 404)
  assert.equal(calls.length, 1, 'no fallback for a page status')
})

await check('fallback: scrape failure degrades to the local fetch', async () => {
  stubFetch((url) => {
    if (url.includes('/scrape')) return json({ success: false, error: 'quota exceeded' }, 402)
    return textResponse('<html><body>local</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  const { fetch } = register({ firecrawlApiKey: 'fc-x' })
  const result = await fetch.fetch({ url: 'https://example.com/fallback' })
  assert.equal(calls.length, 2)
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.match(result.body.content, /local/)
})

await check('fallback: no key means no scrape call at all', async () => {
  stubFetch(() => textResponse('plain', { headers: { 'content-type': 'text/plain' } }))
  const { fetch } = register({ firecrawlApiKey: '', fallbackToHttp: true })
  const result = await fetch.fetch({ url: 'https://example.com/' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.com/')
  assert.equal(result.body.kind, 'text')
})

await check('fallback: abort never degrades', async () => {
  stubFetch(() => json({ success: false, error: 'boom' }, 500))
  const { fetch } = register({ firecrawlApiKey: 'fc-x' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(fetch.fetch({ url: 'https://example.com/' }, controller.signal), (error) => {
    assert.equal(error.code, 'WEB_ABORTED')
    return true
  })
  assert.equal(calls.length, 0)
})

await check('fallback: rejects non-http, blocked hosts, unsupported bodies', async () => {
  stubFetch(() => textResponse('x', { headers: { 'content-type': 'application/pdf' } }))
  const { fetch } = register({ firecrawlApiKey: '', fallbackToHttp: true })
  for (const url of ['', 'ftp://example.com/x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://localhost/']) {
    await assert.rejects(fetch.fetch({ url }), (error) => {
      assert.ok(['WEB_INVALID_URL', 'WEB_BLOCKED_URL'].includes(error.code), `${url} -> ${error.code}`)
      return true
    })
  }
  await assert.rejects(fetch.fetch({ url: 'https://example.com/file.pdf' }), (error) => {
    assert.equal(error.code, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    return true
  })
})

await check('fallback: redirects are followed and re-validated', async () => {
  stubFetch((url) => {
    if (url === 'https://example.com/start') {
      return textResponse(null, { status: 302, headers: { location: '/next' } })
    }
    if (url === 'https://example.com/next') {
      return textResponse('done', { headers: { 'content-type': 'text/plain' } })
    }
    return textResponse('blocked', { status: 500 })
  })
  const { fetch } = register({ firecrawlApiKey: '', fallbackToHttp: true })
  const result = await fetch.fetch({ url: 'https://example.com/start' })
  assert.equal(result.url, 'https://example.com/next')
  assert.equal(result.body.content, 'done')

  stubFetch(() => textResponse(null, { status: 301, headers: { location: 'http://127.0.0.1/admin' } }))
  await assert.rejects(fetch.fetch({ url: 'https://example.com/start' }), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    return true
  })
})

await check('fallback: redirect budget is enforced', async () => {
  stubFetch(() => textResponse(null, { status: 302, headers: { location: '/loop' } }))
  const { fetch } = register({ firecrawlApiKey: '', fallbackToHttp: true, fallbackMaxRedirects: 2 })
  await assert.rejects(fetch.fetch({ url: 'https://example.com/loop' }), (error) => {
    assert.equal(error.code, 'WEB_REDIRECT_BLOCKED')
    return true
  })
  assert.equal(calls.length, 3)
})

await check('enable flags skip registration', async () => {
  assert.equal(register({ enableSearch: false }).registry.length, 1)
  assert.equal(register({ enableFetch: false }).registry.length, 1)
  assert.equal(register({ enableSearch: false, enableFetch: false }).registry.length, 0)
})

globalThis.fetch = originalFetch

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
