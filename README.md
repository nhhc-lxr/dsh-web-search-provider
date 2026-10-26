# dsh-web-tool-provider

DeepSeek Harness 的 `web_search` / `web_fetch` 与 **Tavily / Exa / Firecrawl** 之间的**归一化中间层**。

```text
web_search ─┐                          ┌─ tavily
            ├─ ctx.web 统一契约 ───────┤
web_fetch  ─┘   （本插件负责转换）        └─ exa / firecrawl
```

- **输入归一**：通用层只有域名白/黑名单；每次查询固定 5 条；其余厂商参数（深度、主题、格式、地区……）全部由插件内部的默认值决定，界面不暴露。
- **输出归一**：一个 source 形状、一种日期格式、一套错误码；厂商的 `author`/`warnings`/`failed_results` 都折进同一处。
- **不向厂商索要答案或逐条正文**：Tavily 的 `include_answer` 与 Exa 的 `contents.highlights` 都关闭，`content` 只承载降级 notice，正文一律走 `web_fetch`。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
```

## 设置页

**Settings → Plugins → 网页工具后端**，一页三块：

```text
┌ 后端选择 ─────────────────────────┐
│ web_search   [ Tavily    ▾ ]      │
│ web_fetch    [ Firecrawl ▾ ]      │
├ 通用选项 ─────────────────────────┤
│ 只搜这些域名   [ a.com, b.com   ]  │
│ 排除这些域名   [ ...            ]  │
│ 后端失败时退回直接 HTTP 抓取  [✓]  │
├ API 密钥 ─────────────────────────┤
│ Tavily     [已配置] [____] 保存 清除│
│ Exa        [未配置] [____] 保存 清除│
│ Firecrawl  [已配置] [____] 保存 清除│
└──────────────────────────────────┘
```

没有保存按钮：下拉框与勾选框**改动即存**，域名输入框**停止输入 600ms 后自动保存**。密钥仍需手动点「保存」，避免输一半就被写进凭据库。

密钥解析顺序：插件配置里的字面量 → 凭据库 → 环境变量（`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`），每次调用重新解析。**字面量密钥不会被写进状态文件。**

## 配置（YAML，可选）

界面只动后端与通用选项；下面的字段只从 profile 的 `cordis.patch.yml` 读取，作为**首次运行的默认值**：

| 层 | 字段 |
|---|---|
| `search` | `backend`、`includeDomains`、`excludeDomains` |
| `fetch` | `backend`、`fallbackToHttp` |
| `providers.tavily` | `baseURL`、`timeoutMs`、`maxChars`、`topic`、`searchDepth`、`apiKey`、`apiKeyEnv` |
| `providers.exa` | `baseURL`、`timeoutMs`、`maxChars`、`searchType`、`apiKey`、`apiKeyEnv` |
| `providers.firecrawl` | `baseURL`、`timeoutMs`、`maxChars`、`version`、`mainContent`、`maxAge`、`apiKey`、`apiKeyEnv` |

后端与通用选项存在插件自管状态文件（`<profile>/.web-tool-provider/state.json`，回退 `$DSH_HOME`、`~/.dsh`）；状态文件优先于 Config。

## 输出契约

```ts
SearchResult = { content?: string; sources: { url; title?; snippet?; publishedAt? }[]; truncated: boolean }
FetchResult  = { url: string; statusCode: number; body: { kind: 'text' | 'html'; content: string }; truncated: boolean }
```

- `snippet` 单行、≤400 字；`author` 以 ` · 作者` 附在末尾。
- `publishedAt` 一律 `YYYY-MM-DD`；Tavily 需显式请求 `include_published_date` 才有，Firecrawl 只有少数结果带。
- **Exa 没有 snippet**：不请求 `contents` 之后，它的结果只剩链接、标题和日期。
- `content` 只装降级 notice（我们不向厂商要答案）；抓取降级也会附 `> provider notice: fell back ...`。
- 错误码：`WEB_PROVIDER_UNAUTHORIZED` / `_QUOTA_EXCEEDED` / `_RATE_LIMITED` / `_BAD_REQUEST` / `_UPSTREAM` / `_UNREACHABLE` / `_EMPTY` / `_CREDENTIAL_MISSING`、`WEB_ABORTED`、`WEB_INVALID_URL`、`WEB_BLOCKED_URL`。

## 各后端的实际请求参数

| | 搜索 | 抓取 |
|---|---|---|
| Tavily | `max_results=5`、`search_depth`(basic)、`topic`(general)、`include_published_date` | `/extract` |
| Exa | `numResults=5`、`type`(auto)，**无 contents** | `/contents`（`text: true`） |
| Firecrawl | `limit=5`、`sources=['web']` | `/v2/scrape`（markdown、onlyMainContent、48h 缓存） |

这些都能在 YAML 里覆盖，见上一节。

## 行为

- **`web_search` 多 query = 多次厂商调用**（工具层并发 fan-out 后合并）。
- **抓取结果一律 `text`**：三家给的都是 markdown/文本，标成 `html` 会让工具层再转一遍。
- **抓取降级**：厂商报错/额度/无密钥/空正文/超时 → 本地抓取并附带 notice；目标页 4xx 是结果不降级；abort 不降级。
- **搜索不降级**：选中的后端没配密钥就报 `WEB_PROVIDER_CREDENTIAL_MISSING`。

本地抓取只做协议白名单、明文内网/回环地址拦截、逐跳重定向校验与字节上限，**没有**官方 `dsh-web-fetch-http` 的 DNS 解析+公网校验+连接钉扎。要那层保护就关掉 `fallbackToHttp`。

## 开发

- `index.js`：两层设置 + 归一化层 + 两个 provider + 两条 Host 路由，零第三方依赖。
- `client.js`：设置页（两个下拉 + 通用选项 + 三家密钥）。
- `node test/smoke.mjs`：20 项离线测试。

> 改完代码需要**重启一次** Harness 才会加载新的 host 实现；设置页刷新页面即可。

## License

MIT
