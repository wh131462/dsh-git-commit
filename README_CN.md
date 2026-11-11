# DSH Git Commit [![版本](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=a1b858&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![下载量](https://img.shields.io/npm/dm/@eternalheart/dsh-git-commit?color=50a36f&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![license](https://img.shields.io/badge/license-MIT-1e8a7a)](LICENSE) [![github](https://img.shields.io/github/stars/wh131462/dsh-git-commit?style=social)](https://github.com/wh131462/dsh-git-commit)

[English](./README.md) · **中文**

**DSH Git Commit** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件，把输入框变成一键分组提交：自动识别 Git 或 SVN，由**当前会话的模型**决定这次改动应当分几组、哪些文件归为一组，并为每组写一条 Angular 规范的 commit message；确认后由插件自己执行对应 VCS —— 不发聊天消息、不创建 Agent turn、不跑工具。

## 界面

```
点击 → 弹窗立即打开 → git/svn status → 规则预览分组
     → 一次模型调用（模型决定最终分组与 message，弹窗内显示进度）
     → 逐条确认 → add/commit
```

Git 仓库与 SVN 工作副本走同一套流程；`vcs: auto` 自动选择，`vcs: git` / `vcs: svn` 可以固定。

```text
┌ 确认提交 ───────────────────────────────────────────────── × ┐
│ 5 组，79 个文件   main   GIT                                  │
│ ⟳ 正在用 deepseek-official/deepseek-flash 规划分组…           │
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

- **一眼看出正在进行**：点击后弹窗立刻打开，先显示“正在读取工作区”和规则预览分组，随后显示“正在用某模型规划分组”，提交时显示“提交中”。关闭弹窗会中止这次模型调用。
- **Git 与 SVN 都支持**：两者同时存在时（如 git-svn 检出）`auto` 优先 Git，否则识别 SVN 工作副本。Git 按显式路径暂存；SVN 先用 `svn add` 调度新文件，再按显式路径提交，每组一个 revision。
- **分组和 message 都由模型决定**：模型看到编号后的文件清单（含状态、路径、类型提示和预算内的 diff），自己判断分几组、哪些文件一组，并给每组命名；没有组数上限，模型分几组就是几组。分组由 Host 校验覆盖性：模型漏掉的文件会按规则补成一组，重复或越界编号会被忽略，不会丢路径。
- **message 一定是有语义的**：每组都由模型命名；「修改了 5 个文件」「更新文件」这类只报数量或范围的 subject 直接判不合规，先规范化，再走定向修复。模型漏掉的、被 Host 拆出的组也会带着文件与 diff 重新交给模型命名；仍然不合规的组留空并禁止提交，规则兜底只写具体文件或所在目录，不写文件个数，并在弹窗里标出仍需改写的组。
- **提交链路里没有 Agent，也没有命令**：按钮直接调用插件自己的 Host JSON 通道，不写 `command/run` 节点、不追加聊天消息、不跑工具；模型传输失败也不会让一次提交卡在对话里。
- **规则写在代码里**：`@commitlint/config-angular` 由 Host 强制执行 —— 一条 commit 只有一种 type、header ≤72、subject ≤50、逐个路径 add、不用 `--amend` / `--force` / `--no-verify`。
- **可编辑的确认弹窗**：确认前可以逐条改写 message，也可以直接调整分组 —— 点选文件后移到别的组或新建分组、把文件拖到目标分组、或把整组 ↑ 合并到上一组；改过的分组会标「分组已调整」。路径、文件数、被跳过的敏感文件、模型说明都在弹窗里；提交前一次性校验全部 message，不会“提交了一半才发现第 3 组不合规”。
- **暂存区安全（Git）**：已存在的暂存内容不会被混入 —— 弹窗会列出这些精确路径，并可以释放它们（内容留在工作区）。失败的组会把自己的暂存移出，下次点击从干净状态开始。
- **工作区变化会被拦截**：确认时 Host 会重新分析，要求你确认的分组恰好覆盖当前全部改动路径（不重、不漏）；对不上就要求重新分析，而不是用旧 message 提交另一批文件。
- **冲突感知（SVN）**：存在未解决冲突时，分析阶段就会中止，什么都不写；插件从不执行 `svn update`，合入与否由你决定。提交失败时只撤销本次自己做的 `svn add`，文件内容始终留在磁盘上。
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

- DeepSeek Harness，且具备标准 Host 服务（`webServer`、`connection`、`sessions`、`workingDirectory`、`llm`、`agentDefaultModel`）与客户端 slots。
- `PATH` 里有 `git` 和/或 `svn`；插件也会探测 `/usr/bin/git`、`/opt/homebrew/bin/git`、`/usr/local/bin/git`、`/usr/bin/svn`、`/opt/homebrew/bin/svn`、`/usr/local/bin/svn`，所以从 Finder 启动的 App 也能用。
- 可用的模型路由；把 `useModel` 设为 `false` 可以不开模型、全部手写 message。
- 从 GitHub 安装时，本机还需要 Node 20+ 与 pnpm：安装阶段会执行 `prepare` 构建 `lib/`。npm tarball 已预构建，不需要工具链。

## 使用

1. 点击输入框工具行的 **提交 / Commit**。弹窗立即打开，先显示“正在读取工作区”。
2. Host 读取 `git status` / `svn status --xml`，按规则先给出预览分组；随后把编号后的文件清单交给当前会话的模型，由它决定最终分几组、哪些文件一组，并为每组写 message。模型较慢时，进度条和按钮都保持“生成中”的状态。
3. 逐组检查 —— 每组是一个可编辑的文本框和文件 chips。分组不合理时可以：点选文件后选目标分组（或「新建分组」）再点「移动」，也可以直接把文件拖到别的分组，或用 ↑ 把整组合并到上一组。移动/合并后 message 可能需要跟着改，改过的分组会标「分组已调整」。
4. 点 **确认提交**。Host 会重新分析工作区，确认（调整后的）分组覆盖的路径与当前改动完全一致后，一次性校验全部 message，再逐组执行提交。
5. 结果显示在弹窗里；有失败时可以直接 **重新分析**。关闭弹窗会中止还在进行的模型调用。

弹窗未在提交中时，`Esc`、点击遮罩、右上角 × 都可以关闭。

### 阶段与失败

| 阶段 | 界面 | 失败时 |
| --- | --- | --- |
| `analyzing` | 骨架屏 + “正在读取工作区” | 弹窗关闭，用一次性提示说明原因（干净、不是仓库等） |
| `naming` | 规则预览已出现 + “正在用模型规划分组” | 进入编辑态，显示原因，可以重试生成或手写 |
| `edit` | 逐条可编辑 | 每组的校验原因显示在对应输入框下 |
| `committing` | 全部禁用 + “提交中” | 显示逐组结果；`stale` / 暂存冲突会提示重新分析 |
| `done` | 结果文本 | 失败时额外提供“重新分析” |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件行：

```yaml
- id: smart-commit
  name: '@eternalheart/dsh-git-commit'
  config:
    vcs: auto          # auto | git | svn
    gitPath: ''
    svnPath: ''
    timeoutMs: 20000
    useModel: true
    modelTimeoutMs: 60000
    maxInputChars: 32000
    maxTokens: 2000
    repairRounds: 1
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `vcs` | `auto` | `auto` 优先 Git、找不到再试 SVN；`git` / `svn` 固定适配器 |
| `gitPath` | 自动 | 指定 git 可执行文件；留空时探测 `/usr/bin/git`、Homebrew、`/usr/local/bin/git` |
| `svnPath` | 自动 | 指定 svn 可执行文件；留空时探测 `/usr/bin/svn`、Homebrew、`/usr/local/bin/svn` |
| `timeoutMs` | `20000` | 单次 git / svn 调用的超时 |
| `useModel` | `true` | `false` 时不调用模型，所有 message 需要手写 |
| `modelTimeoutMs` | `60000` | 一次模型规划调用的超时 |
| `maxInputChars` | `32000` | 一次规划请求的字符预算：文件编号清单 + diff |
| `maxTokens` | `2000` | 总结的输出上限 |
| `repairRounds` | `1` | message 不合规或只有规则占位时，再请模型命名的轮数（0–3） |

