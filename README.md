# dsh-web-search-failover

DeepSeek Harness 的搜索故障转移插件：按顺序尝试多个搜索后端，当前一个失败（HTTP 错误、没有 `web_search_tool_result` 结果块、或返回空结果）时自动落到下一个。

## 为什么需要它

Harness 的 `ctx.web` 每次只解析一个 search provider，provider 也只有单个 `model` 字段，没有失败重试链；`web-search-deepseek` 一旦上游出错，整次搜索就失败。new-api 的自动换渠道只在“同一个模型名有多个渠道”时生效，所以要么在网关造一个别名，要么在 harness 侧做转移。本插件选后者：网关保持官方模型名。

## 怎么工作

- 注册 search provider `deepseek-failover`，把 `ctx.web` 的 `searchProvider` 指向它。
- 依次调用 `@deepseek-ai/dsh-web-search-deepseek` 的 provider；每个 backend 有独立的 `model` / `baseURL` / `apiKeyEnv`。
- 失败判定：抛错、或成功但没有 sources。`WEB_ABORTED` 直接向上抛，不换后端。
- 全部失败才返回最后一个错误；如果有后端成功但确实没结果，返回那个空结果。

## 挂载

插件自带 `cordis.patch.yml`（作为 bundle patch），会：

1. 禁用 `web-search-deepseek`（单模型 provider）
2. 把 `web.searchProvider` 设为 `deepseek-failover`（同时显式保留 `fetchProvider: http`）
3. 插入 `web-search-failover` 行，默认后端为 `claude-haiku-5-5` → `deepseek-v4-flash`

在 profile 的 `package.json` 里加依赖并挂到 bundles：

```jsonc
"dependencies": {
  "dsh-web-search-failover": "github:xingzoudefengye/dsh-web-search-failover"
},
"dsh": { "profile": { "bundles": [ "...", "dsh-web-search-failover" ] } }
```

然后 `pnpm install` 并重启 DSH。

## 配置

```yaml
- id: web-search-failover
  config:
    providerId: deepseek-failover
    backends:
      - { model: claude-haiku-5-5, baseURL: http://43.133.21.227:3000/v1, apiKeyEnv: NEWAPI_API_KEY }
      - { model: deepseek-v4-flash, baseURL: http://43.133.21.227:3000/v1, apiKeyEnv: NEWAPI_API_KEY }
```

## 升级注意

插件复用 `@deepseek-ai/dsh-web-search-deepseek` 的 `DeepSeekSearchProvider`。该类构造签名是公开导出的一部分，但 harness 大版本升级时仍应跑一次真实搜索确认。
