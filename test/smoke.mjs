import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Never touch the real profile: backend choices persist under $DSH_HOME.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-web-tool-'))
delete process.env.DSH_PROFILE_DIR
process.env.DSH_HOME = SANDBOX

const mod = await import('../index.js')

const calls = []
const originalFetch = globalThis.fetch
const json = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
const html = (body, headers = { 'content-type': 'text/html; charset=utf-8' }) => new Response(body, { status: 200, headers })

function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const parsed = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), init, body: parsed })
    if (init.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return handler(String(url), parsed, init)
  }
}

const provider = () => ({
  search: null,
  fetch: null,
})

function harness(config = {}, { credentials } = {}) {
  const registry = provider()
  const routes = []
  const ctx = {
    web: {
      registerSearchProvider: (entry) => {
        registry.search = entry
        return () => {}
      },
      registerFetchProvider: (entry) => {
        registry.fetch = entry
        return () => {}
      },
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
    describe: async (ref) => ({ configured: Boolean(store[ref]), source: store[ref] ? 'keyring' : undefined, writable: true }),
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
  // Every case starts from the Config defaults, not the previous case's file.
  rmSync(join(SANDBOX, 'web-tool-provider'), { recursive: true, force: true })
  try {
    await run()
    results.push(`ok   ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

await check('registers one provider per capability plus one state route', async () => {
  const { registry, routes } = harness()
  assert.equal(registry.search.id, 'web-tool')
  assert.equal(registry.fetch.id, 'web-tool')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/web-tool-provider/state')
  assert.equal(routes[0].kind, 'exact')
})

await check('tavily is the default search backend', async () => {
  stubFetch(() => json({ answer: 'A', results: [{ title: 'T', url: 'https://a.test/1', content: 's', published_date: '2026-02-03' }] }))
  const { registry } = harness({ tavilyApiKey: 'tvly-x' })
  const out = await registry.search.search({ query: 'q', maxResults: 5 })
  assert.equal(calls[0].url, 'https://api.tavily.com/search')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-x')
  assert.equal(calls[0].body.max_results, 5)
  assert.equal(out.content, 'A')
  assert.deepEqual(out.sources, [{ url: 'https://a.test/1', title: 'T', snippet: 's', publishedAt: '2026-02-03' }])
})

await check('POST switches the search backend to exa for the next call', async () => {
  stubFetch(() => json({ results: [{ title: 'E', url: 'https://e.test/1', highlights: ['h1', 'h2'], publishedDate: '2026-01-01' }] }))
  const { registry, route } = harness({ exaApiKey: 'exa-x' })
  const saved = await call(route, { method: 'POST', body: { searchBackend: 'exa' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.searchBackend, 'exa')
  const out = await registry.search.search({ query: 'q' })
  assert.equal(calls[0].url, 'https://api.exa.ai/search')
  assert.equal(calls[0].init.headers['x-api-key'], 'exa-x')
  assert.deepEqual(out.sources[0], {
    url: 'https://e.test/1',
    title: 'E',
    snippet: 'h1 h2',
    publishedAt: '2026-01-01',
  })
})

await check('firecrawl search maps data.web', async () => {
  stubFetch(() => json({ success: true, data: { web: [{ title: 'F', url: 'https://f.test/1', description: 'd' }] } }))
  const { registry, route } = harness({ firecrawlApiKey: 'fc-x' })
  await call(route, { method: 'POST', body: { searchBackend: 'firecrawl' } })
  const out = await registry.search.search({ query: 'q' })
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search')
  assert.deepEqual(out.sources, [{ url: 'https://f.test/1', title: 'F', snippet: 'd' }])
})

await check('firecrawl fetch returns markdown as a text body', async () => {
  stubFetch(() => json({ success: true, data: { markdown: '# Hi', metadata: { statusCode: 200, sourceURL: 'https://final.test/' } } }))
  const { registry } = harness({ firecrawlApiKey: 'fc-x' })
  const out = await registry.fetch.fetch({ url: 'https://example.com/' })
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/scrape')
  assert.equal(out.body.kind, 'text')
  assert.equal(out.body.content, '# Hi')
  assert.equal(out.url, 'https://final.test/')
})

await check('fetch backends: exa contents and tavily extract both work', async () => {
  stubFetch((url) => (url.includes('exa.ai') ? json({ results: [{ url: 'https://x.test/', text: 'exa text' }] }) : json({ results: [{ url: 'https://x.test/', raw_content: 'tavily text' }] })))
  let { registry, route } = harness({ exaApiKey: 'exa-x' })
  await call(route, { method: 'POST', body: { fetchBackend: 'exa' } })
  assert.equal((await registry.fetch.fetch({ url: 'https://x.test/' })).body.content, 'exa text')
  ;({ registry, route } = harness({ tavilyApiKey: 'tvly-x' }))
  await call(route, { method: 'POST', body: { fetchBackend: 'tavily' } })
  const out = await registry.fetch.fetch({ url: 'https://x.test/' })
  assert.equal(out.body.content, 'tavily text')
  assert.equal(calls.at(-1).url, 'https://api.tavily.com/extract')
})

await check('a failing backend degrades to the local fetch', async () => {
  stubFetch((url) =>
    url.includes('firecrawl.dev') ? json({ success: false, error: 'quota' }, 402) : html('<html>local</html>'),
  )
  const { registry } = harness({ firecrawlApiKey: 'fc-x' })
  const out = await registry.fetch.fetch({ url: 'https://example.com/page' })
  assert.equal(calls.length, 2)
  assert.equal(out.body.kind, 'html')
  assert.match(out.body.content, /local/)
})

await check('keys come from the credential store, then the environment', async () => {
  stubFetch(() => json({ results: [] }))
  const credentials = fakeCredentials({ TAVILY_API_KEY: 'tvly-stored' })
  const stored = harness({}, { credentials })
  await stored.registry.search.search({ query: 'q' })
  assert.equal(calls[0].init.headers.authorization, 'Bearer tvly-stored')

  process.env.MISSING_REF = 'exa-env'
  const fromEnv = harness({ exaApiKeyEnv: 'MISSING_REF' }, { credentials: fakeCredentials({}) })
  await call(fromEnv.route, { method: 'POST', body: { searchBackend: 'exa' } })
  await fromEnv.registry.search.search({ query: 'q' })
  assert.equal(calls.at(-1).init.headers['x-api-key'], 'exa-env')
  delete process.env.MISSING_REF
})

await check('missing credentials produce a structured error', async () => {
  stubFetch(() => json({ results: [] }))
  const { registry } = harness({ tavilyApiKey: '', tavilyApiKeyEnv: 'ABSENT_REF' }, { credentials: fakeCredentials({}) })
  await assert.rejects(registry.search.search({ query: 'q' }), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    assert.match(error.message, /ABSENT_REF/)
    return true
  })
})

await check('POST stores and clears keys through the credential service', async () => {
  const credentials = fakeCredentials({})
  const { route } = harness({}, { credentials })
  const saved = await call(route, { method: 'POST', body: { setKey: { vendor: 'exa', value: 'exa-new' } } })
  assert.equal(saved.status, 200)
  assert.deepEqual(credentials.writes[0], ['set', 'EXA_API_KEY', 'exa-new'])
  assert.equal(saved.payload.keys.exa.configured, true)

  const cleared = await call(route, { method: 'POST', body: { clearKey: { vendor: 'exa' } } })
  assert.equal(cleared.status, 200)
  assert.deepEqual(credentials.writes[1], ['unset', 'EXA_API_KEY'])
  assert.equal(cleared.payload.keys.exa.configured, false)
})

await check('POST persists the backend choice to the plugin state file', async () => {
  const { route } = harness({})
  const out = await call(route, { method: 'POST', body: { searchBackend: 'exa', fetchBackend: 'tavily' } })
  assert.equal(out.payload.persistence.persisted, true)

  const file = join(SANDBOX, 'web-tool-provider', 'state.json')
  assert.equal(out.payload.persistence.location, file)
  assert.equal(out.payload.stateFile, file)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.searchBackend, 'exa')
  assert.equal(stored.fetchBackend, 'tavily')

  // A fresh mount (a restart) picks the stored choice up.
  const restarted = harness({ searchBackend: 'tavily', fetchBackend: 'firecrawl' })
  const snapshot = await call(restarted.route, {})
  assert.equal(snapshot.payload.searchBackend, 'exa')
  assert.equal(snapshot.payload.fetchBackend, 'tavily')
  assert.equal(snapshot.payload.stateFile, file)
})

await check('a corrupt state file falls back to the Config defaults', async () => {
  const file = join(SANDBOX, 'web-tool-provider', 'state.json')
  mkdirSync(join(SANDBOX, 'web-tool-provider'), { recursive: true })
  writeFileSync(file, '{ this is not json')
  const { route } = harness({ searchBackend: 'firecrawl', fetchBackend: 'exa' })
  const snapshot = await call(route, {})
  assert.equal(snapshot.payload.searchBackend, 'firecrawl')
  assert.equal(snapshot.payload.fetchBackend, 'exa')
})

await check('GET returns the snapshot and the route refuses foreign origins', async () => {
  const { route } = harness({ exaApiKey: 'exa-x' })
  const snapshot = await call(route, {})
  assert.equal(snapshot.status, 200)
  assert.deepEqual(snapshot.payload.backends, ['tavily', 'exa', 'firecrawl'])
  assert.equal(snapshot.payload.searchBackend, 'tavily')
  assert.equal(snapshot.payload.keys.exa.configured, true)
  assert.equal(snapshot.payload.keys.tavily.configured, false)

  const blocked = await call(route, { origin: 'https://evil.test' })
  assert.equal(blocked.status, 403)
})

await check('unknown backends are ignored instead of breaking the provider', async () => {
  const { route } = harness()
  const out = await call(route, { method: 'POST', body: { searchBackend: 'nope', fetchBackend: 'also-nope' } })
  assert.equal(out.payload.searchBackend, 'tavily')
  assert.equal(out.payload.fetchBackend, 'firecrawl')
})

globalThis.fetch = originalFetch

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('FAIL')).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
