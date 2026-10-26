/**
 * dsh-web-tool-provider — the normalization layer between the Harness web seam
 * and three vendor APIs.
 *
 *   web_search -> ctx.web.search() -> [ shared search options ] -> tavily | exa | firecrawl
 *   web_fetch  -> ctx.web.fetch()  -> [ shared fetch options  ] -> tavily | exa | firecrawl
 *
 * Settings are layered, matching the settings page:
 *
 *   search.backend / search.options   shared by every search backend
 *   fetch.backend  / fetch.options    shared by every fetch backend
 *   providers.<vendor>                per-provider connection and behaviour
 *
 * Normalization happens here and nowhere else: one source shape, one document
 * shape, one date format, one error taxonomy, and vendor warnings folded into
 * the answer as `> provider notice: ...` so the model learns about degradation.
 *
 * Routes:
 *   GET  /web-tool-provider/state  -> layered settings, capabilities, key state
 *   POST /web-tool-provider/state  -> edit any layer, store or clear a key
 *
 * Keys persist in `ctx.credentials`; settings persist in a plugin-owned JSON
 * file (never the config editor: re-applying the profile re-registers the route
 * and a duplicate path is a hard error).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN = 'web-tool-provider'
const ROUTE = '/web-tool-provider/state'
const PROVIDER_ID = 'web-tool'
const VENDORS = ['tavily', 'exa', 'firecrawl']
const CREDENTIAL_REF = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}
const MAX_TIMER_MS = 2147483647
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const BODY_LIMIT_BYTES = 64 * 1024
const SNIPPET_CHARS = 400
const RESULT_STEP = 5
const RESULT_DEFAULT = 5
const RESULT_MAX = 100

export const name = PLUGIN
export const inject = ['web', 'webServer']

/* ------------------------------------------------------------------ errors -- */

class ProviderError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WebError'
    this.code = code
  }
}

const providerError = (message, code) => new ProviderError(message, code)

const clip = (value, limit) => {
  const string = String(value ?? '')
  return string.length > limit ? `${string.slice(0, limit)}…` : string
}

/** HTTP status and transport failures become the same codes for every vendor. */
function classifyFailure(vendor, status, bodyText) {
  const detail = clip(String(bodyText ?? '').replace(/\s+/g, ' '), 240)
  const tail = detail === '' ? '' : ` — ${detail}`
  if (status === 401 || status === 403) {
    return providerError(`${vendor} rejected the API key (HTTP ${status})${tail}`, 'WEB_PROVIDER_UNAUTHORIZED')
  }
  if (status === 402) {
    return providerError(`${vendor} is out of credits (HTTP 402)${tail}`, 'WEB_PROVIDER_QUOTA_EXCEEDED')
  }
  if (status === 429) {
    return providerError(`${vendor} rate-limited the request (HTTP 429)${tail}`, 'WEB_PROVIDER_RATE_LIMITED')
  }
  if (status === 400 || status === 422) {
    return providerError(`${vendor} rejected the request (HTTP ${status})${tail}`, 'WEB_PROVIDER_BAD_REQUEST')
  }
  if (status >= 500) {
    return providerError(`${vendor} failed upstream (HTTP ${status})${tail}`, 'WEB_PROVIDER_UPSTREAM')
  }
  return providerError(`${vendor} failed with HTTP ${status}${tail}`, 'WEB_PROVIDER_ERROR')
}

