# dsh-web-tool-provider

DeepSeek Harness 的 `web_search` / `web_fetch` 与 **Tavily / Exa / Firecrawl** 之间的**归一化中间层**。

```text
web_search ─┐                    ┌─ tavily
            ├─ ctx.web 统一契约 ─┤
web_fetch  ─┘   （本插件负责转换）  └─ exa / firecrawl
```

工具层（`dsh-tool-web`）只认一套请求与结果结构，三家厂商的差异全部在这里吸收：

- **输入归一**：对外只暴露语义旋钮（时间范围、深度、是否要答案、域名限定、地区），每个 adapter 翻译成厂商自己的参数；厂商做不到的**以 notice 告知模型**，装死不是选项。
- **输出归一**：一个 source 形状、一种日期格式、一套错误码。厂商的 `author`/`score`、`notices`/`warnings`、`failed_results` 都折进同一处，不再漏给上层。

后端与旋钮都在设置页里改，**下一次调用即生效**。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
```

## 统一契约

### 输入：语义旋钮 → 各厂商参数

| 旋钮 | 取值 | Tavily | Exa | Firecrawl |
|---|---|---|---|---|
| `recency` | any / day / week / month / year | ⚠️ 仅 `topic: news` 时有效（否则发 notice） | `startPublishedDate` | `tbs: qdr:*` |
| `depth` | auto / fast / balanced / deep | `search_depth` basic/advanced | `type` lite/auto/deep | ❌ 发 notice |
| `answer` | auto / on / off | `include_answer` | ❌ 仅深度合成模式有 | ❌ 发 notice |
| `includeDomains` / `excludeDomains` | 逗号分隔 | `include_domains` / `exclude_domains` | `includeDomains` / `excludeDomains` | `includeDomains` / `excludeDomains` |
| `locale` | `US`、`zh-CN`、`united states` | ⚠️ `country`（要国家名） | `userLocation`（ISO） | `country`（ISO-2，`zh-CN`→`CN`） |
| `strict` | true / false | 不支持就报错，而不是发 notice | | |

抓取侧只有 `fallbackToHttp` / `firecrawlMainContent` 两个总开关（其余厂商能力差异无意义，直接忽略）。

### 输出：一个形状

```ts
SearchResult = { content?: string; sources: { url; title?; snippet?; publishedAt? }[]; truncated: boolean }
FetchResult  = { url: string; statusCode: number; body: { kind: 'text' | 'html'; content: string }; truncated: boolean }
```

归一化规则：

- `snippet` 单行、≤400 字；厂商的 `author` 以 ` · 作者` 附在末尾；`highlights` 数组拼成一段。
- `publishedAt` 一律 `YYYY-MM-DD`（Exa 的 ISO 时间戳、Tavily 的日期、Firecrawl 的 `date` 都收敛到同一格式）。
- `content` 是「答案 + notices」的拼装：`> provider notice: ...` 行让模型知道哪一项被降级、哪一次抓取退回了本地。
- 错误码统一：`WEB_PROVIDER_UNAUTHORIZED` / `_QUOTA_EXCEEDED` / `_RATE_LIMITED` / `_BAD_REQUEST` / `_UPSTREAM` / `_UNREACHABLE` / `_EMPTY` / `_CREDENTIAL_MISSING`，外加 `WEB_ABORTED`、`WEB_INVALID_URL`、`WEB_BLOCKED_URL`。上层只按码分支，不用管是哪家。

## 设置页

**Settings → Plugins → 网页工具后端**

1. **后端选择**：`web_search` / `web_fetch` 各选一家。
2. **统一检索选项**：上面那张表里的旋钮，按当前搜索后端标注「支持 / 部分支持 / 不支持」，不支持的控件直接禁用。
3. **API 密钥**：三家各一行，保存进 Harness 凭据库（`ctx.credentials`），**不会写进 profile 的 YAML**，也不会落进插件的状态文件。

密钥解析顺序：插件配置里的字面量 → 凭据库 → 环境变量（`TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`），每次调用重新解析。

后端与旋钮存在插件自管状态文件（`<profile>/.web-tool-provider/state.json`，回退 `$DSH_HOME`、`~/.dsh`），不走 config editor——否则重载会二次注册路由把插件弄挂。

## 行为

- **`web_search` 多 query = 多次厂商调用**（工具层并发 fan-out 后按名次合并）。在意额度就调小 `dsh-tool-web` 的 `searchMaxQueries`。
- **抓取结果一律 `text`**：Firecrawl/Exa/Tavily 已经给 markdown，标成 `html` 会让工具层再转一遍。
- **抓取降级**：厂商报错/额度/无密钥/空正文/超时 → 本地抓取，并在正文末尾附 `> provider notice: fell back ...: <错误码>`；目标页 4xx 是结果不降级；abort 不降级。
- **搜索不降级**：选中的后端没配密钥就直接报 `WEB_PROVIDER_CREDENTIAL_MISSING`，提示去设置页。

本地抓取只做协议白名单、明文内网/回环地址拦截、逐跳重定向校验与字节上限，**没有**官方 `dsh-web-fetch-http` 的 DNS 解析+公网校验+连接钉扎。要那层保护就关掉 `fallbackToHttp`。

## 隐私

用 Tavily / Exa / Firecrawl 时查询词与目标 URL 会发给对应厂商；本地降级路径不经过第三方。

## 开发

- `index.js`：归一化层 + 两个 provider + 两条 Host 路由，零第三方依赖。
- `client.js`：设置页，`window.__ModuleLoader__` 模块，注册进 `settings.plugins.tab`。
- `node test/smoke.mjs`：19 项离线测试（三家同形输出、旋钮翻译、notice/strict、错误分类、降级、状态持久化）。

## License

MIT
