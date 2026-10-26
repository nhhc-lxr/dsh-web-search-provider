import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never touch the real profile: backends and options persist under $DSH_HOME.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-web-tool-'))
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_HOME
process.env.DSH_HOME = SANDBOX

const mod = await import('../index.js')

/* --------------------------------------------------------------- harness -- */

const calls = []
const originalFetch = globalThis.fetch
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init, body })
    if (init.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return handler(String(url), body, init)
  }
}

function harness(config = {}, { credentials } = {}) {
  const registry = { search: null, fetch: null }
  const routes = []
  const ctx = {
    web: {
      registerSearchProvider: (entry) => ((registry.search = entry), () => {}),
      registerFetchProvider: (entry) => ((registry.fetch = entry), () => {}),
    },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    get: (name) => (name === 'credentials' ? credentials : undefined),
  }
  mod.apply(ctx, config)
  return { registry, routes, route: routes[0] }
}

function request({ method = 'GET', origin, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: origin === undefined ? { host: '127.0.0.1:1' } : { host: '127.0.0.1:1', origin },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      this.body = chunk
    },
  }
}

async function call(route, opts) {
  const res = response()
  await route.handler(request(opts), res)
  return { status: res.statusCode, payload: res.body ? JSON.parse(res.body) : undefined }
}

const fakeCredentials = (store = {}) => {
  const writes = []
  return {
    writes,
    resolve: async (ref) => (store[ref] ? { value: store[ref], source: 'keyring' } : undefined),
    describe: async (ref) => ({
      configured: Boolean(store[ref]),
      source: store[ref] ? 'keyring' : undefined,
      writable: true,
    }),
    set: async (ref, value) => {
      writes.push(['set', ref, value])
      store[ref] = value
    },
    unset: async (ref) => {
      writes.push(['unset', ref])
      delete store[ref]
    },
  }
}