const transportFailure = (vendor, cause, timedOut, timeoutMs) => {
  if (timedOut) return providerError(`${vendor} timed out after ${timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')
  const message = cause?.message ?? String(cause)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket hang up/i.test(message)) {
    return providerError(`${vendor} is unreachable: ${message}`, 'WEB_PROVIDER_UNREACHABLE')
  }
  return providerError(`${vendor} failed: ${message}`, 'WEB_PROVIDER_ERROR')
}

/* ------------------------------------------------------------------ values -- */

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const asNumber = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
const asInteger = (value, fallback, min, max) => Math.round(asNumber(value, fallback, min, max))
const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const oneOf = (value, allowed, fallback) => {
  const candidate = text(value).toLowerCase()
  return allowed.includes(candidate) ? candidate : fallback
}
const stripSlash = (value) => value.replace(/\/+$/, '')

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Results per query are always a multiple of five, 5..100. */
function quantizeResults(value, fallback = RESULT_DEFAULT) {
  const stepped = Math.round(asNumber(value, fallback, RESULT_STEP, RESULT_MAX) / RESULT_STEP) * RESULT_STEP
  return Math.min(RESULT_MAX, Math.max(RESULT_STEP, stepped))
}

function domainList(value) {  const parts = Array.isArray(value) ? value : text(value).split(/[\s,]+/)
  const seen = new Set()
  for (const part of parts) {
    const host = text(part).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (host !== '') seen.add(host)
  }
  return [...seen]
}

/* ---------------------------------------------------------------- settings -- */

/** Static Config supplies first-run defaults; the state file overrides them. */
function defaultsFromConfig(config) {
  return {
    search: {
      backend: oneOf(config.searchBackend, VENDORS, 'tavily'),
      options: {
        maxResults: quantizeResults(config.searchMaxResults),
        includeDomains: domainList(config.includeDomains),
        excludeDomains: domainList(config.excludeDomains),
      },
    },
    fetch: {
      backend: oneOf(config.fetchBackend, VENDORS, 'firecrawl'),
      options: { fallbackToHttp: asBoolean(config.fallbackToHttp, true) },
    },
    providers: {
      tavily: {
        baseURL: stripSlash(text(config.tavilyBaseURL) || 'https://api.tavily.com'),
        timeoutMs: asInteger(config.tavilyTimeoutMs, 20000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.tavilyMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.tavilyApiKey),
        apiKeyEnv: text(config.tavilyApiKeyEnv) || CREDENTIAL_REF.tavily,
        topic: oneOf(config.tavilyTopic, ['general', 'news', 'finance'], 'general'),
        searchDepth: oneOf(config.tavilySearchDepth, ['basic', 'advanced'], 'basic'),
        answer: asBoolean(config.tavilyIncludeAnswer, true),
      },
      exa: {
        baseURL: stripSlash(text(config.exaBaseURL) || 'https://api.exa.ai'),
        timeoutMs: asInteger(config.exaTimeoutMs, 20000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.exaMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.exaApiKey),
        apiKeyEnv: text(config.exaApiKeyEnv) || CREDENTIAL_REF.exa,
        searchType: oneOf(config.exaSearchType, ['auto', 'lite', 'deep'], 'auto'),
      },
      firecrawl: {
        baseURL: stripSlash(text(config.firecrawlBaseURL) || 'https://api.firecrawl.dev'),
        timeoutMs: asInteger(config.firecrawlTimeoutMs, 30000, 1000, MAX_TIMER_MS),
        maxChars: asInteger(config.firecrawlMaxChars, 100000, 1000, 5000000),
        apiKey: text(config.firecrawlApiKey),
        apiKeyEnv: text(config.firecrawlApiKeyEnv) || CREDENTIAL_REF.firecrawl,
        version: oneOf(config.firecrawlApiVersion, ['v1', 'v2'], 'v2'),
        mainContent: asBoolean(config.firecrawlMainContent, true),
        maxAge: asInteger(config.firecrawlMaxAge, 172800000, 0, 604800000),
      },
    },
    fallback: {
      timeoutMs: asInteger(config.fallbackTimeoutMs, 20000, 1000, MAX_TIMER_MS),
      maxChars: asInteger(config.fallbackMaxChars, 100000, 1000, 5000000),
      maxBytes: asInteger(config.fallbackMaxBytes, 5000000, 1000, 50000000),
      maxRedirects: asInteger(config.fallbackMaxRedirects, 5, 0, 20),
      userAgent: text(config.fallbackUserAgent) || `${PLUGIN}/0.4.0`,
    },
  }
}

/** Merge a partial (persisted or posted) document over the current settings. */
function mergeSettings(base, patch) {
  const next = {
    search: { ...base.search, options: { ...base.search.options } },
    fetch: { ...base.fetch, options: { ...base.fetch.options } },
    providers: Object.fromEntries(VENDORS.map((vendor) => [vendor, { ...base.providers[vendor] }])),
    fallback: { ...base.fallback },
  }
  if (!patch || typeof patch !== 'object') return next

  if (typeof patch.search?.backend === 'string') {
    next.search.backend = oneOf(patch.search.backend, VENDORS, next.search.backend)
  }
  if (patch.search?.options && typeof patch.search.options === 'object') {
    const incoming = patch.search.options
    const target = next.search.options
    if (incoming.maxResults !== undefined) target.maxResults = quantizeResults(incoming.maxResults, target.maxResults)
    if (incoming.includeDomains !== undefined) target.includeDomains = domainList(incoming.includeDomains)
    if (incoming.excludeDomains !== undefined) target.excludeDomains = domainList(incoming.excludeDomains)
  }
  if (typeof patch.fetch?.backend === 'string') {
    next.fetch.backend = oneOf(patch.fetch.backend, VENDORS, next.fetch.backend)
  }
  if (patch.fetch?.options && typeof patch.fetch.options === 'object') {
    const incoming = patch.fetch.options
    if (incoming.fallbackToHttp !== undefined) {
      next.fetch.options.fallbackToHttp = asBoolean(incoming.fallbackToHttp, next.fetch.options.fallbackToHttp)
    }
  }
  if (patch.providers && typeof patch.providers === 'object') {
    for (const vendor of VENDORS) {
      const incoming = patch.providers[vendor]
      if (!incoming || typeof incoming !== 'object') continue
      const target = next.providers[vendor]
      if (incoming.baseURL !== undefined) {
        const candidate = stripSlash(text(incoming.baseURL))
        if (!isHttpUrl(candidate)) throw new Error(`${vendor}.baseURL must be an absolute http(s) URL`)
        target.baseURL = candidate
      }
      if (incoming.timeoutMs !== undefined) {
        target.timeoutMs = asInteger(incoming.timeoutMs, target.timeoutMs, 1000, MAX_TIMER_MS)
      }
      if (incoming.maxChars !== undefined) target.maxChars = asInteger(incoming.maxChars, target.maxChars, 1000, 5000000)
      if (vendor === 'tavily') {
        if (incoming.topic !== undefined) target.topic = oneOf(incoming.topic, ['general', 'news', 'finance'], target.topic)
        if (incoming.searchDepth !== undefined) {
          target.searchDepth = oneOf(incoming.searchDepth, ['basic', 'advanced'], target.searchDepth)
        }
        if (incoming.answer !== undefined) target.answer = asBoolean(incoming.answer, target.answer)
      }
      if (vendor === 'exa' && incoming.searchType !== undefined) {
        target.searchType = oneOf(incoming.searchType, ['auto', 'lite', 'deep'], target.searchType)
      }
      if (vendor === 'firecrawl') {
        if (incoming.version !== undefined) target.version = oneOf(incoming.version, ['v1', 'v2'], target.version)
        if (incoming.mainContent !== undefined) target.mainContent = asBoolean(incoming.mainContent, target.mainContent)
        if (incoming.maxAge !== undefined) target.maxAge = asInteger(incoming.maxAge, target.maxAge, 0, 604800000)
      }
    }
  }
  return next
}

/* -------------------------------------------------------------------- keys -- */

async function resolveKey(ctx, vendor, provider) {
  const literal = text(provider.apiKey)
  if (literal !== '') return { value: literal, source: 'config' }
  const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && text(resolved.value) !== '') {
        return { value: text(resolved.value), source: resolved.source || 'credentials' }
      }
    } catch {
      /* fall through to the environment */
    }
  }
  const fromEnv = text(process.env[ref])
  if (fromEnv !== '') return { value: fromEnv, source: 'env' }
  return { value: '', source: 'missing' }
}

async function requireKey(ctx, vendor, provider) {
  const key = await resolveKey(ctx, vendor, provider)
  if (key.value === '') {
    const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
    throw providerError(
      `${vendor} API key is not configured: open Settings -> Plugins -> Web tool provider and save it, or set $${ref}`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  return key.value
}

async function describeKeys(ctx, settings) {
  const credentials = ctx.get('credentials')
  const result = {}
  for (const vendor of VENDORS) {
    const provider = settings.providers[vendor]
    const ref = text(provider.apiKeyEnv) || CREDENTIAL_REF[vendor]
    let info = { ref, configured: false, source: 'missing', writable: credentials !== undefined }
    if (text(provider.apiKey) !== '') {
      info = { ...info, configured: true, source: 'config' }
    } else if (credentials !== undefined) {
      try {
        const described = await credentials.describe(ref)
        info = {
          ref,
          configured: Boolean(described.configured),
          source: described.source || (described.configured ? 'credentials' : 'missing'),
          writable: Boolean(described.writable),
        }
      } catch {
        /* keep the default */
      }
    }
    if (!info.configured && text(process.env[ref]) !== '') {
      info = { ...info, configured: true, source: 'env' }
    }
    result[vendor] = info
  }
  return result
}

/* ------------------------------------------------------------------- state -- */

function stateFileCandidates() {
  const candidates = []
  if (text(process.env.DSH_PROFILE_DIR) !== '') {
    candidates.push(join(process.env.DSH_PROFILE_DIR, `.${PLUGIN}`, 'state.json'))
  }
  if (text(process.env.DSH_HOME) !== '') candidates.push(join(process.env.DSH_HOME, PLUGIN, 'state.json'))
  candidates.push(join(homedir(), '.dsh', PLUGIN, 'state.json'))
  return candidates
}

function loadSettings(config) {
  const defaults = defaultsFromConfig(config)
  for (const file of stateFileCandidates()) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return { settings: mergeSettings(defaults, raw), storage: file }
    } catch {
      /* try the next candidate */
    }
  }
  return { settings: defaults, storage: undefined }
}

function persistSettings(settings) {
  let lastError
  for (const file of stateFileCandidates()) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      const payload = {
        search: settings.search,
        fetch: settings.fetch,
        providers: Object.fromEntries(
          VENDORS.map((vendor) => {
            // Never write a literal key to disk; the credential store owns it.
            const { apiKey, ...rest } = settings.providers[vendor]
            return [vendor, rest]
          }),
        ),
        updatedAt: new Date().toISOString(),
      }
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`)
      renameSync(temporary, file)
      return { persisted: true, location: file }
    } catch (error) {
      lastError = error
    }
  }
  return { persisted: false, reason: `write-failed: ${lastError?.message ?? 'no writable location'}` }
}

