# dsh-web-search-provider

把 DeepSeek Harness 的 `web_search` / `web_fetch` 换成 **Tavily** 搜索 + **Firecrawl** 抓取，工具本身不动。

```text
web_search / web_fetch            ← dsh-tool-web：名字、参数、提示词、结果渲染、UI 卡片
        │  ctx.web.search() / ctx.web.fetch()
        ▼
   选择器（每次调用解析一次）
        ├── Search 注册表 → tavily        ← 本插件
        └── Fetch  注册表 → firecrawl     ← 本插件（失败可退回本地抓取）
```

也就是说：**对模型是替换，在注册表里是共存。** 旧的 `deepseek-official` / `http` 后端仍然挂着，改一行配置就能切回去；每次调用只会跑其中一个 provider，没有自动轮询或链式降级（本插件内部的 Firecrawl → 本地抓取降级是它自己实现的）。

## 安装

应用内（Plugin Manager 安装目录，或从 dshmarket 一键装）：

```bash
# 从 GitHub 源码安装并挂载
dsh plugin --profile web add github:nhhc-lxr/dsh-web-search-provider

# 建议固定到已被市场扫描过的 commit
dsh plugin --profile web add github:nhhc-lxr/dsh-web-search-provider#<scanned_commit>
```

装完重启 Harness 一次（首次加载新的 JS 模块需要重启；之后切换后端不需要）。

## 密钥：二选一，或都用

两个 provider 各自支持「字面量 key」和「环境变量」，**字面量优先，缺省读环境变量**，并且每次调用都重新解析，所以轮换 key 不用重启：

```bash
# 二选一即可
setx TAVILY_API_KEY "..."
setx FIRECRAWL_API_KEY "..."
```

或者写进插件行的 `config`（明文落在 profile 里，注意别提交到仓库）：

```yaml
- id: web-search-provider
  name: 'dsh-web-search-provider'
  config:
    tavilyApiKey: 'tvly-...'
    firecrawlApiKey: 'fc-...'
```

只配一个也能跑：没有 Firecrawl key 时，`web_fetch` 直接走本地抓取；没有 Tavily key 时 `web_search` 会返回明确错误（`Tavily API key is not configured ...`）。

## 配置

全部可选，缺省值如下。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enableSearch` / `enableFetch` | `true` | 是否注册对应 provider |
| `searchProviderId` / `fetchProviderId` | `tavily` / `firecrawl` | 注册 id；改了要同步改 `web` 行的选择 |
| `tavilyApiKey` / `tavilyApiKeyEnv` | `''` / `TAVILY_API_KEY` | 密钥来源 |
| `tavilyBaseURL` | `https://api.tavily.com` | 支持自建/代理网关 |
| `tavilySearchDepth` / `tavilyTopic` | `basic` / `general` | Tavily 的检索深度与主题 |
| `tavilyIncludeAnswer` | `true` | 是否要 Tavily 的总结（会成为 `web_search` 的 answer 段） |
| `tavilyMaxResults` | `8` | 单次搜索上限，1–20；工具层还会再按 `searchMaxResults` 截断 |
| `tavilyTimeoutMs` | `20000` | 单次搜索超时 |
| `firecrawlApiKey` / `firecrawlApiKeyEnv` | `''` / `FIRECRAWL_API_KEY` | 密钥来源 |
| `firecrawlBaseURL` | `https://api.firecrawl.dev` | 可换 `v1` 老网关或自建 |
| `firecrawlApiVersion` | `v2` | 路径里的版本段，会拼成 `/{version}/scrape` |
| `firecrawlOnlyMainContent` | `true` | 只取正文，去掉导航与页脚 |
| `firecrawlMaxAge` | `172800000` | 缓存容忍时长（毫秒），48h 内命中缓存不重新抓 |
| `firecrawlTimeoutMs` / `firecrawlMaxChars` | `30000` / `100000` | 抓取超时与正文上限 |
| `fallbackToHttp` | `true` | Firecrawl 失败时退回本地抓取 |
| `fallbackTimeoutMs` / `fallbackMaxChars` / `fallbackMaxBytes` | `20000` / `100000` / `5000000` | 本地抓取预算 |
| `fallbackMaxRedirects` / `fallbackUserAgent` | `5` / `dsh-web-search-provider/0.1.0` | 本地抓取的跳转与 UA |

## 行为细节

- **`web_search` 一次给多个 query = 多次 Tavily 调用。** 工具层对 query 数组是并发 fan-out 再按名次合并，插件不做批量化。在意 credits 就把 `dsh-tool-web` 的 `searchMaxQueries` 调成 1。
- **markdown 作为 `text` 返回。** Firecrawl 已经产出 markdown，若标成 `html`，工具层会再跑一遍 HTML→markdown，结果会糊。
- **非 2xx 是结果，不是错误。** Firecrawl 正常返回的页面状态码会原样透传成 `Fetched <url> (HTTP 404)`。
- **降级只发生在「抓不到」时**：密钥缺失、额度/鉴权失败、网络错误、空正文、超时。目标页返回 4xx 不触发降级。
- **取消会透传：** 工具层的 30s 预算通过 signal 下来，中断时抛 `WEB_ABORTED`，不会误触发降级。

## 安全边界

本地抓取（降级路径）**没有**官方 `dsh-web-fetch-http` 那套 DNS 解析 + 公网地址校验 + 连接钉扎：它只做协议白名单、明文内网/回环/链路本地地址拦截、逐跳重定向校验和字节/字符上限。官方 provider 把域名解析结果整组校验，能挡住「公网域名指向内网 IP」；本地降级挡不住这一种。

需要那层保护时：把 `fetchProvider` 固定成 `http`，或设 `fallbackToHttp: false`（此时 Firecrawl 失败就失败，并返回明确错误）。

另外，启用 Firecrawl 后**目标 URL 与页面内容都会经过 Firecrawl**；Tavily 同理。这与官方匿名 HTTP 抓取（不向第三方发送 URL）是不同的隐私面。

## 切回内置后端

删掉本插件 patch 里的第二个条目（`- id: web`），或把它改成：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

`web` 行的 `config` 是整段替换（不深合并），所以两个字段都要写。选择在**每次调用时**解析，保存后下一次 `web_search` / `web_fetch` 就生效。

## 兼容性

- 不 import 任何 `@deepseek-ai/*` 包，只用 Node 全局 `fetch`，因此不随 Harness 版本漂移，也没有安装脚本。
- 依赖 `ctx.web`（`inject: ['web']`）与 `WebSearchProvider` / `WebFetchProvider` 契约；这两个契约自 `dsh-web` 起稳定。
- Node `^22.19.0 || >=24.0.0`。

## 开发

单文件 `index.js`（约 520 行，无依赖），`cordis.patch.yml` 负责挂载与选择。改完直接 `node --check index.js`，再在 Harness 里重新加载。

## License

MIT