const results = []
async function check(name, run) {
  rmSync(join(SANDBOX, 'web-tool-provider'), { recursive: true, force: true })
  try {
    await run()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const KEYS = { tavilyApiKey: 'tvly-x', exaApiKey: 'exa-x', firecrawlApiKey: 'fc-x' }
const TAVILY_SEARCH = { answer: 'A', results: [{ title: 'T', url: 'https://a.test/1', content: 'body', published_date: '2026-02-03' }] }

/* ---------------------------------------------------- contract stability -- */

await check('one provider per capability, one state route', async () => {
  const { registry, routes } = harness()
  assert.equal(registry.search.id, 'web-tool')
  assert.equal(registry.fetch.id, 'web-tool')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/web-tool-provider/state')
})

await check('every vendor is normalized to the same source shape', async () => {
  const expected = {
    url: 'https://x.test/1',
    title: 'X',
    snippet: 'body text · Ann Author',
    publishedAt: '2026-03-04',
  }
  const variants = {
    tavily: { answer: '', results: [{ title: 'X', url: 'https://x.test/1', content: 'body text', published_date: '2026-03-04', author: 'Ann Author' }] },
    exa: { results: [{ title: 'X', url: 'https://x.test/1', highlights: ['body text'], publishedDate: '2026-03-04T10:00:00.000Z', author: 'Ann Author' }] },
    firecrawl: { success: true, data: { web: [{ title: 'X', url: 'https://x.test/1', description: 'body text', author: 'Ann Author', date: '2026-03-04T08:00:00Z' }] } },
  }
  for (const vendor of Object.keys(variants)) {
    stubFetch(() => json(variants[vendor]))
    const { registry, route } = harness(KEYS)
    await call(route, { method: 'POST', body: { searchBackend: vendor } })
    const out = await registry.search.search({ query: 'q' })
    assert.deepEqual(out.sources[0], expected, `${vendor} source shape`)
    assert.equal(out.truncated, false)
  }
})

await check('dates become YYYY-MM-DD and long snippets are clipped', async () => {
  const long = 'word '.repeat(300)
  stubFetch(() => json({ results: [{ title: 'T', url: 'https://x.test/', content: long, published_date: 'Tue, 03 Feb 2026 10:00:00 GMT' }] }))
  const { registry } = harness({ ...KEYS, searchBackend: 'tavily' })
  const out = await registry.search.search({ query: 'q' })
  assert.match(out.sources[0].publishedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(out.sources[0].snippet.length <= 401)
})

/* -------------------------------------------------------- input mapping -- */

await check('depth and domain filters reach tavily as its own parameters', async () => {
  stubFetch(() => json(TAVILY_SEARCH))
  const { registry } = harness({
    ...KEYS,
    options: { depth: 'deep', includeDomains: ['a.com'], excludeDomains: ['b.com'] },
  })
  await registry.search.search({ query: 'q' })
  assert.equal(calls[0].body.search_depth, 'advanced')
  assert.deepEqual(calls[0].body.include_domains, ['a.com'])
  assert.deepEqual(calls[0].body.exclude_domains, ['b.com'])
  assert.equal('days' in calls[0].body, false)
})

await check('the same knobs reach exa as ITS own parameters', async () => {
  stubFetch(() => json({ results: [] }))
  const { registry: exaRegistry, route } = harness({
    ...KEYS,
    options: { depth: 'fast', includeDomains: ['a.com'] },
  })
  await call(route, { method: 'POST', body: { searchBackend: 'exa' } })
  await exaRegistry.search.search({ query: 'q' })
  assert.equal(calls[0].body.type, 'lite')
  assert.deepEqual(calls[0].body.includeDomains, ['a.com'])
  assert.equal('startPublishedDate' in calls[0].body, false)
})

await check('domain filters reach firecrawl as ITS own parameters', async () => {
  stubFetch(() => json({ success: true, data: { web: [] } }))
  const { registry, route } = harness({
    ...KEYS,
    options: { includeDomains: ['a.com'] },
  })
  await call(route, { method: 'POST', body: { searchBackend: 'firecrawl' } })
  await registry.search.search({ query: 'q' })
  assert.deepEqual(calls[0].body.includeDomains, ['a.com'])
  assert.equal('tbs' in calls[0].body, false)
})

/* ------------------------------------------------------ output contract -- */

await check('unsupported options become notices on the answer, not silent drops', async () => {
  stubFetch(() => json({ success: true, data: { web: [{ title: 'T', url: 'https://x.test/', description: 'd' }] } }))
  const { registry, route } = harness({ ...KEYS, options: { depth: 'deep', answer: 'on' } })
  await call(route, { method: 'POST', body: { searchBackend: 'firecrawl' } })
  const out = await registry.search.search({ query: 'q' })
  assert.match(out.content, /> provider notice: firecrawl cannot honour "depth"/)
  assert.match(out.content, /> provider notice: firecrawl cannot honour "answer"/)
  assert.equal(out.sources.length, 1)
})

await check('an empty result set is reported to the model', async () => {
  stubFetch(() => json({ results: [] }))
  const { registry } = harness(KEYS)
  const out = await registry.search.search({ query: 'q' })
  assert.match(out.content, /returned no results/)
  assert.deepEqual(out.sources, [])
})

await check('strict mode turns an unsupported option into an error', async () => {
  stubFetch(() => json({ success: true, data: { web: [] } }))
  const { registry, route } = harness({ ...KEYS, options: { depth: 'deep', strict: true } })
  await call(route, { method: 'POST', body: { searchBackend: 'firecrawl' } })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_BAD_REQUEST')
    return true
  })
})

/* ----------------------------------------------------- error taxonomy --- */

await check('HTTP failures map to one taxonomy across vendors', async () => {
  const cases = [
    [401, 'WEB_PROVIDER_UNAUTHORIZED'],
    [402, 'WEB_PROVIDER_QUOTA_EXCEEDED'],
    [429, 'WEB_PROVIDER_RATE_LIMITED'],
    [400, 'WEB_PROVIDER_BAD_REQUEST'],
    [503, 'WEB_PROVIDER_UPSTREAM'],
    [418, 'WEB_PROVIDER_ERROR'],
  ]
  for (const [status, code] of cases) {
    stubFetch(() => json({ error: 'nope' }, status))
    const { registry } = harness(KEYS)
    await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
      assert.equal(error.code, code, `HTTP ${status}`)
      return true
    })
  }
})

await check('an unreachable vendor is distinguishable from a bad key', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  const { registry } = harness(KEYS)
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_UNREACHABLE')
    return true
  })
})

