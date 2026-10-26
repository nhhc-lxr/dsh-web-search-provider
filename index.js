/**
 * dsh-web-tool-provider — the normalization layer between the Harness web seam
 * and three vendor APIs.
 *
 *   web_search -> ctx.web.search() -> [ unified request ]  -> tavily | exa | firecrawl
 *   web_fetch  -> ctx.web.fetch()  -> [ unified request ]  -> tavily | exa | firecrawl
 *
 * Two contracts are normalized here and nowhere else:
 *
 *   INPUT   semantic knobs (domains / depth / answer) instead of vendor
 *           parameters. Each adapter translates what the vendor can honour and
 *           reports what it dropped as a notice, never silently.
 *   OUTPUT  one source shape and one document shape for every vendor, one date
 *           format, one error taxonomy, and vendor warnings folded into the
 *           answer text so the model learns about degradation.
 *
 * The model-facing tools stay owned by `dsh-tool-web`; their schema cannot grow
 * a provider argument, which is exactly why the knobs live in config and the
 * settings page instead of in the tool call.
 *
 * Settings page talks to two Host routes:
 *   GET  /web-tool-provider/state  -> backends, options, capabilities, key state
 *   POST /web-tool-provider/state  -> switch backends, edit options, store keys
 *
 * Backend choice and options persist in a plugin-owned JSON file; keys persist
 * in `ctx.credentials` and never reach this file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN = 'web-tool-provider'
const ROUTE = '/web-tool-provider/state'
const PROVIDER_ID = 'web-tool'
const BACKENDS = ['tavily', 'exa', 'firecrawl']
const DEFAULT_SEARCH = 'tavily'
const DEFAULT_FETCH = 'firecrawl'
const CREDENTIAL_REF = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
}
const TAVILY_DEFAULT_BASE = 'https://api.tavily.com'
const EXA_DEFAULT_BASE = 'https://api.exa.ai'
const FIRECRAWL_DEFAULT_BASE = 'https://api.firecrawl.dev'
const MAX_TIMER_MS = 2147483647
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const BODY_LIMIT_BYTES = 64 * 1024
const SNIPPET_CHARS = 400
const DEPTH_VALUES = ['auto', 'fast', 'balanced', 'deep']

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

/**
 * One taxonomy for every vendor: HTTP status and transport failures become the
 * same codes whichever backend produced them, so callers never branch on vendor.
 */
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

/* ------------------------------------------------------------------ config -- */

const text = (value) => (typeof value === 'string' ? value.trim() : '')

const numberOr = (value, fallback, min, max) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const integerOr = (value, fallback, min, max) => Math.round(numberOr(value, fallback, min, max))

const booleanOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const stripTrailingSlash = (value) => value.replace(/\/+$/, '')

const oneOf = (value, allowed, fallback) => {
  const candidate = text(value).toLowerCase()
  return allowed.includes(candidate) ? candidate : fallback
}

const backendOr = (value, fallback) => oneOf(value, BACKENDS, fallback)

/** `"a.com, b.com"` or `["a.com"]` -> `["a.com","b.com"]`. */
function domainList(value) {
  const parts = Array.isArray(value) ? value : text(value).split(/[\s,]+/)
  const seen = new Set()
  for (const part of parts) {
    const host = text(part).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (host !== '') seen.add(host)
  }
  return [...seen]
}

function normalizeOptions(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    depth: oneOf(source.depth, DEPTH_VALUES, 'auto'),
    answer: oneOf(source.answer === true ? 'on' : source.answer === false ? 'off' : source.answer, ['auto', 'on', 'off'], 'auto'),
    includeDomains: domainList(source.includeDomains),
    excludeDomains: domainList(source.excludeDomains),
    strict: booleanOr(source.strict, false),
  }
}