/* ----------------------------------------------------------------- helpers -- */

const flatten = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** Every vendor's date becomes `YYYY-MM-DD`, or nothing. */
function toDateOnly(value) {
  const candidate = text(value)
  if (candidate === '') return undefined
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(candidate)
  if (iso !== null) return iso[1]
  const parsed = Date.parse(candidate)
  if (Number.isNaN(parsed)) return undefined
  return new Date(parsed).toISOString().slice(0, 10)
}

async function withDeadline(signal, timeoutMs, label, task) {
  if (signal?.aborted) throw providerError(`${label} aborted`, 'WEB_ABORTED')
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await task(controller.signal)
  } catch (error) {
    if (error?.code) throw error
    if (signal?.aborted) throw providerError(`${label} aborted`, 'WEB_ABORTED')
    throw transportFailure(label, error, timedOut, timeoutMs)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function postJson(url, body, { headers, timeoutMs, signal, label, vendor }) {
  return withDeadline(signal, timeoutMs, label, async (inner) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: inner,
    })
    const raw = await response.text()
    if (!response.ok) throw classifyFailure(vendor, response.status, raw)
    try {
      return JSON.parse(raw)
    } catch {
      throw providerError(`${vendor} returned a non-JSON response`, 'WEB_PROVIDER_UPSTREAM')
    }
  })
}

