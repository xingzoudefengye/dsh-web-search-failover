# dsh-web-search-failover

DeepSeek Harness 的搜索故障转移插件：按顺序尝试多个搜索后端，当前一个失败（HTTP 错误、没有 `web_search_tool_result` 结果块、或返回空结果）时自动落到下一个。

## 为什么需要它

Harness 的 `ctx.web` 每次只解析一个 search provider，provider 也只有单个 `model` 字段，没有失败重试链；`web-search-deepseek` 一旦上游出错，整次搜索就失败。new-api 的自动换渠道只在“同一个模型名有多个渠道”时生效，所以要么在网关造一个别名，要么在 harness 侧做转移。本插件选后者：网关保持官方模型名。

## 怎么工作

- 注册 search provider `deepseek-failover`，把 `ctx.web` 的 `searchProvider` 指向它。
- 依次调用 `@deepseek-ai/dsh-web-search-deepseek` 的 provider；每个 backend 有独立的 `model` / `baseURL` / `apiKeyEnv`。
- 失败判定：抛错、或成功但没有 sources。`WEB_ABORTED` 直接向上抛，不换后端。
- 全部失败才返回最后一个错误；如果有后端成功但确实没结果，返回那个空结果。

## 安装

一条命令（会自动写依赖、写 `dsh.profile.bundles`、并跑 `pnpm install`）：

```bash
dsh plugin --profile web add github:xingzoudefengye/dsh-web-search-failover
```

然后重启 DSH。插件没有 `prepare` 脚本、没有构建步骤，纯 JS，不会触发 pnpm 的 `allowBuilds` 拦截。

前置条件：

- **DSH ≥ 0.2.1**（插件复用 `@deepseek-ai/dsh-web-search-deepseek` 的 `DeepSeekSearchProvider`，0.2.0 没有这个接口）
- **Node ≥ 22**，`pnpm` 在 `PATH` 上（`dsh plugin` 内部调 pnpm）
- 能访问 `https://codeload.github.com`（public 仓库，不需要 token）

Desktop 版 profile 名是 `desktop`，需要先完全退出应用再加：
`dsh plugin --profile desktop add ...`

### 不想用 CLI 时

手工改 profile 的 `package.json` 效果一样：

```jsonc
"dependencies": {
  "dsh-web-search-failover": "github:xingzoudefengye/dsh-web-search-failover"
},
"dsh": { "profile": { "bundles": [ "...", "dsh-web-search-failover" ] } }
```

再 `pnpm install`（在 profile 目录，如 `~/.dsh/profiles/web`），重启 DSH。

## 同步到另一台机器

逻辑全在插件里，换机器不需要搬配置，但要满足四件事：

1. **装插件**：跑上面那条 `dsh plugin add`。版本会自动跟着 `master` 最新提交，两台机器不需要相同 commit，但 harness 版本要一致（都 ≥ 0.2.1）。
2. **凭据**：`~/.dsh/.credentials.yaml` 的 `refs:` 里要有 `NEWAPI_API_KEY`（值就是网关的 `sk-...` 令牌）：
   ```yaml
   refs:
     NEWAPI_API_KEY: sk-...
   ```
   插件读的是环境变量名 `NEWAPI_API_KEY`，这个文件由 harness 的 credentials 插件注入；**不写系统环境变量也能用**。
3. **清掉旧的 provider 行**：如果那台机器的 profile patch（`~/.dsh/profiles/<name>/cordis.patch.yml`）里有 `- id: web-search-deepseek` 这一行，删掉。插件自带的 bundle patch 已经会禁用它，用户层再加一行同 id 会打架。
4. **网关照旧可达**：`baseURL` 默认写死在插件自带的 patch 里（本仓库用 `http://43.133.21.227:3000/v1`）。换机器后如果网关地址不同，在自己的 profile patch 里覆盖一行 `id: web-search-failover` 的 `config.backends` 即可。

装完重启，在任意一台跑：

```bash
dsh --profile web --dump-config | grep -A3 "searchProvider"
```

应看到 `searchProvider: deepseek-failover`。再做一次真实搜索，网关日志里应出现 `claude-haiku-5-5`（主后端）；只有主后端失败时才会多一条 `deepseek-v4-flash`。

### 公司网络访问不到 GitHub 时

把仓库目录整个拷过去，依赖改成 `file:` 路径：

```jsonc
"dsh-web-search-failover": "file:/path/to/dsh-web-search-failover"
```

再 `pnpm install`。插件没有外部 npm 依赖（全是 peerDependencies），所以离线也能装。

## 插件做了什么

插件自带 `cordis.patch.yml`（作为 bundle patch），会：

1. 禁用 `web-search-deepseek`（单模型 provider）
2. 把 `web.searchProvider` 设为 `deepseek-failover`（同时显式保留 `fetchProvider: http`）
3. 插入 `web-search-failover` 行，默认后端为 `claude-haiku-5-5` → `deepseek-v4-flash`

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
