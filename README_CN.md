# DSH Git Commit [![版本](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=a1b858&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![下载量](https://img.shields.io/npm/dm/@eternalheart/dsh-git-commit?color=50a36f&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![license](https://img.shields.io/badge/license-MIT-1e8a7a)](LICENSE) [![github](https://img.shields.io/github/stars/wh131462/dsh-git-commit?style=social)](https://github.com/wh131462/dsh-git-commit)

[English](./README.md) · **中文**

**DSH Git Commit** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件，把输入框变成一键分组提交：按 Angular 的 type 与 scope 把工作区改动分组，用**当前会话的模型**为每组命名，确认后由插件自己执行 git —— 不发聊天消息、不创建 Agent turn、不跑工具。

## 界面

```
点击 → git status → type/scope 分组 → 一次模型调用 → 确认弹窗 → git add/commit
```

```text
┌ 确认提交 ───────────────────────────────────────────────── × ┐
│ 待确认 5 组 / 79 个文件 · main                                │
│ 1  build(backend-coal-mind-agent): 更新镜像权限               │
│    backend/coal-mind-agent/Dockerfile            1 个文件     │
│ 2  docs: 重写智能分组提交说明                                 │
│    AGENTS.md, README.md                          11 个文件    │
│ 3  refactor: 调整工作流调用                                   │
│    apps/web/..., backend/...                     53 个文件    │
│ ⚠ 暂存区已有 1 个文件，勾选后可先取消暂存再提交               │
│                                     [取消]  [确认提交]        │
└───────────────────────────────────────────────────────────────┘
```

## 特性

- **message 一定是有语义的**：每组都由模型命名；不合规的先规范化，再走一轮定向修复；仍然不合规就留空并禁止提交，不会悄悄退回通用文案。
- **提交链路里没有 Agent**：按钮调用 Host 命令，而不是 `agent.followup()`。对话里不会多出消息，不跑工具，模型传输失败也不会让一次提交卡在聊天里。
- **规则写在代码里**：`@commitlint/config-angular` 由 Host 强制执行 —— 一条 commit 只有一种 type、header ≤72、subject ≤50、逐个路径 add、不用 `--amend` / `--force` / `--no-verify`。
- **可编辑的确认弹窗**：确认前可以逐条改写 message，路径、文件数、被跳过的敏感文件、模型说明都在弹窗里。
- **暂存区安全**：已存在的暂存内容不会被混入 —— 弹窗会列出这些精确路径，并可以释放它们（内容留在工作区）。失败的组会把自己的暂存移出，下次点击从干净状态开始。
- **跳过敏感文件**：`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.keystore`、`*.jks`、`id_rsa*` 会被排除并提示（`.env.example` / `.sample` / `.template` 允许）。
- **中英文与可访问性**：中英双语文案、主题 token 配色、焦点与 `Esc` 处理、`role="dialog"` + `aria-modal`。
- **零运行时依赖**：Host 只用 Node 内置模块，Client 的 React 来自 Harness 的模块表。

## 安装

### DeepSeek Harness

```bash
# 从 npm 安装
plugin_manager install_bundle  target: "@eternalheart/dsh-git-commit"

# 从 GitHub 安装
plugin_manager install_bundle  target: "github:wh131462/dsh-git-commit"

# 从本地压缩包安装
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-<version>.tgz"
```

也可以在网页侧边栏 **Plugins → Add plugin** 里粘贴同样的 spec。插件安装到当前 profile，对该 profile 下的所有会话生效。

### 环境要求

- DeepSeek Harness，且具备标准 Host 服务（`commands`、`llm`、`agentDefaultModel`）与客户端 slots。
- `PATH` 里有 `git`；插件也会探测 `/usr/bin/git`、`/opt/homebrew/bin/git`、`/usr/local/bin/git`，所以从 Finder 启动的 App 也能用。
- 可用的模型路由；把 `useModel` 设为 `false` 可以不开模型、全部手写 message。

## 使用

1. 点击输入框工具行的 **提交 / Commit**。
2. Host 执行 `git status --porcelain -z -uall`、分组、用模型命名，然后打开确认弹窗。
3. 逐组检查 message —— 每组是一个可编辑的文本框，下面是路径和文件数。
4. 点 **确认提交**。每组执行 `git add -- <paths>` + `git commit -F <tmpfile>`，弹窗随后显示逐组结果，失败时提供 **重新分析**。