function normalizeSource(raw) {
  const url = text(raw?.url) || text(raw?.link) || text(raw?.metadata?.sourceURL)
  if (url === '') return undefined
  const title = flatten(raw?.title) || undefined
  const highlights = Array.isArray(raw?.highlights) ? raw.highlights.map(flatten).filter(Boolean).join(' ') : ''
  const body = flatten(raw?.description || raw?.snippet || raw?.summary || raw?.text || raw?.content || highlights)
  const author = flatten(raw?.author)
  let snippet = body
  if (snippet === '' && author !== '') snippet = author
  else if (snippet !== '' && author !== '') snippet = `${snippet} · ${author}`
  const source = { url }
  if (title !== undefined) source.title = title
  if (snippet !== '') source.snippet = clip(snippet, SNIPPET_CHARS)
  const publishedAt = toDateOnly(raw?.published_date ?? raw?.publishedDate ?? raw?.date)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return source
}

function normalizeSources(items) {
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const source = normalizeSource(item)
    if (source === undefined || seen.has(source.url)) continue
    seen.add(source.url)
    sources.push(source)
  }
  return sources
}

function composeAnswer(answer, notices) {
  const blocks = []
  if (answer !== '') blocks.push(answer)
  for (const notice of notices) blocks.push(`> provider notice: ${notice}`)
  return blocks.length === 0 ? undefined : blocks.join('\n\n')
}