function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = {
    searchBackend: backendOr(input.searchBackend, DEFAULT_SEARCH),
    fetchBackend: backendOr(input.fetchBackend, DEFAULT_FETCH),
    providerId: text(input.providerId) || PROVIDER_ID,
    options: normalizeOptions(input.options),

    tavilyApiKey: text(input.tavilyApiKey),
    tavilyApiKeyEnv: text(input.tavilyApiKeyEnv) || CREDENTIAL_REF.tavily,
    tavilyBaseURL: stripTrailingSlash(text(input.tavilyBaseURL) || TAVILY_DEFAULT_BASE),
    tavilySearchDepth: text(input.tavilySearchDepth) || 'basic',
    tavilyTopic: text(input.tavilyTopic) || 'general',
    tavilyMaxResults: integerOr(input.tavilyMaxResults, 8, 1, 20),
    tavilyTimeoutMs: integerOr(input.tavilyTimeoutMs, 20000, 1000, MAX_TIMER_MS),
    tavilyMaxChars: integerOr(input.tavilyMaxChars, 100000, 1000, 5000000),

    exaApiKey: text(input.exaApiKey),
    exaApiKeyEnv: text(input.exaApiKeyEnv) || CREDENTIAL_REF.exa,
    exaBaseURL: stripTrailingSlash(text(input.exaBaseURL) || EXA_DEFAULT_BASE),
    exaSearchType: text(input.exaSearchType) || 'auto',
    exaNumResults: integerOr(input.exaNumResults, 8, 1, 100),
    exaTimeoutMs: integerOr(input.exaTimeoutMs, 20000, 1000, MAX_TIMER_MS),
    exaMaxChars: integerOr(input.exaMaxChars, 100000, 1000, 5000000),

    firecrawlApiKey: text(input.firecrawlApiKey),
    firecrawlApiKeyEnv: text(input.firecrawlApiKeyEnv) || CREDENTIAL_REF.firecrawl,
    firecrawlBaseURL: stripTrailingSlash(text(input.firecrawlBaseURL) || FIRECRAWL_DEFAULT_BASE),
    firecrawlApiVersion: text(input.firecrawlApiVersion) || 'v2',
    firecrawlMainContent: booleanOr(input.firecrawlMainContent, true),
    firecrawlMaxAge: integerOr(input.firecrawlMaxAge, 172800000, 0, 604800000),
    firecrawlTimeoutMs: integerOr(input.firecrawlTimeoutMs, 30000, 1000, MAX_TIMER_MS),
    firecrawlMaxChars: integerOr(input.firecrawlMaxChars, 100000, 1000, 5000000),

    fallbackToHttp: booleanOr(input.fallbackToHttp, true),
    fallbackTimeoutMs: integerOr(input.fallbackTimeoutMs, 20000, 1000, MAX_TIMER_MS),
    fallbackMaxChars: integerOr(input.fallbackMaxChars, 100000, 1000, 5000000),
    fallbackMaxBytes: integerOr(input.fallbackMaxBytes, 5000000, 1000, 50000000),
    fallbackMaxRedirects: integerOr(input.fallbackMaxRedirects, 5, 0, 20),
    fallbackUserAgent: text(input.fallbackUserAgent) || `${PLUGIN}/0.3.0`,
  }
  for (const field of ['tavilyBaseURL', 'exaBaseURL', 'firecrawlBaseURL']) {
    try {
      const url = new URL(config[field])
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new Error(`${PLUGIN}: config.${field} must be an absolute http(s) URL`)
    }
  }
  return config
}

/* ------------------------------------------------------------- capabilities -- */

/**
 * What each vendor can honour. `partial` means "only under a condition the
 * adapter has to check"; everything unsupported becomes a notice, never a throw
 * unless `options.strict` is set.
 */
const CAPABILITIES = {
  tavily: {
    search: { domains: 'yes', depth: 'yes', answer: 'yes' },
    fetch: { mainContent: 'no', cache: 'no' },
  },
  exa: {
    search: { domains: 'yes', depth: 'yes', answer: 'no' },
    fetch: { mainContent: 'no', cache: 'no' },
  },
  firecrawl: {
    search: { domains: 'yes', depth: 'no', answer: 'no' },
    fetch: { mainContent: 'yes', cache: 'yes' },
  },
}

const capabilityMatrix = () =>
  Object.fromEntries(
    BACKENDS.map((vendor) => [
      vendor,
      {
        search: { ...CAPABILITIES[vendor].search },
        fetch: { ...CAPABILITIES[vendor].fetch },
      },
    ]),
  )

/** Report an option the vendor cannot honour; strict mode turns it into a throw. */
function dropOption(options, notices, vendor, key, reason) {
  const message = `${vendor} cannot honour "${key}": ${reason}`
  if (options.strict) throw providerError(message, 'WEB_PROVIDER_BAD_REQUEST')
  notices.push(message)
}

