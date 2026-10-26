/**
 * dsh-web-tool-provider
 *
 * One `ctx.web` provider per capability, each dispatching to a selectable
 * backend:
 *
 *   web_search  ->  ctx.web.search()  ->  [ tavily | exa | firecrawl ]
 *   web_fetch   ->  ctx.web.fetch()   ->  [ tavily | exa | firecrawl ]  (+ local fallback)
 *
 * The model-facing tools stay owned by `dsh-tool-web`: names, schemas, prompt
 * guidance, multi-query fan-out and result rendering never change. Only the
 * engine behind them does.
 *
 * Which backend runs is decided per call from `state`, which the settings page
 * updates through two Host routes:
 *
 *   GET  /web-tool-provider/state   -> backends + per-vendor credential state
 *   POST /web-tool-provider/state   -> switch backends, store or clear keys
 *
 * Backend choice persists in a small plugin-owned JSON file under `$DSH_HOME`
 * (never through the config editor: re-applying the profile re-mounts this row
 * and a second `webServer.register` for the same path is a hard error). Keys
 * persist through `credentials` and are never written to disk by this plugin.
 *
 * No package imports: plain JS on Node's global fetch and builtins, so the
 * bundle survives Harness version drift and needs no install script.
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

const backendOr = (value, fallback) => {
  const candidate = text(value).toLowerCase()
  return BACKENDS.includes(candidate) ? candidate : fallback
}

function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = {
    searchBackend: backendOr(input.searchBackend, DEFAULT_SEARCH),
    fetchBackend: backendOr(input.fetchBackend, DEFAULT_FETCH),
    searchProviderId: text(input.searchProviderId) || PROVIDER_ID,
    fetchProviderId: text(input.fetchProviderId) || PROVIDER_ID,

    tavilyApiKey: text(input.tavilyApiKey),
    tavilyApiKeyEnv: text(input.tavilyApiKeyEnv) || CREDENTIAL_REF.tavily,
    tavilyBaseURL: stripTrailingSlash(text(input.tavilyBaseURL) || TAVILY_DEFAULT_BASE),
    tavilySearchDepth: text(input.tavilySearchDepth) || 'basic',
    tavilyTopic: text(input.tavilyTopic) || 'general',
    tavilyIncludeAnswer: booleanOr(input.tavilyIncludeAnswer, true),
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
    firecrawlOnlyMainContent: booleanOr(input.firecrawlOnlyMainContent, true),
    firecrawlMaxAge: integerOr(input.firecrawlMaxAge, 172800000, 0, 604800000),
    firecrawlTimeoutMs: integerOr(input.firecrawlTimeoutMs, 30000, 1000, MAX_TIMER_MS),
    firecrawlMaxChars: integerOr(input.firecrawlMaxChars, 100000, 1000, 5000000),
    firecrawlSearchLimit: integerOr(input.firecrawlSearchLimit, 10, 1, 100),

    fallbackToHttp: booleanOr(input.fallbackToHttp, true),
    fallbackTimeoutMs: integerOr(input.fallbackTimeoutMs, 20000, 1000, MAX_TIMER_MS),
    fallbackMaxChars: integerOr(input.fallbackMaxChars, 100000, 1000, 5000000),
    fallbackMaxBytes: integerOr(input.fallbackMaxBytes, 5000000, 1000, 50000000),
    fallbackMaxRedirects: integerOr(input.fallbackMaxRedirects, 5, 0, 20),
    fallbackUserAgent: text(input.fallbackUserAgent) || `${PLUGIN}/0.2.0`,
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

/** Backend choice survives restarts; the first readable candidate wins. */
function loadState(config) {
  for (const file of stateFileCandidates()) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return {
        searchBackend: backendOr(raw?.searchBackend, config.searchBackend),
        fetchBackend: backendOr(raw?.fetchBackend, config.fetchBackend),
        storage: file,
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { searchBackend: config.searchBackend, fetchBackend: config.fetchBackend, storage: undefined }
}

/** Write the first candidate that accepts it and report where it landed. */
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
    if (timedOut) throw providerError(`${label} timed out after ${timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')
    throw providerError(`${label} failed: ${error?.message ?? String(error)}`, 'WEB_PROVIDER_ERROR')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function postJson(url, body, { headers, timeoutMs, signal, label }) {
  return withDeadline(signal, timeoutMs, label, async (inner) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: inner,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw providerError(`${label} failed with HTTP ${response.status}: ${clip(raw, 300)}`, 'WEB_PROVIDER_ERROR')
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw providerError(`${label} returned a non-JSON response`, 'WEB_PROVIDER_ERROR')
    }
  })
}

/** Normalize whichever result-array shape a vendor uses into WebSearchSource[]. */
function toSources(items) {
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const url = text(item?.url) || text(item?.link) || text(item?.metadata?.sourceURL)
    if (url === '' || seen.has(url)) continue
    seen.add(url)
    const source = { url }
    const title = text(item?.title)
    if (title !== '') source.title = title
    const highlights = Array.isArray(item?.highlights) ? item.highlights.map((entry) => text(entry)).filter(Boolean).join(' ') : ''
    const snippet =
      text(item?.description) ||
      text(item?.snippet) ||
      text(item?.summary) ||
      text(item?.text) ||
      text(item?.content) ||
      highlights
    if (snippet !== '') {
      const flat = snippet.replace(/\s+/g, ' ')
      source.snippet = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat
    }
    const publishedAt = text(item?.published_date) || text(item?.publishedDate) || text(item?.date)
    if (publishedAt !== '') source.publishedAt = publishedAt
    sources.push(source)
  }
  return sources
}

const clampResults = (request, fallback, master) => {
  const requested = Number.isFinite(request?.maxResults) ? Math.round(request.maxResults) : fallback
  return Math.max(1, Math.min(master, requested))
}

/* ---------------------------------------------------------------- searches -- */

async function tavilySearch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'tavily')
  const body = {
    query: text(request?.query),
    max_results: clampResults(request, config.tavilyMaxResults, config.tavilyMaxResults),
    search_depth: config.tavilySearchDepth,
    topic: config.tavilyTopic,
  }
  if (config.tavilyIncludeAnswer) body.include_answer = true
  const payload = await postJson(`${config.tavilyBaseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: config.tavilyTimeoutMs,
    signal,
    label: 'Tavily search',
  })
  const answer = text(payload?.answer)
  return {
    content: answer === '' ? undefined : answer,
    sources: toSources(payload?.results),
    truncated: false,
  }
}