/** A vendor caps results per query; ask for what it can give and say so. */
function clampResults(request, cap, vendor, notices, vendorCap) {
  const requested = Number.isFinite(request?.maxResults) ? Math.round(request.maxResults) : cap
  const wanted = Math.max(1, Math.min(cap, requested))
  const effective = Math.min(wanted, vendorCap)
  if (effective < wanted) notices.push(`${vendor} caps results at ${vendorCap} per query`)
  return effective
}

/* ---------------------------------------------------------------- adapters -- */

async function tavilySearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.tavily
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'tavily', provider)
  const body = {
    query: text(request?.query),
    max_results: clampResults(request, options.maxResults, 'tavily', notices, 20),
    search_depth: provider.searchDepth,
    topic: provider.topic,
  }
  if (provider.answer) body.include_answer = true
  if (options.includeDomains.length > 0) body.include_domains = options.includeDomains
  if (options.excludeDomains.length > 0) body.exclude_domains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'tavily search',
    vendor: 'tavily',
  })
  return { answer: flatten(payload?.answer), sources: normalizeSources(payload?.results) }
}

async function exaSearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.exa
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'exa', provider)
  const body = {
    query: text(request?.query),
    type: provider.searchType,
    numResults: clampResults(request, options.maxResults, 'exa', notices, 100),
    contents: { highlights: true },
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'exa search',
    vendor: 'exa',
  })
  return { answer: flatten(payload?.output), sources: normalizeSources(payload?.results) }
}

async function firecrawlSearch(ctx, settings, request, signal, notices) {
  const provider = settings.providers.firecrawl
  const options = settings.search.options
  const apiKey = await requireKey(ctx, 'firecrawl', provider)
  const body = {
    query: text(request?.query),
    limit: clampResults(request, options.maxResults, 'firecrawl', notices, 100),
    sources: ['web'],
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains

  const payload = await postJson(`${provider.baseURL}/${provider.version}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: provider.timeoutMs,
    signal,
    label: 'firecrawl search',
    vendor: 'firecrawl',
  })
  if (payload?.success === false) {
    throw providerError(`firecrawl search failed: ${clip(payload?.error ?? 'unknown error', 240)}`, 'WEB_PROVIDER_UPSTREAM')
  }
  const data = payload?.data
  const items = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : []
  return { answer: '', sources: normalizeSources(items) }
}

function documentResult(content, maxChars, url, statusCode = 200) {
  const body = String(content ?? '').trim()
  if (body === '') throw providerError('the provider returned no page content', 'WEB_PROVIDER_EMPTY')
  const truncated = body.length > maxChars
  return {
    url,
    statusCode,
    body: { kind: 'text', content: truncated ? body.slice(0, maxChars) : body },
    truncated,
  }
}

async function firecrawlFetch(ctx, settings, request, signal) {
  const provider = settings.providers.firecrawl
  const apiKey = await requireKey(ctx, 'firecrawl', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/${provider.version}/scrape`,
    {
      url,
      formats: ['markdown'],
      onlyMainContent: provider.mainContent,
      maxAge: provider.maxAge,
      timeout: provider.timeoutMs,
    },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: provider.timeoutMs + 15000,
      signal,
      label: 'firecrawl scrape',
      vendor: 'firecrawl',
    },
  )
  if (payload?.success === false) {
    throw providerError(
      `firecrawl scrape failed: ${clip(payload?.error ?? payload?.message ?? 'unknown error', 240)}`,
      'WEB_PROVIDER_UPSTREAM',
    )
  }
  const doc = payload?.data ?? payload
  const metadata = doc?.metadata ?? {}
  const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200
  const finalUrl = text(metadata.url) || text(metadata.sourceURL) || url
  return documentResult(doc?.markdown ?? doc?.content, provider.maxChars, finalUrl, statusCode)
}

