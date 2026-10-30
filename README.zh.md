# dsh-git-commit

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=blue)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

给 **DeepSeek Harness** 用的一键分组提交插件。

输入框工具行里的 **提交 / Commit** 按钮会探测仓库、按 Angular 的 type 与 scope
把工作区改动分组，用**当前会话的模型**一次生成每组的 commit message，弹出可编辑的
确认弹窗，最后由插件自己执行 git。**不发聊天消息，不创建 Agent turn。**

```
点击 → git status → type/scope 分组 → 一次模型调用 → 确认弹窗 → git add/commit
```

## 为什么做这个

- **提交链路里没有 Agent。** 按钮调用的是 Host 命令，不是 `agent.followup()`。
  对话里不会多出消息，不会跑工具，模型传输失败也不会让一次提交卡在聊天里。
- **message 一定是有语义的。** 每组都由模型命名；不合规的先做规范化，再走一轮
  定向修复，仍然不合规就把该组留空、禁止提交，而不是悄悄退回通用文案。
- **规则写在代码里。** `@commitlint/config-angular` 由 Host 强制执行，而不是靠
  提示词自觉：一条 commit 只有一种 type、header ≤72、subject ≤50、逐个路径 add、
  不用 `--amend/--force/--no-verify`、跳过敏感文件、暂存区非空不混入。

## 特性

- 按 Angular `type` + `scope` 分组，一组一条 commit。
- 一次模型调用命名全部分组；diff 有预算，不带工具，不产生聊天记录。
- 校验 + 规范化 + 一轮定向修复（只重写不合规的组）。
- 可编辑的确认弹窗，每组带路径和文件数。
- 暂存区非空时拒绝提交，并可以精确释放这些路径（内容留在工作区）。
- 某组提交失败时把它自己的暂存移出，失败一次不会卡死后续尝试。
- 跳过 `.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.keystore`、`*.jks`、
  `id_rsa*`（`.env.example` / `.sample` / `.template` 允许）。
- 使用主题 token 配色，弹窗支持键盘操作与读屏。
- 24 个测试，包含真实临时 git 仓库与 stub LLM。

## 环境要求

- 装有标准 Host 服务的 DeepSeek Harness（`commands`、`llm`、
  `agentDefaultModel` 与客户端 slots）。桌面版/网页版的默认 profile 都有。
- `PATH` 里有 `git`。插件也会探测 `/usr/bin/git`、`/opt/homebrew/bin/git`、
  `/usr/local/bin/git`，所以从 Finder 启动的 App 也能工作。
- 可用的模型路由；把 `useModel` 设为 `false` 可以不开模型、全部手写 message。

## 安装

```bash
# npm
plugin_manager install_bundle  target: "@eternalheart/dsh-git-commit"

# GitHub（SSH 或 HTTPS）
plugin_manager install_bundle  target: "github:wh131462/dsh-git-commit"

# 本地压缩包
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-2.0.0.tgz"
```

也可以在网页侧边栏 **Plugins → Add plugin** 里粘贴同样的 spec。安装作用于当前
profile，也就是该 profile 下的所有会话。

## 使用

1. 点击输入框工具行的 **提交 / Commit**。
2. Host 分析仓库（`git status --porcelain -z -uall`）、分组、用模型命名，然后打开
   确认弹窗。
3. 逐组检查 message：每组是一个可编辑的文本框，下面是路径和文件数；底部的警告会
   列出被跳过的敏感文件、已存在的暂存内容，以及还缺 message 的组。
4. 点 **确认提交**。每组执行 `git add -- <paths>` + `git commit -F <tmpfile>`，
   弹窗随后显示逐组结果，失败时提供 **重新分析**。

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

想按模块而不是按 type 分组时，把 `maxGroups` 调大（例如 `20`）即可保留 scope
粒度。

## 工作原理

1. **探测。** `git status --porcelain -z --untracked-files=all`，再读分支、`HEAD`、
   已暂存路径和新文件样本；敏感路径直接剔除。
2. **分组。** 每个路径得到 type（`ci` / `docs` / `test` / `build` / `feat` /
   `refactor`）和 scope（首段目录，`apps/`、`packages/`、`backend/`、`services/`、
   `libs/`、`modules/`、`crates/`、`src/` 取前两段），再按 `type + scope` 分桶；
   超过 `maxGroups` 时整类合并。
3. **命名。** 在当前会话的模型路由上调用一次 `ctx.llm.stream()`，返回
   `{"messages":[...]}`；大小写、空格、结尾标点先规范化，仍不合规的走一轮定向修复。
4. **确认。** 弹窗列出每组可编辑的 message、路径和警告；确认之前不写任何东西。
5. **提交。** 逐组检查暂存区、`git add -- <paths>`、`git commit -F`；失败时回滚该组
   自己的暂存。最后报告已提交与仍未提交的内容。

## 安全约束

- 一条 commit 只有一种 Angular `type`；`chore` 和未知 type 会被拒绝。
- header ≤ 72 字符、type/scope 小写、subject ≤ 50 字符、结尾不带标点、不以大写字母
  开头、带 `!` 时必须写 `BREAKING CHANGE:`。
- 路径逐个传给 `git add --`；从不使用 `-A`、`.`、`-a`、`--amend`、`--force`、
  `--no-verify`。
- 暂存区非空时中止本次提交；弹窗可以精确释放列出的路径（内容仍在工作区）。
- 敏感文件跳过并报告。
- 失败的组会被移出暂存区，下一次点击从干净状态开始。

## 开发

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
npm test          # node --test，无第三方依赖
```

```
index.js          Host：探测、分组、模型调用、校验、提交
client.js         Client：按钮与确认弹窗
cordis.patch.yml  这个 bundle 插入的 Loader 行
locale/           插件元数据（en、zh）
test/             使用真实临时 git 仓库的 Host 测试
```

插件没有运行时依赖：Host 只用 Node 内置模块，Client 的 React 来自 Harness 的模块表。

## 许可证

[MIT](LICENSE) © 2026 EternalHeart