组数完全由模型判断：没有上限，也不会再按 type 合并，模型分几组就提交几次。改动很多时按三级降级：先按文件编号 → 放不下就按规则单元（type+scope 桶）编号 → 连单元都放不下才退回纯规则分组；后两种也可以在弹窗里手动调整分组。

## 工作原理

### 1. 通道

按钮通过 `POST /dsh-git-commit/<endpoint>` 直接调用 Host，请求和响应都是 JSON。路由注册在 Harness 的 `webServer` 上，并复用 `connection.admit()`：同源、通过 Host/Origin 检查、携带浏览器会话凭据、只允许 owner Peer。Host 端不保存“待提交计划”，也没有 TTL；`analyze` / `name` / `commit` 都是无状态的。没有可提交内容不是错误：工作区干净（或只剩敏感文件）时，`analyze` / `name` 返回 `ok: true` 的 `{api, empty: true, reason: "clean" | "sensitive", message}`，Client 只提示一次这句话并关掉弹窗。

### 2. 探测

Git：`git status --porcelain -z --untracked-files=all`，再读分支、`HEAD`、已暂存路径和新文件样本。SVN：`svn info --xml` 定位工作副本根，`svn status --xml` 读取改动，未版本化目录会展开成具体文件。两种模式都会剔除敏感路径。