async function exaSearch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'exa')
  const body = {
    query: text(request?.query),
    type: config.exaSearchType,
    numResults: clampResults(request, config.exaNumResults, 100),
    contents: { highlights: true },
  }
  const payload = await postJson(`${config.exaBaseURL}/search`, body, {
    headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    timeoutMs: config.exaTimeoutMs,
    signal,
    label: 'Exa search',
  })
  const answer = text(payload?.output)
  return {
    content: answer === '' ? undefined : answer,
    sources: toSources(payload?.results),
    truncated: false,
  }
}

async function firecrawlSearch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'firecrawl')
  const payload = await postJson(
    `${config.firecrawlBaseURL}/${config.firecrawlApiVersion}/search`,
    {
      query: text(request?.query),
      limit: clampResults(request, config.firecrawlSearchLimit, 100),
      sources: ['web'],
    },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.firecrawlTimeoutMs,
      signal,
      label: 'Firecrawl search',
    },
  )
  if (payload?.success === false) {
    throw providerError(
      `Firecrawl search failed: ${clip(payload?.error ?? 'unknown error', 300)}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  const data = payload?.data
  const items = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : []
  return { content: undefined, sources: toSources(items), truncated: false }
}

/* ----------------------------------------------------------------- fetches -- */

const markdownResult = (markdown, maxChars, url, statusCode = 200) => {
  const body = text(markdown)
  if (body === '') throw providerError('the provider returned no page content', 'WEB_PROVIDER_ERROR')
  const truncated = body.length > maxChars
  return {
    url,
    statusCode,
    body: {
      // Markdown is handed over as text so dsh-tool-web does not run its
      // HTML->markdown pipeline a second time.
      kind: 'text',
      content: truncated ? body.slice(0, maxChars) : body,
    },
    truncated,
  }
}

async function firecrawlFetch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'firecrawl')
  const url = text(request?.url)
  const payload = await postJson(
    `${config.firecrawlBaseURL}/${config.firecrawlApiVersion}/scrape`,
    {
      url,
      formats: ['markdown'],
      onlyMainContent: config.firecrawlOnlyMainContent,
      maxAge: config.firecrawlMaxAge,
      timeout: config.firecrawlTimeoutMs,
    },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.firecrawlTimeoutMs + 15000,
      signal,
      label: 'Firecrawl scrape',
    },
  )
  if (payload?.success === false) {
    throw providerError(
      `Firecrawl scrape failed: ${clip(payload?.error ?? payload?.message ?? 'unknown error', 300)}`,
      'WEB_PROVIDER_ERROR',
    )
  }
  const doc = payload?.data ?? payload
  const metadata = doc?.metadata ?? {}
  const statusCode = Number.isInteger(metadata.statusCode) ? metadata.statusCode : 200
  const finalUrl = text(metadata.url) || text(metadata.sourceURL) || url
  return markdownResult(doc?.markdown ?? doc?.content, config.firecrawlMaxChars, finalUrl, statusCode)
}

async function exaFetch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'exa')
  const url = text(request?.url)
  const payload = await postJson(
    `${config.exaBaseURL}/contents`,
    { urls: [url], text: true },
    {
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      timeoutMs: config.exaTimeoutMs,
      signal,
      label: 'Exa contents',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  if (first === undefined) throw providerError('Exa returned no page content', 'WEB_PROVIDER_ERROR')
  const content =
    text(first.text) || (Array.isArray(first.highlights) ? first.highlights.map((entry) => text(entry)).join('\n\n') : '')
  if (content === '') throw providerError('Exa returned no page content', 'WEB_PROVIDER_ERROR')
  const truncated = content.length > config.exaMaxChars
  return {
    url: text(first.url) || url,
    statusCode: 200,
    body: { kind: 'text', content: truncated ? content.slice(0, config.exaMaxChars) : content },
    truncated,
  }
}

async function tavilyFetch(ctx, config, request, signal) {
  const apiKey = await requireKey(ctx, config, 'tavily')
  const url = text(request?.url)
  const payload = await postJson(
    `${config.tavilyBaseURL}/extract`,
    { urls: [url] },
    {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.tavilyTimeoutMs,
      signal,
      label: 'Tavily extract',
    },
  )
  const first = Array.isArray(payload?.results) ? payload.results[0] : undefined
  const raw = text(first?.raw_content) || text(payload?.raw_content)
  if (raw === '') throw providerError('Tavily returned no page content', 'WEB_PROVIDER_ERROR')
  const truncated = raw.length > config.tavilyMaxChars
  return {
    url: text(first?.url) || url,
    statusCode: 200,
    body: { kind: 'text', content: truncated ? raw.slice(0, config.tavilyMaxChars) : raw },
    truncated,
  }
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
    throw providerError(`reading the response body failed: ${error?.message ?? String(error)}`, 'WEB_PROVIDER_ERROR')
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
            'WEB_PROVIDER_ERROR',
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
    id: config.searchProviderId,
    available() {
      return true
    },
    async search(request, signal) {
      const vendor = SEARCH_VENDOR[state.searchBackend] ?? SEARCH_VENDOR[DEFAULT_SEARCH]
      return vendor(ctx, config, request, signal)
    },
  }
}

function createFetchProvider(ctx, config, state) {
  return {
    id: config.fetchProviderId,
    available() {
      return true
    },
    async fetch(request, signal) {
      const vendor = FETCH_VENDOR[state.fetchBackend] ?? FETCH_VENDOR[DEFAULT_FETCH]
      try {
        return await vendor(ctx, config, request, signal)
      } catch (error) {
        if (!config.fallbackToHttp) throw error
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) throw error
        return localFetch(config, request, signal)
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
    if (size > BODY_LIMIT_BYTES) throw providerError('request body too large', 'WEB_PROVIDER_ERROR')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw providerError('request body must be JSON', 'WEB_PROVIDER_ERROR')
  }
}

function createStateRoutes(ctx, config, state) {
  const snapshot = async () => ({
    searchBackend: state.searchBackend,
    fetchBackend: state.fetchBackend,
    backends: BACKENDS,
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
      if (body.setKey && typeof body.setKey === 'object') {
        const vendor = backendOr(body.setKey.vendor, '')
        const value = text(body.setKey.value)
        const credentials = ctx.get('credentials')
        if (vendor === '' || value === '') {
          throw providerError('setKey needs a vendor and a non-empty value', 'WEB_PROVIDER_ERROR')
        }
        if (credentials === undefined) throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
        await credentials.set(credentialRefFor(config, vendor), value)
      }
      if (body.clearKey && typeof body.clearKey === 'object') {
        const vendor = backendOr(body.clearKey.vendor, '')
        const credentials = ctx.get('credentials')
        if (vendor === '') throw providerError('clearKey needs a vendor', 'WEB_PROVIDER_ERROR')
        if (credentials === undefined) throw providerError('the credentials service is not available', 'WEB_PROVIDER_ERROR')
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
