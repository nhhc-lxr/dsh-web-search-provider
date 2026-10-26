# dsh-web-tool-provider

DeepSeek Harness 的 `web_search` / `web_fetch` 与 **Tavily / Exa / Firecrawl** 之间的**归一化中间层**。

```text
web_search ─┐                          ┌─ tavily
            ├─ ctx.web 统一契约 ───────┤
web_fetch  ─┘   （本插件负责转换）        └─ exa / firecrawl
```

- **输入归一**：通用层只有条数、深度、域名白/黑名单；厂商独占的项留在各自的卡片里（例如只有 Tavily 有「合成答案」）。每个 adapter 负责翻译，厂商做不到的**以 notice 告知模型**，装死不是选项。
- **输出归一**：一个 source 形状、一种日期格式、一套错误码；厂商的 `author`/`warnings`/`failed_results` 都折进同一处。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
```

## 设置页

**Settings → Plugins → 网页工具后端**，三层结构：

```text
┌ API 密钥 ──────────────────────────┐   三家各一行，存进凭据库
├ [搜索 web_search] [抓取 web_fetch] ┤   两个 tab，互不干扰
│  通用参数                          │   条数 / 深度 / 黑白域名
│  Tavily   Exa   Firecrawl          │   各自一张卡：接口地址、超时、正文上限，
└────────────────────────────────────┘   + 该家在该 tab 下的特色项
```

- 每个 tab 顶部是「通用参数」，**只放三家都认的东西**：条数、域名白/黑名单；深度算半通用（Tavily/Exa 有，Firecrawl 没有，会发 notice）。
- 每张 provider 卡片有自己的接口地址、超时、正文上限，以及该家独有的项（Tavily 的 `topic`/`searchDepth`/**`answer`**、Exa 的 `searchType`、Firecrawl 的 `version`/`mainContent`/`maxAge`）。
- 卡片右上角是「使用中」标记；点「设为该工具后端」即切换，下一次调用生效。
- 不支持的通用选项按当前后端标 `支持 / 不支持`，运行时以 `> provider notice: ...` 告知模型，**不会让调用失败**。

密钥解析顺序：插件配置里的字面量 → 凭据库 → 环境变量（`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`），每次调用重新解析。**字面量密钥不会被写进状态文件。**

## 配置（YAML 也可以）

| 层 | 字段 |
|---|---|
| `search` | `backend`、`maxResults`、`depth`(auto/fast/balanced/deep)、`includeDomains`、`excludeDomains` |
| `fetch` | `backend`、`fallbackToHttp` |
| `providers.tavily` | `baseURL`、`timeoutMs`、`maxChars`、`topic`、`searchDepth`、`answer`、`apiKey`、`apiKeyEnv` |
| `providers.exa` | `baseURL`、`timeoutMs`、`maxChars`、`searchType`、`apiKey`、`apiKeyEnv` |
| `providers.firecrawl` | `baseURL`、`timeoutMs`、`maxChars`、`version`、`mainContent`、`maxAge`、`apiKey`、`apiKeyEnv` |

设置存在插件自管状态文件（`<profile>/.web-tool-provider/state.json`，回退 `$DSH_HOME`、`~/.dsh`）；YAML 里的 `Config` 只是首次运行的默认值，状态文件优先。

## 输出契约

```ts
SearchResult = { content?: string; sources: { url; title?; snippet?; publishedAt? }[]; truncated: boolean }
FetchResult  = { url: string; statusCode: number; body: { kind: 'text' | 'html'; content: string }; truncated: boolean }
```

- `snippet` 单行、≤400 字；`author` 以 ` · 作者` 附在末尾；`highlights` 数组拼成一段。
- `publishedAt` 一律 `YYYY-MM-DD`。
- `content` = 「厂商答案 + notices」；抓取降级也会附 `> provider notice: fell back ...`。
- 错误码：`WEB_PROVIDER_UNAUTHORIZED` / `_QUOTA_EXCEEDED` / `_RATE_LIMITED` / `_BAD_REQUEST` / `_UPSTREAM` / `_UNREACHABLE` / `_EMPTY` / `_CREDENTIAL_MISSING`、`WEB_ABORTED`、`WEB_INVALID_URL`、`WEB_BLOCKED_URL`。

## 行为

- **`web_search` 多 query = 多次厂商调用**（工具层并发 fan-out 后合并）。在意额度就调小 `dsh-tool-web` 的 `searchMaxQueries`。
- **抓取结果一律 `text`**：三家给的都是 markdown，标成 `html` 会让工具层再转一遍。
- **抓取降级**：厂商报错/额度/无密钥/空正文/超时 → 本地抓取并附带 notice；目标页 4xx 是结果不降级；abort 不降级。
- **搜索不降级**：选中的后端没配密钥就报 `WEB_PROVIDER_CREDENTIAL_MISSING`，提示去设置页。

本地抓取只做协议白名单、明文内网/回环地址拦截、逐跳重定向校验与字节上限，**没有**官方 `dsh-web-fetch-http` 的 DNS 解析+公网校验+连接钉扎。要那层保护就关掉 `fallbackToHttp`。

## 隐私

用 Tavily / Exa / Firecrawl 时查询词与目标 URL 会发给对应厂商；本地降级路径不经过第三方。

## 开发

- `index.js`：分层设置 + 归一化层 + 两个 provider + 两条 Host 路由，零第三方依赖。
- `client.js`：设置页（两个 tab + 三家卡片），`window.__ModuleLoader__` 模块，注册进 `settings.plugins.tab`。
- `node test/smoke.mjs`：21 项离线测试（同形输出、旋钮翻译、notice、错误分类、降级开关、分层持久化、密钥隔离）。

> 装完或改完代码需要**重启一次** Harness：模块缓存不会因为重新安装而失效。

## License

MIT