弹窗未在提交中时，`Esc`、点击遮罩、右上角 × 都可以关闭。

### 命令

按钮背后是 `/smart-commit`，也可以直接输入：

| 命令 | 作用 |
| --- | --- |
| `/smart-commit` | 分析并生成计划（不写任何东西） |
| `/smart-commit commit <base64>` | 用给定 message 提交当前计划 |
| `/smart-commit cancel` | 丢弃待提交的计划 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件行：

```yaml
- id: smart-commit
  name: '@eternalheart/dsh-git-commit'
  config:
    gitPath: ''
    timeoutMs: 20000
    maxGroups: 6
    useModel: true
    modelTimeoutMs: 60000
    maxInputChars: 24000
    maxTokens: 2000
    repairRounds: 1
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `gitPath` | 自动 | 指定 git 可执行文件；留空时探测 `/usr/bin/git`、Homebrew、`/usr/local/bin/git` |
| `timeoutMs` | `20000` | 单次 git 调用的超时 |
| `maxGroups` | `6` | 超过该组数时按 type 合并；不会混 type，也不会丢路径 |
| `useModel` | `true` | `false` 时不调用模型，所有 message 需要手写 |
| `modelTimeoutMs` | `60000` | 一次总结调用的超时 |
| `maxInputChars` | `24000` | 送给模型的 diff 字符预算 |
| `maxTokens` | `2000` | 总结的输出上限 |
| `repairRounds` | `1` | 校验失败后的定向修复轮数（0–3） |

想按模块而不是按 type 分组时，把 `maxGroups` 调大（例如 `20`）即可保留 scope 粒度。

## 工作原理

### 1. 探测

`git status --porcelain -z --untracked-files=all`，再读分支、`HEAD`、已暂存路径和新文件样本；敏感路径直接剔除。

### 2. 分组

每个路径得到 type（`ci` / `docs` / `test` / `build` / `feat` / `refactor`）和 scope（首段目录；`apps/`、`packages/`、`backend/`、`services/`、`libs/`、`modules/`、`crates/`、`src/` 取前两段），再按 `type + scope` 分桶。超过 `maxGroups` 时整类合并，绝不混 type。

### 3. 命名

在当前会话的模型路由上调用一次 `ctx.llm.stream()`，返回 `{"messages":[...]}`。大小写、空格、结尾标点先规范化；不合规的组带着失败原因和 diff 走一轮定向修复。

### 4. 确认

弹窗列出每组可编辑的 message、路径和警告；确认之前不写任何东西。

### 5. 提交

逐组检查暂存区、`git add -- <paths>`、`git commit -F`；失败时回滚该组自己的暂存。最后报告已提交与仍未提交的内容。

## 安全约束

- 一条 commit 只有一种 Angular `type`；`chore` 和未知 type 会被拒绝。
- header ≤ 72 字符、type/scope 小写、subject ≤ 50 字符、结尾不带标点、不以大写字母开头、带 `!` 时必须写 `BREAKING CHANGE:`。
- 路径逐个传给 `git add --`；从不使用 `-A`、`.`、`-a`、`--amend`、`--force`、`--no-verify`。
- 暂存区非空时中止本次提交；弹窗可以精确释放列出的路径（内容仍在工作区）。
- 敏感文件跳过并报告。
- 失败的组会被移出暂存区，下一次点击从干净状态开始。

## 开发

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
npm test          # node --test，无第三方依赖
```

```text
index.js          Host：探测、分组、模型调用、校验、提交
client.js         Client：按钮与确认弹窗
cordis.patch.yml  这个 bundle 插入的 Loader 行
locale/           插件元数据（en、zh）
test/             使用真实临时 git 仓库的 Host 测试
```

插件没有运行时依赖：Host 只用 Node 内置模块，Client 的 React 来自 Harness 的模块表。测试会创建真实临时仓库并驱动一个 stub LLM，覆盖分组、无丢路径的合并、校验、修复轮、留空阻断、暂存释放与失败回滚。

## 参与贡献

欢迎提交 [Issues](https://github.com/wh131462/dsh-git-commit/issues) 和 [Pull Requests](https://github.com/wh131462/dsh-git-commit/pulls) 一起完善这个项目。

## 许可证

[MIT](LICENSE) © 2026 EternalHeart

## 致谢

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 提供的插件运行时、slot 系统与客户端 UI。
