# dsh-web-search-failover

DeepSeek Harness 的搜索故障转移插件：按顺序尝试多个搜索后端，前一个失败（HTTP 错误、没有 `web_search_tool_result` 结果块、或返回空结果）时自动落到下一个。

> **English.** A failover web-search provider for DeepSeek Harness. The harness resolves exactly one search provider per `ctx.web` seam and a provider carries a single `model`, so one upstream error kills the whole search. This bundle registers a `deepseek-failover` provider that walks an ordered list of backends — same request, next backend on any failure (throw, abort excepted, or an empty result) — and only fails when every backend did. The stock `web-search-deepseek` row is disabled by the bundle's own patch, so no manual profile editing is needed. Node ≥ 22, harness ≥ 0.2.1, MIT.

## 为什么需要它

Harness 的 `ctx.web` 每次只解析一个 search provider，provider 也只有单个 `model` 字段，没有失败重试链；`web-search-deepseek` 一旦上游出错，整次搜索就失败。new-api 的自动换渠道只在“同一个模型名有多个渠道”时生效，所以要么在网关造一个别名，要么在 harness 侧做转移。本插件选后者：网关保持官方模型名。

## 兼容性

| 平台 | 支持 | 说明 |
|---|---|---|
| Windows 10/11（PowerShell 7 或 5.1） | ✅ | `dsh plugin` 本身跨平台；本文所有命令在 PowerShell 里原样可跑 |
| macOS（zsh / bash） | ✅ | 原生路径 |
| Linux | ✅ | 原生路径 |

前置条件：

- **DSH ≥ 0.2.1** — 插件复用 `@deepseek-ai/dsh-web-search-deepseek` 导出的 `DeepSeekSearchProvider`，0.2.0 没有这个接口
- **Node ≥ 22**，且 **`pnpm` 在 `PATH` 上**（`dsh plugin` 内部调 pnpm）
- 能访问 `https://codeload.github.com`（public 仓库，不需要 token）
- 一个 OpenAI/Anthropic 兼容的搜索网关，以及它的 API key

## 安装

一条命令（自动写依赖、写 `dsh.profile.bundles`、并跑 `pnpm install`）：

```bash
dsh plugin --profile web add github:xingzoudefengye/dsh-web-search-failover
```

```powershell
# Windows 上完全一样
dsh plugin --profile web add github:xingzoudefengye/dsh-web-search-failover
```

然后**重启 DSH**（关掉 `dsh web` 的终端再重新起）。插件是在 host 启动时 import 的，不重启不会生效 —— 详见排错第 1 条。

Desktop 版 profile 名是 `desktop`，需要先**完全退出应用**再加：

```bash
dsh plugin --profile desktop add github:xingzoudefengye/dsh-web-search-failover
```

插件没有 `prepare` 脚本、没有构建步骤，纯 JS，不会触发 pnpm 的 `allowBuilds` 拦截。

### 凭据

插件的 `apiKeyEnv` 指向一个**凭据引用名**，不是明文。把网关令牌写进 harness 的凭据文件：

- macOS / Linux：`~/.dsh/.credentials.yaml`
- Windows：`%USERPROFILE%\.dsh\.credentials.yaml`

```yaml
refs:
  NEWAPI_API_KEY: sk-...
```

这个文件由 harness 的 credentials 插件注入，**不需要写系统环境变量**。如果你更习惯环境变量，把 `apiKeyEnv` 改成对应的变量名即可。

### 不想用 CLI 时

手工改 profile 的 `package.json` 效果一样：

```jsonc
"dependencies": {
  "dsh-web-search-failover": "github:xingzoudefengye/dsh-web-search-failover"
},
"dsh": { "profile": { "bundles": [ "...", "dsh-web-search-failover" ] } }
```

再在 profile 目录（如 `~/.dsh/profiles/web`，Windows 是 `%USERPROFILE%\.dsh\profiles\web`）跑 `pnpm install`，重启 DSH。

## 验证

```bash
dsh --profile web --dump-config | grep -A3 "searchProvider"
```

```powershell
dsh --profile web --dump-config | Select-String -Pattern "searchProvider" -Context 0,3
```

应看到 `searchProvider: deepseek-failover`。再做一次真实搜索，网关日志里会出现主后端的模型名；只有主后端失败时才会多一条备用后端。

**关于默认网关地址**：插件自带的 `cordis.patch.yml` 里 `baseURL` 写的是一个示例网关（`http://43.133.21.227:3000/v1`）。用别人的地址跑不通，**请改成你自己的网关**，见下一节。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `id: web-search-failover` 这一行的 `config`（插件自带的默认顺序是 `deepseek-v4-flash` → `claude-haiku-5-5`，不覆盖就按这个走）：

```yaml
- id: web-search-failover
  config:
    providerId: deepseek-failover   # ctx.web 选中的 provider 名，一般不用改
    backends:
      - { model: deepseek-v4-flash,  baseURL: https://your-gateway/v1, apiKeyEnv: NEWAPI_API_KEY }
      - { model: claude-haiku-5-5,   baseURL: https://your-gateway/v1, apiKeyEnv: NEWAPI_API_KEY }
```