async function exaFetch(ctx, settings, request, signal) {
  const provider = settings.providers.exa
  const apiKey = await requireKey(ctx, 'exa', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/contents`,
    { urls: [url], text: true },
    {
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      timeoutMs: provider.timeoutMs,
      signal,
      label: 'exa contents',
      vendor: 'exa',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) throw providerError('exa returned no page content', 'WEB_PROVIDER_EMPTY')
  const content = text(first.text) || (Array.isArray(first.highlights) ? first.highlights.join('\n\n') : '')
  return documentResult(content, provider.maxChars, text(first.url) || url)
}

async function tavilyFetch(ctx, settings, request, signal) {
  const provider = settings.providers.tavily
  const apiKey = await requireKey(ctx, 'tavily', provider)
  const url = text(request?.url)
  const payload = await postJson(
    `${provider.baseURL}/extract`,
    { urls: [url] },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: provider.timeoutMs,
      signal,
      label: 'tavily extract',
      vendor: 'tavily',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) {
    const failed = Array.isArray(payload?.failed_results) ? payload.failed_results[0] : undefined
    throw providerError(
      `tavily could not extract ${url}${failed?.error ? `: ${clip(failed.error, 200)}` : ''}`,
      'WEB_PROVIDER_EMPTY',
    )
  }
  return documentResult(text(first.raw_content), provider.maxChars, text(first.url) || url)
}

/* -------------------------------------------------- credential-free fetch -- */

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
    if (host.startsWith('::ffff:')) return true
    return false
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 === null) return false
  const a = Number(ipv4[1])
  const b = Number(ipv4[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function parseTarget(raw) {
  const value = text(raw)
  if (value === '') throw providerError('url must be a non-empty string', 'WEB_INVALID_URL')
  let url
  try {
    url = new URL(value)
  } catch {
    throw providerError(`invalid URL ${JSON.stringify(value)}`, 'WEB_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw providerError(`unsupported protocol ${JSON.stringify(url.protocol)}`, 'WEB_INVALID_URL')
  }
  if (isBlockedHost(url.hostname)) {
    throw providerError(`host ${JSON.stringify(url.hostname)} is not a public destination`, 'WEB_BLOCKED_URL')
  }
  return url
}

function classifyContentType(value) {
  const type = text(value).split(';')[0].trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type.startsWith('text/')) return 'text'
  if (type === 'application/json' || type.endsWith('+json')) return 'text'
  if (type === 'application/xml' || type.endsWith('+xml')) return 'text'
  return undefined
}

function charsetOf(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(text(contentType))
  return match === null ? 'utf-8' : match[1].toLowerCase()
}

function decodeBytes(bytes, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

async function readCapped(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        break
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    if (error?.code) throw error
    throw transportFailure('local fetch', error, false, 0)
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already closed */
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, truncated }
}

async function localFetch(settings, request, signal) {
  const fallback = settings.fallback
  return withDeadline(signal, fallback.timeoutMs, 'local fetch', async (inner) => {
    let current = parseTarget(request?.url)
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: inner,
        headers: {
          'user-agent': fallback.userAgent,
          accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,application/xml;q=0.7',
        },
      })

      if (REDIRECT_STATUS.has(response.status)) {
        if (hop >= fallback.maxRedirects) {
          await response.body?.cancel().catch(() => {})
          throw providerError(
            `redirect limit (${fallback.maxRedirects}) exceeded for ${current.toString()}`,
            'WEB_REDIRECT_BLOCKED',
          )
        }
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => {})
        if (location === null || location === '') {
          throw providerError(
            `redirect response (HTTP ${response.status}) without a Location header`,
            'WEB_PROVIDER_UPSTREAM',
          )
        }
        current = parseTarget(new URL(location, current).toString())
        continue
      }

      const contentType = response.headers.get('content-type')
      const kind = classifyContentType(contentType)
      if (kind === undefined) {
        await response.body?.cancel().catch(() => {})
        throw providerError(
          `unsupported content type ${JSON.stringify(contentType ?? 'unknown')}`,
          'WEB_UNSUPPORTED_CONTENT_TYPE',
        )
      }
      const { bytes, truncated: truncatedByBytes } = await readCapped(response, fallback.maxBytes)
      const decoded = decodeBytes(bytes, contentType)
      const truncated = truncatedByBytes || decoded.length > fallback.maxChars
      return {
        url: current.toString(),
        statusCode: response.status,
        body: { kind, content: truncated ? decoded.slice(0, fallback.maxChars) : decoded },
        truncated,
      }
    }
  })
}

/* ------------------------------------------------------------------ plugin -- */

const SEARCH_VENDOR = { tavily: tavilySearch, exa: exaSearch, firecrawl: firecrawlSearch }
const FETCH_VENDOR = { tavily: tavilyFetch, exa: exaFetch, firecrawl: firecrawlFetch }

function withNotices(result, notices) {
  if (notices.length === 0) return result
  const trailer = notices.map((notice) => `> provider notice: ${notice}`).join('\n')
  return { ...result, body: { ...result.body, content: `${result.body.content}\n\n${trailer}` } }
}

function createSearchProvider(ctx, state) {
  return {
    id: PROVIDER_ID,
    available() {
      return true
    },
    async search(request, signal) {
      const settings = state.settings
      const vendor = SEARCH_VENDOR[settings.search.backend] ?? SEARCH_VENDOR.tavily
      const notices = []
      const result = await vendor(ctx, settings, request, signal, notices)
      if (result.sources.length === 0) notices.push(`${settings.search.backend} returned no results for this query`)
      return {
        content: composeAnswer(result.answer, notices),
        sources: result.sources,
        truncated: false,
      }
    },
  }
}

function createFetchProvider(ctx, state) {
  return {
    id: PROVIDER_ID,
    available() {
      return true
    },
    async fetch(request, signal) {
      const settings = state.settings
      const vendor = FETCH_VENDOR[settings.fetch.backend] ?? FETCH_VENDOR.firecrawl
      const notices = []
      try {
        return withNotices(await vendor(ctx, settings, request, signal, notices), notices)
      } catch (error) {
        if (!settings.fetch.options.fallbackToHttp) throw error
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) throw error
        const result = await localFetch(settings, request, signal)
        return withNotices(result, [...notices, `fell back to a direct HTTP fetch: ${error?.code ?? 'error'}`])
      }
    },
  }
}

/* ------------------------------------------------------------------ routes -- */

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw providerError('request body too large', 'WEB_PROVIDER_BAD_REQUEST')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw providerError('request body must be JSON', 'WEB_PROVIDER_BAD_REQUEST')
  }
}

function createStateRoutes(ctx, state) {
  const refreshKeys = async () => {
    state.keys = await describeKeys(ctx, state.settings)
  }

  const snapshot = () => ({
    search: state.settings.search,
    fetch: state.settings.fetch,
    providers: Object.fromEntries(
      VENDORS.map((vendor) => {
        const { apiKey, ...rest } = state.settings.providers[vendor]
        return [vendor, { ...rest, key: state.keys[vendor] }]
      }),
    ),
    stateFile: state.storage ?? stateFileCandidates()[0],
  })

  const handler = async (req, res) => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await refreshKeys()
      sendJson(res, 200, snapshot())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const credentialRef = (vendor) => text(state.settings.providers[vendor].apiKeyEnv) || CREDENTIAL_REF[vendor]
      if (body.setKey && typeof body.setKey === 'object') {
        const vendor = oneOf(body.setKey.vendor, VENDORS, '')
        const value = text(body.setKey.value)
        const credentials = ctx.get('credentials')
        if (vendor === '' || value === '') {
          throw providerError('setKey needs a vendor and a non-empty value', 'WEB_PROVIDER_BAD_REQUEST')
        }
        if (credentials === undefined) {
          throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
        }
        await credentials.set(credentialRef(vendor), value)
      }
      if (body.clearKey && typeof body.clearKey === 'object') {
        const vendor = oneOf(body.clearKey.vendor, VENDORS, '')
        const credentials = ctx.get('credentials')
        if (vendor === '') throw providerError('clearKey needs a vendor', 'WEB_PROVIDER_BAD_REQUEST')
        if (credentials === undefined) {
          throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
        }
        await credentials.unset(credentialRef(vendor))
      }
      state.settings = mergeSettings(state.settings, body)
      const persistence = persistSettings(state.settings)
      if (persistence.location !== undefined) state.storage = persistence.location
      await refreshKeys()
      sendJson(res, 200, { ...snapshot(), persistence })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error), code: error?.code })
    }
  }

  return ctx.webServer.register({ kind: 'exact', path: ROUTE, handler })
}

export function apply(ctx, config) {
  const { settings, storage } = loadSettings(config)
  const state = { settings, storage, keys: {} }
  ctx.web.registerSearchProvider(createSearchProvider(ctx, state))
  ctx.web.registerFetchProvider(createFetchProvider(ctx, state))
  try {
    createStateRoutes(ctx, state)
  } catch (error) {
    // A route already registered for this path means the previous fiber has not
    // disposed yet. Losing the settings page is survivable; losing the web
    // backends because this row refused to activate is not.
    ctx.logger?.warn?.(`${PLUGIN}: settings route unavailable: ${error?.message ?? String(error)}`)
  }
}
