/**
 * dsh-web-search-provider
 *
 * Two interchangeable `ctx.web` backends for DeepSeek Harness:
 *   - search: Tavily   (default provider id "tavily")
 *   - fetch : Firecrawl (default provider id "firecrawl")
 *
 * The model-facing `web_search` / `web_fetch` tools belong to the shipped
 * `dsh-tool-web` package and are untouched here: this bundle only supplies
 * backends, so tool names, schemas, prompt guidance, multi-query fan-out,
 * HTML→markdown rendering, result caps and UI cards all stay exactly as they
 * were. Selection happens in the `web` row (`searchProvider` / `fetchProvider`),
 * which this bundle's patch pins.
 *
 * Zero imports: everything is plain JS on Node's global fetch, so the bundle
 * keeps working across Harness versions and needs no install script.
 */

const PLUGIN = 'web-search-provider'
const DEFAULT_SEARCH_ID = 'tavily'
const DEFAULT_FETCH_ID = 'firecrawl'
const TAVILY_DEFAULT_BASE = 'https://api.tavily.com'
const FIRECRAWL_DEFAULT_BASE = 'https://api.firecrawl.dev'
const MAX_TIMER_MS = 2147483647
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/

export const name = PLUGIN
export const inject = ['web']

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

/** Literal key first, then the named environment variable; re-read per call. */
function resolveSecret(literal, envName) {
  const direct = text(literal)
  if (direct !== '') return direct
  return text(process.env[envName])
}