| 键 | 默认 | 作用 |
|---|---|---|
| `providerId` | `deepseek-failover` | 注册给 `ctx.web` 的 provider 名；bundle patch 里 `web.searchProvider` 必须与它一致 |
| `backends` | — | **有序**列表，第 0 个优先，其后都是备胎；每项 `model` / `baseURL` / `apiKeyEnv` 各自独立 |
| `apiKeyEnv` / `baseURL` / `apiKey` / `apiVersion` / `maxTokens` / `maxUses` | 见 `lib/index.js` 的 `Config` | 旧式单后端字段；用 `backends` 时不需要，插件按 backend 逐个构造 provider |

失败判定：抛错、或者成功但没有 sources。`WEB_ABORTED`（用户取消）直接向上抛，不换后端 —— 取消不该触发备用后端。全部失败才返回最后一个错误；如果所有后端都成功但确实没结果，返回那个空结果。

## 卸载

```bash
dsh plugin --profile web remove dsh-web-search-failover
```

然后重启 DSH。bundle 的 patch 随之失效，harness 原有的 `web-search-deepseek` 行会恢复；如果你之前手工在 profile patch 里删过它，需要自己加回来。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `dsh plugin add` 成功，但搜索行为没变 | 插件在 host 进程启动时 import，进程里的模块不会热替换 | 重启 DSH（关掉 `dsh web` 再起） |
| 改了插件源码（哪怕是 `lib/index.js`）也不生效 | Node 的 ESM 缓存：已 import 的模块不会重新执行 | 同上，重启 host；GitHub 安装还需先 `dsh plugin add` 重装以拉新代码 |
| `dsh plugin add` 卡住或报网络错误 | 拉的是 `codeload.github.com` 的 tarball，公司网络/代理常拦 | 走代理，或把仓库整目录拷过去，依赖改成 `file:` 路径后 `pnpm install`（插件无外部 npm 依赖，离线可装） |
| 报 `WEB_PROVIDER_UNAVAILABLE` | 所有 backends 都 `available() === false`，通常是 `apiKeyEnv` 指向的引用没有值 | 检查 `.credentials.yaml` 的 `refs:` 里有该键，且键名与 `apiKeyEnv` 完全一致 |
| 搜索一直是备用后端的模型 | 主后端失败但未报错（返回空结果也会触发回落） | 看网关日志确认主后端返回码；密钥额度、模型名拼写是最常见原因 |
| 配置树里出现同一个 row id 冲突（`web-search-deepseek` 被两处同时声明） | profile patch 里手工加过 `id: web-search-deepseek` 的行，与 bundle patch 打架 | 删掉 profile 里那一行，插件自带的 patch 已负责禁用它 |

## 同步到另一台机器

逻辑全在插件里，换机器不需要搬配置，但要满足四件事：

1. **装插件**：跑上面那条 `dsh plugin add`。版本自动跟 `master` 最新提交，两台机器不必同 commit，但 harness 版本要一致（都 ≥ 0.2.1）。
2. **凭据**：`.credentials.yaml` 的 `refs:` 里要有 `NEWAPI_API_KEY`。
3. **清掉旧的 provider 行**：profile patch 里若还有 `- id: web-search-deepseek`，删掉。
4. **网关可达**：`baseURL` 换成本机可访问的地址。

## 开发

本仓库是纯 JS、无构建步骤。仓库里没有 `node_modules`，直接 `npm test` 会因为找不到 `@deepseek-ai/*` 的 peer 依赖而失败 —— 先把本机已安装的 harness 包链进来：

```bash
node scripts/dev-link.mjs            # 探测 dsh 的安装位置，链入 schemastery / dsh-web / dsh-web-search-deepseek 等
npm test                             # node --test
```

`dev-link` 依次探测：`dsh` 可执行文件所在的 npm 目录、`$DSH_HOME/profiles/<profile>`、`$DSH_HOME/profiles`、`$DSH_HOME`，也可以用第一个参数或 `DSH_PACKAGE_DIR` 直接指定 `@deepseek-ai/dsh-*` 所在目录。Windows 上用 junction，不需要管理员权限。

改完代码在本地验证，再装到 profile：`dsh plugin --profile web add <本仓库绝对路径>` 走 `link:` 依赖，配合 `dev-link` 即可改完重启 host 就看到效果。

## 相关插件

同作者、同一套安装方式（`dsh plugin add github:xingzoudefengye/<repo>`）：

- [dsh-browser](https://github.com/xingzoudefengye/dsh-browser) — 给 agent 一个可驱动的真实浏览器，侧栏并排显示
- [dsh-compaction-local-handoff](https://github.com/xingzoudefengye/dsh-compaction-local-handoff) — 无模型的本地交接式压缩
- [dsh-project-memory](https://github.com/xingzoudefengye/dsh-project-memory) — 有界、可提交进 git 的项目记忆
- [dsh-resume-budget](https://github.com/xingzoudefengye/dsh-resume-budget) — 会话恢复时的输入预算控制
- [dsh-session-recall](https://github.com/xingzoudefengye/dsh-session-recall) — 无模型、有界的会话史书

## 许可

MIT © xingzoudefengye，见 [LICENSE](LICENSE)。
