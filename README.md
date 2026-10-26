# dsh-web-tool-provider

给 DeepSeek Harness 的 `web_search` 和 `web_fetch` 换后端：**Tavily / Exa / Firecrawl** 任选，在设置页里点两下就换。

```text
web_search / web_fetch          ← dsh-tool-web：名字、参数、提示词、结果渲染、UI 卡片
        │ ctx.web.search() / ctx.web.fetch()
        ▼
  web-tool（本插件的唯一 provider）
        ├── search → tavily | exa | firecrawl
        └── fetch  → tavily | exa | firecrawl → 失败则本地抓取
```

工具层完全不动：每次只换后端，所以工具名、schema、系统提示词、多 query 并发合并、HTML→markdown、结果卡片都不变，KV 缓存也不会失效。后端选择在**每次调用时**解析，保存后下一次调用就生效，不用重启。

## 安装

```bash
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider
# 或固定 commit
dsh plugin --profile web add github:nhhc-lxr/dsh-web-tool-provider#<commit>
```

也可以在 Harness 的插件页直接安装本目录（Plugin Manager → 安装本地目录）。

## 设置页

**Settings → Plugins → 网页工具后端（Web tools）**

- 两个下拉：`web_search 后端` / `web_fetch 后端`（tavily / exa / firecrawl）
- 三行密钥：Tavily / Exa / Firecrawl，各自「保存」「清除」，并显示当前是**已配置 / 来自环境变量 / 来自插件配置 / 未配置**

密钥走 `ctx.credentials`（Harness 的凭据库），不会写进 profile 的 YAML。后端选择通过 `configEditor` 写回你自己的配置层，所以重启后仍然有效。

也可以完全不用界面：在 `cordis.patch.yml` 里给 `web-tool-provider` 行写 `searchBackend` / `fetchBackend`，密钥用环境变量 `TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY`。

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `searchBackend` / `fetchBackend` | `tavily` / `firecrawl` | 选择后端 |
| `searchProviderId` / `fetchProviderId` | `web-tool` | 注册到 `ctx.web` 的 id；改了要同步改 `web` 行 |
| `tavilyApiKey` / `exaApiKey` / `firecrawlApiKey` | – | 字面量密钥（优先级最高，会落到 profile 配置里） |
| `*ApiKeyEnv` | `TAVILY_API_KEY` / `EXA_API_KEY` / `FIRECRAWL_API_KEY` | 同时是环境变量名和凭据库引用名 |
| `*BaseURL` | 各家官方地址 | 自建网关/代理时改这里 |
| `tavilySearchDepth` / `tavilyIncludeAnswer` / `tavilyMaxResults` | `basic` / `true` / `8` | Tavily 检索参数 |
| `exaSearchType` / `exaNumResults` | `auto` / `8` | Exa 检索参数 |
| `firecrawlOnlyMainContent` / `firecrawlMaxAge` / `firecrawlSearchLimit` | `true` / 48h / `10` | Firecrawl 抓取与搜索参数 |
| `*MaxChars` / `*TimeoutMs` | 见 `index.js` | 正文上限与超时 |
| `fallbackToHttp` | `true` | 抓取失败时退回无需密钥的本地抓取 |
| `fallbackTimeoutMs` / `fallbackMaxBytes` / `fallbackMaxRedirects` | `20000` / `5MB` / `5` | 本地抓取预算 |

## 行为

- **`web_search` 一次多 query = 多次后端调用**（工具层并发 fan-out 再按名次合并）。在意额度就把 `dsh-tool-web` 的 `searchMaxQueries` 调成 1。
- **抓取结果一律作为 `text` 返回**：Firecrawl/Exa 已经给 markdown，若标成 `html` 工具层会再转一遍，结果会糊。
- **抓取降级**：后端报错、额度不足、密钥缺失、空正文、超时 → 本地抓取；目标页 4xx 是结果不触发降级；取消（abort）不降级。
- **搜索没有降级**：选中的后端没配密钥就返回明确错误，提示去设置页填。

本地抓取只做协议白名单、明文内网/回环/链路本地地址拦截、逐跳重定向校验和字节上限；它**没有**官方 `dsh-web-fetch-http` 的 DNS 解析 + 公网地址校验 + 连接钉扎。需要那层保护就把 `fallbackToHttp` 关掉。

## 隐私

用 Tavily / Exa / Firecrawl 时，查询词与目标 URL 会发给对应厂商；本地降级路径不经过第三方。

## 开发

- `index.js`：两个 provider + 分发 + 两条 Host 路由，零 import。
- `client.js`：设置页，`window.__ModuleLoader__` 模块，注册进 `settings.plugins.tab`。
- `node test/smoke.mjs`：14 项离线测试（请求体、字段映射、后端切换、凭据来源、降级、路由、持久化）。

## License

MIT