function assertHttpUrl(value, field) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${PLUGIN}: config.${field} must be an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${PLUGIN}: config.${field} must use http: or https:`)
  }
}

function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}

  const searchId = text(input.searchProviderId) || DEFAULT_SEARCH_ID
  const fetchId = text(input.fetchProviderId) || DEFAULT_FETCH_ID
  for (const [field, value] of [
    ['searchProviderId', searchId],
    ['fetchProviderId', fetchId],
  ]) {
    if (!PROVIDER_ID.test(value)) {
      throw new Error(`${PLUGIN}: config.${field} ${JSON.stringify(value)} is not a valid provider id`)
    }
  }
  if (searchId === fetchId) {
    // Legal for ctx.web (separate registries) but almost always a typo.
    throw new Error(`${PLUGIN}: config.searchProviderId and config.fetchProviderId must differ`)
  }

  const config = {
    registerSearch: booleanOr(input.enableSearch, true),
    registerFetch: booleanOr(input.enableFetch, true),
    searchId,
    fetchId,

    tavilyApiKey: text(input.tavilyApiKey),
    tavilyApiKeyEnv: text(input.tavilyApiKeyEnv) || 'TAVILY_API_KEY',
    tavilyBaseURL: stripTrailingSlash(text(input.tavilyBaseURL) || TAVILY_DEFAULT_BASE),
    tavilySearchDepth: text(input.tavilySearchDepth) || 'basic',
    tavilyTopic: text(input.tavilyTopic) || 'general',
    tavilyIncludeAnswer: booleanOr(input.tavilyIncludeAnswer, true),
    tavilyMaxResults: integerOr(input.tavilyMaxResults, 8, 1, 20),
    tavilyTimeoutMs: integerOr(input.tavilyTimeoutMs, 20000, 1000, MAX_TIMER_MS),

    firecrawlApiKey: text(input.firecrawlApiKey),
    firecrawlApiKeyEnv: text(input.firecrawlApiKeyEnv) || 'FIRECRAWL_API_KEY',
    firecrawlBaseURL: stripTrailingSlash(text(input.firecrawlBaseURL) || FIRECRAWL_DEFAULT_BASE),
    firecrawlApiVersion: text(input.firecrawlApiVersion) || 'v2',
    firecrawlOnlyMainContent: booleanOr(input.firecrawlOnlyMainContent, true),
    firecrawlMaxAge: integerOr(input.firecrawlMaxAge, 172800000, 0, 604800000),
    firecrawlTimeoutMs: integerOr(input.firecrawlTimeoutMs, 30000, 1000, MAX_TIMER_MS),
    firecrawlMaxChars: integerOr(input.firecrawlMaxChars, 100000, 1000, 5000000),

    fallbackToHttp: booleanOr(input.fallbackToHttp, true),
    fallbackTimeoutMs: integerOr(input.fallbackTimeoutMs, 20000, 1000, MAX_TIMER_MS),
    fallbackMaxChars: integerOr(input.fallbackMaxChars, 100000, 1000, 5000000),
    fallbackMaxBytes: integerOr(input.fallbackMaxBytes, 5000000, 1000, 50000000),
    fallbackMaxRedirects: integerOr(input.fallbackMaxRedirects, 5, 0, 20),
    fallbackUserAgent: text(input.fallbackUserAgent) || `${PLUGIN}/0.1.0`,
  }

  if (config.registerSearch) assertHttpUrl(config.tavilyBaseURL, 'tavilyBaseURL')
  if (config.registerFetch) assertHttpUrl(config.firecrawlBaseURL, 'firecrawlBaseURL')
  if (!PROVIDER_ID.test(config.firecrawlApiVersion)) {
    throw new Error(`${PLUGIN}: config.firecrawlApiVersion must look like "v2"`)
  }
  return config
}

/* ----------------------------------------------------------------- helpers -- */

const clip = (value, limit) => {
  const string = String(value ?? '')
  return string.length > limit ? `${string.slice(0, limit)}…` : string
}

/**
 * Run `task` under one abort signal that also fires on the caller's signal or
 * on the deadline. Every failure leaves as a `WebError`-shaped error so the
 * model-facing tool renders `Error: <message>` instead of a stack trace.
 */
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

/* ------------------------------------------------------------ Tavily search -- */

function createSearchProvider(config) {
  return {
    id: config.searchId,

    available() {
      return resolveSecret(config.tavilyApiKey, config.tavilyApiKeyEnv) !== ''
    },

    async search(request, signal) {
      const apiKey = resolveSecret(config.tavilyApiKey, config.tavilyApiKeyEnv)
      if (apiKey === '') {
        throw providerError(
          `Tavily API key is not configured: set config.tavilyApiKey or $${config.tavilyApiKeyEnv}`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      const query = text(request?.query)
      if (query === '') throw providerError('Tavily search requires a non-empty query', 'WEB_PROVIDER_ERROR')

      const requested = Number.isFinite(request?.maxResults)
        ? Math.round(request.maxResults)
        : config.tavilyMaxResults
      const maxResults = Math.max(1, Math.min(config.tavilyMaxResults, requested))

      const body = {
        query,
        max_results: maxResults,
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

      const sources = []
      const seen = new Set()
      const results = Array.isArray(payload?.results) ? payload.results : []
      for (const item of results) {
        const url = text(item?.url)
        if (url === '' || seen.has(url)) continue
        seen.add(url)
        const source = { url }
        const title = text(item?.title)
        if (title !== '') source.title = title
        const snippet = text(item?.content)
        if (snippet !== '') source.snippet = snippet
        const publishedAt = text(item?.published_date)
        if (publishedAt !== '') source.publishedAt = publishedAt
        sources.push(source)
      }

      const answer = text(payload?.answer)
      return {
        content: answer === '' ? undefined : answer,
        sources,
        truncated: false,
      }
    },
  }
}

/* --------------------------------------------------------- Firecrawl fetch -- */

const META_STATUS = (doc) => {
  const status = doc?.metadata?.statusCode
  return Number.isInteger(status) ? status : 200
}

const META_URL = (doc, fallback) => {
  const sourceURL = text(doc?.metadata?.sourceURL) || text(doc?.metadata?.url)
  return sourceURL === '' ? fallback : sourceURL
}

async function firecrawlFetch(request, config, signal) {
  const apiKey = resolveSecret(config.firecrawlApiKey, config.firecrawlApiKeyEnv)
  const url = text(request?.url)
  if (url === '') throw providerError('url must be a non-empty string', 'WEB_INVALID_URL')

  const endpoint = `${config.firecrawlBaseURL}/${config.firecrawlApiVersion}/scrape`
  const payload = await postJson(
    endpoint,
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
  const markdown = text(doc?.markdown) || text(doc?.content)
  if (markdown === '') throw providerError('Firecrawl scrape returned no markdown content', 'WEB_PROVIDER_ERROR')

  const truncated = markdown.length > config.firecrawlMaxChars
  return {
    url: META_URL(doc, url),
    statusCode: META_STATUS(doc),
    body: {
      // Firecrawl already produces markdown: hand it over as text so
      // dsh-tool-web does not run its HTML→markdown pipeline a second time.
      kind: 'text',
      content: truncated ? markdown.slice(0, config.firecrawlMaxChars) : markdown,
    },
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

async function localFetch(request, config, signal) {
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

/* ------------------------------------------------------------ fetch provider -- */

function createFetchProvider(config) {
  return {
    id: config.fetchId,

    // Available whenever this provider can still produce a retrieval: a key, or
    // the local fallback. A missing key must not turn into
    // WEB_PROVIDER_CONFIGURED_UNAVAILABLE while the fallback is usable.
    available() {
      if (config.fallbackToHttp) return true
      return resolveSecret(config.firecrawlApiKey, config.firecrawlApiKeyEnv) !== ''
    },

    async fetch(request, signal) {
      const hasKey = resolveSecret(config.firecrawlApiKey, config.firecrawlApiKeyEnv) !== ''
      if (!hasKey) {
        if (config.fallbackToHttp) return localFetch(request, config, signal)
        throw providerError(
          `Firecrawl API key is not configured: set config.firecrawlApiKey or $${config.firecrawlApiKeyEnv}`,
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      try {
        return await firecrawlFetch(request, config, signal)
      } catch (error) {
        if (!config.fallbackToHttp) throw error
        if (error?.code === 'WEB_ABORTED' || signal?.aborted) throw error
        // Credentials, credits, transport, empty markdown: retry locally.
        return localFetch(request, config, signal)
      }
    },
  }
}

/* ---------------------------------------------------------------- plugin --- */

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (resolved.registerSearch) ctx.web.registerSearchProvider(createSearchProvider(resolved))
  if (resolved.registerFetch) ctx.web.registerFetchProvider(createFetchProvider(resolved))
}