await check('missing credentials stay a distinct, actionable error', async () => {
  const { registry } = harness({ tavilyApiKeyEnv: 'ABSENT_REF' }, { credentials: fakeCredentials({}) })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    assert.match(error.message, /ABSENT_REF/)
    return true
  })
})

/* --------------------------------------------------------------- fetch -- */

await check('firecrawl pages are text, with metadata mapped', async () => {
  stubFetch(() => json({ success: true, data: { markdown: '# Hi', metadata: { statusCode: 200, url: 'https://final.test/p' } } }))
  const { registry } = harness(KEYS)
  const out = await registry.fetch.fetch({ url: 'https://example.com/a' })
  assert.equal(out.body.kind, 'text')
  assert.equal(out.url, 'https://final.test/p')
  assert.equal(out.statusCode, 200)
})

await check('a failing backend degrades and says so', async () => {
  stubFetch((url) => (url.includes('firecrawl.dev') ? json({ success: false, error: 'quota' }, 402) : html('<html>local</html>')))
  const { registry } = harness(KEYS)
  const out = await registry.fetch.fetch({ url: 'https://example.com/page' })
  assert.equal(calls.length, 2)
  assert.match(out.body.content, /local/)
  assert.match(out.body.content, /> provider notice: fell back to a direct HTTP fetch: WEB_PROVIDER_QUOTA_EXCEEDED/)
})

await check('tavily extract failures name the vendor reason', async () => {
  stubFetch(() => json({ results: [], failed_results: [{ url: 'https://x.test/', error: 'blocked by robots' }] }))
  const { registry, route } = harness(KEYS)
  await call(route, { method: 'POST', body: { fetchBackend: 'tavily' } })
  const out = await registry.fetch.fetch({ url: 'https://x.test/' })
  assert.match(out.body.content, /provider notice/)
})

/* ---------------------------------------------------------------- state -- */

await check('GET exposes options and the capability matrix', async () => {
  const { route } = harness({ options: { depth: 'fast' } })
  const { payload } = await call(route, {})
  assert.equal(payload.options.depth, 'fast')
  assert.equal(payload.options.recency, undefined)
  assert.equal(payload.options.locale, undefined)
  assert.equal(payload.capabilities.firecrawl.search.depth, 'no')
  assert.equal(payload.capabilities.tavily.search.depth, 'yes')
  assert.equal(payload.capabilities.exa.search.answer, 'no')
})

await check('POST persists backends and options together', async () => {
  const { route } = harness({})
  const out = await call(route, {
    method: 'POST',
    body: {
      searchBackend: 'exa',
      options: { answer: 'on', includeDomains: ['a.com', 'b.com'], strict: true },
    },
  })
  assert.equal(out.payload.persistence.persisted, true)
  const stored = JSON.parse(readFileSync(join(SANDBOX, 'web-tool-provider', 'state.json'), 'utf8'))
  assert.equal(stored.searchBackend, 'exa')
  assert.equal(stored.options.answer, 'on')
  assert.equal(stored.options.strict, true)

  const restarted = harness({ options: { answer: 'auto' } })
  const snapshot = await call(restarted.route, {})
  assert.equal(snapshot.payload.searchBackend, 'exa')
  assert.equal(snapshot.payload.options.answer, 'on')
  assert.deepEqual(snapshot.payload.options.includeDomains, ['a.com', 'b.com'])
})

await check('keys still go through the credential service, never the state file', async () => {
  const credentials = fakeCredentials({})
  const { route } = harness({}, { credentials })
  const saved = await call(route, { method: 'POST', body: { setKey: { vendor: 'exa', value: 'exa-new' } } })
  assert.equal(saved.payload.keys.exa.configured, true)
  assert.deepEqual(credentials.writes[0], ['set', 'EXA_API_KEY', 'exa-new'])
  const raw = readFileSync(join(SANDBOX, 'web-tool-provider', 'state.json'), 'utf8')
  assert.equal(raw.includes('exa-new'), false)
})

await check('the state route refuses a foreign origin', async () => {
  const { route } = harness({})
  assert.equal((await call(route, { origin: 'https://evil.test' })).status, 403)
})

globalThis.fetch = originalFetch

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