/* ---------------------------------------------------------- host services -- */

function credentialRefFor(config, vendor) {
  return text(config[`${vendor}ApiKeyEnv`]) || CREDENTIAL_REF[vendor]
}

async function resolveKey(ctx, config, vendor) {
  const literal = text(config[`${vendor}ApiKey`])
  if (literal !== '') return { value: literal, source: 'config' }
  const ref = credentialRefFor(config, vendor)
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

async function requireKey(ctx, config, vendor) {
  const key = await resolveKey(ctx, config, vendor)
  if (key.value === '') {
    const ref = credentialRefFor(config, vendor)
    throw providerError(
      `${vendor} API key is not configured: open Settings -> Plugins -> Web tool provider and save it, or set $${ref}`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  return key.value
}

async function describeKeys(ctx, config) {
  const credentials = ctx.get('credentials')
  const result = {}
  for (const vendor of BACKENDS) {
    const ref = credentialRefFor(config, vendor)
    let info = { ref, configured: false, source: 'missing', writable: credentials !== undefined }
    if (text(config[`${vendor}ApiKey`]) !== '') {
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

function stateFileCandidates() {
  const candidates = []
  if (text(process.env.DSH_PROFILE_DIR) !== '') {
    candidates.push(join(process.env.DSH_PROFILE_DIR, `.${PLUGIN}`, 'state.json'))
  }
  if (text(process.env.DSH_HOME) !== '') candidates.push(join(process.env.DSH_HOME, PLUGIN, 'state.json'))
  candidates.push(join(homedir(), '.dsh', PLUGIN, 'state.json'))
  return candidates
}

function loadState(config) {
  for (const file of stateFileCandidates()) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return {
        searchBackend: backendOr(raw?.searchBackend, config.searchBackend),
        fetchBackend: backendOr(raw?.fetchBackend, config.fetchBackend),
        options: raw?.options ? normalizeOptions({ ...config.options, ...raw.options }) : { ...config.options },
        storage: file,
      }
    } catch {
      /* try the next candidate */
    }
  }
  return {
    searchBackend: config.searchBackend,
    fetchBackend: config.fetchBackend,
    options: { ...config.options },
    storage: undefined,
  }
}

function persistState(state) {
  let lastError
  for (const file of stateFileCandidates()) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(
        temporary,
        `${JSON.stringify(
          {
            searchBackend: state.searchBackend,
            fetchBackend: state.fetchBackend,
            options: state.options,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      )
      renameSync(temporary, file)
      state.storage = file
      return { persisted: true, location: file }
    } catch (error) {
      lastError = error
    }
  }
  return { persisted: false, reason: `write-failed: ${lastError?.message ?? 'no writable location'}` }
}

/* ----------------------------------------------------------------- helpers -- */

const clip = (value, limit) => {
  const string = String(value ?? '')
  return string.length > limit ? `${string.slice(0, limit)}…` : string
}

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

/**
 * The single source shape. `author` and `score` are normalized into the snippet
 * (the Harness contract has no field for them) and every date is `YYYY-MM-DD`.
 */
function normalizeSource(vendor, raw) {
  const url = text(raw?.url) || text(raw?.link) || text(raw?.metadata?.sourceURL)
  if (url === '') return undefined
  const title = flatten(raw?.title) || undefined
  const highlights = Array.isArray(raw?.highlights) ? raw.highlights.map(flatten).filter(Boolean).join(' ') : ''
  const body = flatten(
    raw?.description || raw?.snippet || raw?.summary || raw?.text || raw?.content || highlights,
  )
  const author = flatten(raw?.author)
  let snippet = body
  if (snippet === '' && author !== '') snippet = author
  else if (snippet !== '' && author !== '') snippet = `${snippet} · ${author}`
  const source = { url }
  if (title !== undefined) source.title = title
  if (snippet !== '') source.snippet = clip(snippet, SNIPPET_CHARS)
  const publishedAt = toDateOnly(raw?.published_date ?? raw?.publishedDate ?? raw?.date)
  if (publishedAt !== undefined) source.publishedAt = publishedAt
  return { source, vendor }
}

function normalizeSources(vendor, items) {
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeSource(vendor, item)
    if (normalized === undefined || seen.has(normalized.source.url)) continue
    seen.add(normalized.source.url)
    sources.push(normalized.source)
  }
  return sources
}

/** Vendor warnings/notices plus our degradation notices, rendered for the model. */
function composeAnswer(answer, notices) {
  const blocks = []
  if (answer !== '') blocks.push(answer)
  for (const notice of notices) blocks.push(`> provider notice: ${notice}`)
  return blocks.length === 0 ? undefined : blocks.join('\n\n')
}

/* ---------------------------------------------------------------- adapters -- */

/** Translate the semantic knobs into Tavily's parameters. */
function tavilySearchBody(config, options, request, notices) {
  const body = {
    query: text(request?.query),
    max_results: clampResults(request, config.tavilyMaxResults, config.tavilyMaxResults),
    search_depth: options.depth === 'auto' ? config.tavilySearchDepth : options.depth === 'deep' ? 'advanced' : 'basic',
    topic: config.tavilyTopic,
  }
  if (options.answer !== 'off') body.include_answer = true
  if (options.includeDomains.length > 0) body.include_domains = options.includeDomains
  if (options.excludeDomains.length > 0) body.exclude_domains = options.excludeDomains
  return body
}

function exaSearchBody(config, options, request, notices) {
  const type =
    options.depth === 'auto'
      ? config.exaSearchType
      : options.depth === 'fast'
        ? 'lite'
        : options.depth === 'deep'
          ? 'deep'
          : 'auto'
  const body = {
    query: text(request?.query),
    type,
    numResults: clampResults(request, config.exaNumResults, 100),
    contents: { highlights: true },
  }
  if (options.answer === 'on') {
    dropOption(options, notices, 'exa', 'answer', 'it only synthesizes an answer for deep search types')
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains
  return body
}

function firecrawlSearchBody(config, options, request, notices) {
  const body = {
    query: text(request?.query),
    limit: clampResults(request, 10, 100),
    sources: ['web'],
  }
  if (options.depth !== 'auto') {
    dropOption(options, notices, 'firecrawl', 'depth', 'its search has no depth setting')
  }
  if (options.answer === 'on') {
    dropOption(options, notices, 'firecrawl', 'answer', 'its search returns no synthesized answer')
  }
  if (options.includeDomains.length > 0) body.includeDomains = options.includeDomains
  if (options.excludeDomains.length > 0) body.excludeDomains = options.excludeDomains
  return body
}

const clampResults = (request, fallback, master) => {
  const requested = Number.isFinite(request?.maxResults) ? Math.round(request.maxResults) : fallback
  return Math.max(1, Math.min(master, requested))
}

async function tavilySearch(ctx, config, options, request, signal, notices) {
  const apiKey = await requireKey(ctx, config, 'tavily')
  const payload = await postJson(`${config.tavilyBaseURL}/search`, tavilySearchBody(config, options, request, notices), {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: config.tavilyTimeoutMs,
    signal,
    label: 'tavily search',
    vendor: 'tavily',
  })
  return {
    answer: flatten(payload?.answer),
    sources: normalizeSources('tavily', payload?.results),
  }
}

async function exaSearch(ctx, config, options, request, signal, notices) {
  const apiKey = await requireKey(ctx, config, 'exa')
  const payload = await postJson(`${config.exaBaseURL}/search`, exaSearchBody(config, options, request, notices), {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    timeoutMs: config.exaTimeoutMs,
    signal,
    label: 'exa search',
    vendor: 'exa',
  })
  // Exa only returns synthesized prose for deep search types, under `output`.
  return {
    answer: flatten(payload?.output),
    sources: normalizeSources('exa', payload?.results),
  }
}

async function firecrawlSearch(ctx, config, options, request, signal, notices) {
  const apiKey = await requireKey(ctx, config, 'firecrawl')
  const payload = await postJson(
    `${config.firecrawlBaseURL}/${config.firecrawlApiVersion}/search`,
    firecrawlSearchBody(config, options, request, notices),
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.firecrawlTimeoutMs,
      signal,
      label: 'firecrawl search',
      vendor: 'firecrawl',
    },
  )
  if (payload?.success === false) {
    throw providerError(`firecrawl search failed: ${clip(payload?.error ?? 'unknown error', 240)}`, 'WEB_PROVIDER_UPSTREAM')
  }
  const data = payload?.data
  const items = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : []
  return { answer: '', sources: normalizeSources('firecrawl', items) }
}

/* ----------------------------------------------------------------- fetches -- */

function documentResult(text, maxChars, url, statusCode = 200) {
  const content = String(text ?? '').trim()
  if (content === '') throw providerError('the provider returned no page content', 'WEB_PROVIDER_EMPTY')
  const truncated = content.length > maxChars
  return {
    url,
    statusCode,
    body: {
      // Markdown is handed over as text so dsh-tool-web does not run its
      // HTML->markdown pipeline a second time.
      kind: 'text',
      content: truncated ? content.slice(0, maxChars) : content,
    },
    truncated,
  }
}

async function firecrawlFetch(ctx, config, options, request, signal) {
  const apiKey = await requireKey(ctx, config, 'firecrawl')
  const url = text(request?.url)
  const payload = await postJson(
    `${config.firecrawlBaseURL}/${config.firecrawlApiVersion}/scrape`,
    {
      url,
      formats: ['markdown'],
      onlyMainContent: Boolean(options.mainContent),
      maxAge: config.firecrawlMaxAge,
      timeout: config.firecrawlTimeoutMs,
    },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.firecrawlTimeoutMs + 15000,
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
  return documentResult(doc?.markdown ?? doc?.content, config.firecrawlMaxChars, finalUrl, statusCode)
}

async function exaFetch(ctx, config, options, request, signal, notices) {
  const apiKey = await requireKey(ctx, config, 'exa')
  const url = text(request?.url)
  if (!options.mainContent) {
    dropOption(options, notices, 'exa', 'mainContent', 'it always returns extracted page text')
  }
  const payload = await postJson(
    `${config.exaBaseURL}/contents`,
    { urls: [url], text: true },
    {
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      timeoutMs: config.exaTimeoutMs,
      signal,
      label: 'exa contents',
      vendor: 'exa',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) throw providerError('exa returned no page content', 'WEB_PROVIDER_EMPTY')
  const content = text(first.text) || (Array.isArray(first.highlights) ? first.highlights.join('\n\n') : '')
  return documentResult(content, config.exaMaxChars, text(first.url) || url)
}

async function tavilyFetch(ctx, config, options, request, signal) {
  const apiKey = await requireKey(ctx, config, 'tavily')
  const url = text(request?.url)
  const payload = await postJson(
    `${config.tavilyBaseURL}/extract`,
    { urls: [url] },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.tavilyTimeoutMs,
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
  const raw = text(first.raw_content)
  return documentResult(raw, config.tavilyMaxChars, text(first.url) || url)
}

/* -------------------------------------------------- credential-free fallback -- */

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

async function localFetch(config, request, signal) {
  return withDeadline(signal, config.fallbackTimeoutMs, 'local fetch', async (inner) => {
    let current = parseTarget(request?.url)
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: inner,
        headers: {
          'user-agent': config.fallbackUserAgent,
          accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,application/xml;q=0.7',
        },
      })

      if (REDIRECT_STATUS.has(response.status)) {
        if (hop >= config.fallbackMaxRedirects) {
          await response.body?.cancel().catch(() => {})
          throw providerError(
            `redirect limit (${config.fallbackMaxRedirects}) exceeded for ${current.toString()}`,
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
      const { bytes, truncated: truncatedByBytes } = await readCapped(response, config.fallbackMaxBytes)
      const decoded = decodeBytes(bytes, contentType)
      const truncated = truncatedByBytes || decoded.length > config.fallbackMaxChars
      return {
        url: current.toString(),
        statusCode: response.status,
        body: { kind, content: truncated ? decoded.slice(0, config.fallbackMaxChars) : decoded },
        truncated,
      }
    }
  })
}

/* ------------------------------------------------------------------ plugin -- */

const SEARCH_VENDOR = { tavily: tavilySearch, exa: exaSearch, firecrawl: firecrawlSearch }
const FETCH_VENDOR = { tavily: tavilyFetch, exa: exaFetch, firecrawl: firecrawlFetch }

function createSearchProvider(ctx, config, state) {
  return {
    id: config.providerId,
    available() {
      return true
    },
    async search(request, signal) {
      const vendor = SEARCH_VENDOR[state.searchBackend] ?? SEARCH_VENDOR[DEFAULT_SEARCH]
      const notices = []
      const result = await vendor(ctx, config, state.options, request, signal, notices)
      if (result.sources.length === 0) notices.push(`${state.searchBackend} returned no results for this query`)
      return {
        content: composeAnswer(result.answer, notices),
        sources: result.sources,
        truncated: false,
      }
    },
  }
}

function createFetchProvider(ctx, config, state) {
  return {
    id: config.providerId,
    available() {
      return true
    },
    async fetch(request, signal) {
      const vendor = FETCH_VENDOR[state.fetchBackend] ?? FETCH_VENDOR[DEFAULT_FETCH]
      const notices = []
      try {
        const result = await vendor(ctx, config, { ...state.options, mainContent: config.firecrawlMainContent }, request, signal, notices)
        return withNotices(result, notices)
      } catch (error) {
        if (!config.fallbackToHttp) throw error
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) throw error
        const result = await localFetch(config, request, signal)
        return withNotices(result, [...notices, `fell back to a direct HTTP fetch: ${error?.code ?? 'error'}`])
      }
    },
  }
}

/** Fetch-side notices ride at the end of the body, clearly marked as ours. */
function withNotices(result, notices) {
  if (notices.length === 0) return result
  const trailer = notices.map((notice) => `> provider notice: ${notice}`).join('\n')
  return { ...result, body: { ...result.body, content: `${result.body.content}\n\n${trailer}` } }
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

function createStateRoutes(ctx, config, state) {
  const snapshot = async () => ({
    searchBackend: state.searchBackend,
    fetchBackend: state.fetchBackend,
    backends: BACKENDS,
    options: state.options,
    capabilities: capabilityMatrix(),
    keys: await describeKeys(ctx, config),
    fallbackToHttp: config.fallbackToHttp,
    stateFile: state.storage ?? stateFileCandidates()[0],
  })

  const handler = async (req, res) => {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, await snapshot())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      const body = await readJsonBody(req)
      if (typeof body.searchBackend === 'string') {
        state.searchBackend = backendOr(body.searchBackend, state.searchBackend)
      }
      if (typeof body.fetchBackend === 'string') {
        state.fetchBackend = backendOr(body.fetchBackend, state.fetchBackend)
      }
      if (body.options && typeof body.options === 'object') {
        state.options = normalizeOptions({ ...state.options, ...body.options })
      }
      if (body.setKey && typeof body.setKey === 'object') {
        const vendor = backendOr(body.setKey.vendor, '')
        const value = text(body.setKey.value)
        const credentials = ctx.get('credentials')
        if (vendor === '' || value === '') {
          throw providerError('setKey needs a vendor and a non-empty value', 'WEB_PROVIDER_BAD_REQUEST')
        }
        if (credentials === undefined) {
          throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
        }
        await credentials.set(credentialRefFor(config, vendor), value)
      }
      if (body.clearKey && typeof body.clearKey === 'object') {
        const vendor = backendOr(body.clearKey.vendor, '')
        const credentials = ctx.get('credentials')
        if (vendor === '') throw providerError('clearKey needs a vendor', 'WEB_PROVIDER_BAD_REQUEST')
        if (credentials === undefined) {
          throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
        }
        await credentials.unset(credentialRefFor(config, vendor))
      }
      const persistence = persistState(state)
      sendJson(res, 200, { ...(await snapshot()), persistence })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error), code: error?.code })
    }
  }

  return ctx.webServer.register({ kind: 'exact', path: ROUTE, handler })
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const state = loadState(resolved)
  ctx.web.registerSearchProvider(createSearchProvider(ctx, resolved, state))
  ctx.web.registerFetchProvider(createFetchProvider(ctx, resolved, state))
  try {
    createStateRoutes(ctx, resolved, state)
  } catch (error) {
    // A route already registered for this path means the previous fiber has not
    // disposed yet. Losing the settings page is survivable; losing the web
    // backends because this row refused to activate is not.
    ctx.logger?.warn?.(`${PLUGIN}: settings route unavailable: ${error?.message ?? String(error)}`)
  }
}