### 3. 预览分组（规则）

每个路径得到 type（`ci` / `docs` / `test` / `build` / `feat` / `refactor`）和 scope（首段目录；`apps/`、`packages/`、`backend/`、`services/`、`libs/`、`modules/`、`crates/`、`src/` 取前两段），再按 `type + scope` 分桶。这份分组只用于弹窗立刻出内容、以及在模型不可用时兜底；它同时决定了哪些路径会进入模型提示。

### 4. 分组与命名（模型）

改动过大、路径编号放不进预算时，改为给模型一份**规则单元**清单（每个单元是同一 type+scope 的一批文件，最多列 4 个样例路径），让模型决定把哪些单元合并成一次提交；单元本身不再拆。这样几百个文件通常只需要几十行提示，仍然由模型决定组数，而不是退回规则。

把待提交路径按固定顺序编号（附状态码、`docs`/`test`/`build`/`ci` 标记和预算内的 diff）发给当前会话的模型，一次 `ctx.llm.stream()` 调用返回：

```json
{"groups":[{"paths":[1,3],"type":"feat","scope":"auth","message":"feat(auth): 新增登录接口"}]}
```

Host 不接受模型说了算的部分：每个编号必须恰好被用到一次，越界和重复编号被忽略，漏掉的文件按规则补组；docs / test / CI / build 这类由路径决定的 type 会被锁死，源码组的 type 才允许模型判断。message 先规范化再校验，不合规的组带着失败原因和 diff 走一轮定向修复；被规则补齐、拆分的组也会带着文件和 diff 再请模型命名，避免留下计数式文案；仍然拿不到模型文案的组留空并禁止提交，路径兜底也不会写成文件个数。分组在弹窗打开之后进行，关闭弹窗会通过请求的 abort 信号中止模型流。

### 5. 提交

`commit` 会重新分析工作区，核对确认的分组是否恰好覆盖当前全部改动路径（不重、不漏、无空组）；对不上就返回 `stale`，不写任何东西。全部 message 先统一校验，再按确认的分组逐组执行。Git：检查暂存区、`git add -- <paths>`、`git commit -F`，失败时回滚该组自己的暂存。SVN：先对本组未版本化文件执行 `svn add --parents --depth empty`，再对显式路径（含新增的父目录）执行 `svn commit -F`；失败时只撤销本次的 add。最后报告已提交与仍未提交的内容。

每次 git 调用碰到 `index.lock` 时会先确认是否还有进程持有它：git 崩溃、被超时杀掉后留下的残留锁会被清理并重试一次，提交照常继续；仍被其他 git 进程（终端里的 commit、IDE 等）持有时不删除，直接说明持有它的 PID，等它结束后再试。

## 安全约束

- 一条 commit 只有一种 Angular `type`；`chore` 和未知 type 会被拒绝。
- header ≤ 72 字符、type/scope 小写、subject ≤ 50 字符、结尾不带标点、不以大写字母开头、带 `!` 时必须写 `BREAKING CHANGE:`。
- subject 必须写出具体改动；只报数量的「修改了 N 个文件」「更新 3 个文档」「更新文件」（以及英文的「update 3 files」「update files」）这类空话会被拒绝。
- 路径逐个传给 `git add --`；从不使用 `-A`、`.`、`-a`、`--amend`、`--force`、`--no-verify`。
- 暂存区非空时中止本次提交；弹窗可以精确释放列出的路径（内容仍在工作区）。
- 敏感文件跳过并报告；确认期间工作区发生变化时拒绝提交。
- 失败的 Git 组会被移出暂存区，下一次点击从干净状态开始。
- `index.lock` 只在没有任何进程持有它时才会被清理；有活进程持有时绝不删除，只报告 PID 与等待建议。
- SVN 有冲突时在写入前中止；缺失文件跳过并报告。插件从不执行 `svn update`、`svn resolve`、`--force`、`--amend`、`--no-verify`。
- SVN 提交失败时只撤销本次自己调度的路径，文件内容始终保留在磁盘上。
- HTTP 通道只接受同源、已认证、owner Peer 的 JSON 请求；不新增未认证端口，也不把 token 放进 URL。

## SVN 说明

- **没有暂存区**：“先取消暂存”只对 Git 生效；SVN 提交始终按显式路径进行。
- **一个文件只属于一组**：无法把同一文件拆到多个组，这与插件在 Git 下不做 hunk 级暂存的行为一致。
- **新目录**会展开为具体文件（上限 2000 个）；超出的目录会跳过并提示，而不是整个加入。新增父目录用 `--depth empty` 调度，同级的 `.env` 之类不会被顺带加入。
- **过期提交**会被服务端拒绝并如实报告；需要合并时请自行执行 `svn update`。
- **非 ASCII 路径与日志**：所有 svn 命令都在 UTF-8 locale 下运行（优先 `C.UTF-8`，其次 `en_US.UTF-8`），中文或带重音符号的路径可以正常 add、提交，读回的日志也不会变成 `{U+...}` 转义；svn 自身的消息仍是英文，解析不受影响。
- **凭据**完全不碰：所有命令都带 `--non-interactive`，需要认证时请先运行 `svn auth`。

## 开发

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
pnpm install       # 安装 devDependencies，并跑一次 prepare 构建
pnpm run typecheck # tsc --noEmit
pnpm run lint      # Biome
pnpm test          # node:test + tsx，真实临时 git / svn 仓库
pnpm run build     # 生成 lib/index.js 与 lib/client.js
```

```text
src/host/          Host ESM：JSON 通道、探测分发、分组、模型调用、校验、提交
src/host/svn.ts    SVN 适配器：info/status 探测、add、commit、revert、diff
src/client/        Client：store、controller、i18n、React 确认弹窗
src/shared/        API v5 线协议，Host 与 Client 共用的类型
lib/               构建产物（npm 包内容），Host ESM + Client ModuleLoader CJS
cordis.patch.yml  这个 bundle 插入的 Loader 行
locale/           插件元数据（en、zh）
test/             Host、路由与 Client store / UI 测试
```

源码是 TypeScript：Host 用 `tsc --noEmit` 做类型检查，构建用 `dsh-build-tools` + `esbuild` 同时产出 Host ESM 和 Client 的 `window.__ModuleLoader__` CJS 包装；`react` / `react/jsx-runtime` / `@deepseek-ai/*` 在 Client 侧保持 external。**运行时依赖仍然是零**：所有工具都在 devDependencies 里，npm 包只带 `lib/`。

测试会创建真实临时仓库并驱动一个 stub LLM，覆盖分组、不丢路径、不设组数上限、校验、修复轮、留空阻断、暂存释放、失败回滚、残留 `index.lock` 恢复与活锁保护、工作区变化拦截，以及通道的鉴权、方法和 JSON 校验；安装 `svn`/`svnadmin` 时还会跑真实工作副本、revision、敏感文件跳过、add 回滚，以及在插件 UTF-8 locale 下的非 ASCII 路径提交。Client 的分组操作已经抽成纯 store，直接由 Node 测试覆盖。

## 从 2.1.0 升级

2.2.0 把源码迁到 TypeScript，并改为双端构建后发布：npm 包里的 `lib/index.js`、`lib/client.js` 是预构建产物，安装方式不变。从 GitHub 安装的 profile 会在安装时执行 `prepare`，需要本机有 Node 20+ 和 pnpm；配置项、HTTP 通道和 API v5 都没有变化。升级后重启 DSH 即可。

## 从 2.0.3 升级

2.1.0 增加 `index.lock` 处理：git 调用失败时先探测锁是否仍有进程持有，崩溃残留的锁自动清理并重试一次；被其他 git 进程持有时不删除，逐字说明 PID，避免误删造成索引损坏。配置项保持不变；升级后重启 DSH 即可。

## 从 2.0.2 升级

2.0.3 优化了确认弹窗：选中文件的操作移到 footer 的「移动到」主题菜单里，不再使用原生 select；选中 chip 只改变配色，不推动布局；分组全选改为固定尺寸勾选框。配置项保持不变；升级后重启 DSH 即可。

## 参与贡献

欢迎提交 [Issues](https://github.com/wh131462/dsh-git-commit/issues) 和 [Pull Requests](https://github.com/wh131462/dsh-git-commit/pulls) 一起完善这个项目。

## 许可证

[MIT](LICENSE) © 2026 EternalHeart

## 致谢

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 提供的插件运行时、slot 系统与客户端 UI。
