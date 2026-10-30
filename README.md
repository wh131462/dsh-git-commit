# DSH Git Commit [![npm version](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=a1b858&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![downloads](https://img.shields.io/npm/dm/@eternalheart/dsh-git-commit?color=50a36f&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![license](https://img.shields.io/badge/license-MIT-1e8a7a)](LICENSE) [![github](https://img.shields.io/github/stars/wh131462/dsh-git-commit?style=social)](https://github.com/wh131462/dsh-git-commit)

[中文](./README_CN.md) · **English**

**DSH Git Commit** is a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that turns the composer into a one-click, model-named git commit. It groups the working tree by Angular type and scope, names every group with the session's current model, and runs git itself after you confirm — no chat message, no agent turn, no tool calls.

## Interface

```
click → git status → type/scope buckets → one model call → confirm dialog → git add/commit
```

```text
┌ Confirm commit ─────────────────────────────────────────── × ┐
│ 5 groups / 79 files · main                                    │
│ 1  build(backend-coal-mind-agent): 更新镜像权限               │
│    backend/coal-mind-agent/Dockerfile            1 file       │
│ 2  docs: 重写智能分组提交说明                                 │
│    AGENTS.md, README.md                          11 files     │
│ 3  refactor: 调整工作流调用                                   │
│    apps/web/..., backend/...                     53 files     │
│ ⚠ 1 staged file: release exactly those paths to continue      │
│                                     [Cancel]  [Commit]        │
└───────────────────────────────────────────────────────────────┘
```

## Features

- **Semantic messages, always.** The model names every group. A header that fails the Angular rules is normalized, then retried in one targeted repair round; if it still fails, that group stays blank and the commit is blocked instead of silently falling back to generic text.
- **No agent turn in the commit path.** The button calls a host command, not `agent.followup()`. Nothing is added to the conversation, no tools run, and a model transport failure cannot leave a commit half-explained in chat.
- **The rules live in code.** `@commitlint/config-angular` is enforced by the host: one type per commit, header ≤ 72, subject ≤ 50, explicit paths, no `--amend` / `--force` / `--no-verify`.
- **Editable confirmation dialog.** Review and rewrite every message before anything is written; paths, file counts, skipped sensitive files, and model notes are all visible.
- **Safe staging.** A pre-existing index is never mixed in — the dialog lists those exact paths and can release them while keeping the work. A failed group is moved back out of the index so the next attempt starts clean.
- **Sensitive files skipped.** `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*` are excluded and reported (`.env.example` / `.sample` / `.template` stay allowed).
- **Bilingual and accessible.** Chinese and English UI copy, theme-token styling, focus and `Escape` handling, `role="dialog"` + `aria-modal`.
- **Zero runtime dependencies.** The host half uses Node built-ins; the client half gets React from the Harness module table.

## Installation

### DeepSeek Harness

```bash
# from npm
plugin_manager install_bundle  target: "@eternalheart/dsh-git-commit"

# from GitHub
plugin_manager install_bundle  target: "github:wh131462/dsh-git-commit"

# from a local tarball
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-2.0.0.tgz"
```

Or from the Web sidebar: **Plugins → Add plugin** and paste the same spec. The plugin installs into the current profile and applies to every session in it.

### Requirements

- DeepSeek Harness with the standard host services (`commands`, `llm`, `agentDefaultModel`) and client slots.
- `git` on `PATH`; the plugin also probes `/usr/bin/git`, `/opt/homebrew/bin/git`, and `/usr/local/bin/git`, so a Finder-launched app works.
- A usable model route for semantic messages. Set `useModel: false` to skip the model and write every message by hand.

## Usage

1. Click **提交 / Commit** in the composer tool row.
2. The host runs `git status --porcelain -z -uall`, groups the paths, names each group with the model, and opens the dialog.
3. Review the messages — each is an editable textarea with its paths and file count underneath.
4. Press **确认提交 / Commit**. Every group runs `git add -- <paths>` + `git commit -F <tmpfile>`; the dialog then shows the per-group result, or the failure with **重新分析 / Analyze again**.

`Escape`, the backdrop, and the close button dismiss the dialog while it is not committing.

### Slash command

The button calls `/smart-commit`, which is also available by typing:

| Command | Effect |
| --- | --- |
| `/smart-commit` | Analyze and plan (writes nothing) |
| `/smart-commit commit <base64>` | Commit the plan with the given messages |
| `/smart-commit cancel` | Drop the pending plan |

## Configuration

Override the inserted row in the profile's `cordis.patch.yml`:

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

| Field | Default | Meaning |
| --- | --- | --- |
| `gitPath` | auto | Explicit git binary; empty probes `/usr/bin/git`, Homebrew, `/usr/local/bin/git` |
| `timeoutMs` | `20000` | Deadline for each git invocation |
| `maxGroups` | `6` | Above this, whole types are consolidated; types are never mixed and no path is dropped |
| `useModel` | `true` | `false` skips the model; every message must be written by hand |
| `modelTimeoutMs` | `60000` | Deadline for one summarization call |
| `maxInputChars` | `24000` | Diff characters sent to the model |
| `maxTokens` | `2000` | Output cap for the summarization |
| `repairRounds` | `1` | Targeted repair rounds for headers that failed validation (0–3) |

Raise `maxGroups` (for example to `20`) to keep one commit per module instead of one commit per type.

## How it works

### 1. Probe

`git status --porcelain -z --untracked-files=all`, plus branch, `HEAD`, staged paths, and samples of new files. Sensitive paths are dropped.

### 2. Group

Each path gets a type (`ci` / `docs` / `test` / `build` / `feat` / `refactor`) and a scope (first path segment, or the first two for `apps/`, `packages/`, `backend/`, `services/`, `libs/`, `modules/`, `crates/`, `src/`), then buckets by `type + scope`. Over `maxGroups`, whole types are merged — never different types.

### 3. Name

One `ctx.llm.stream()` call on the session's current route returns `{"messages":[...]}`. Casing, spacing, and trailing punctuation are normalized; invalid headers get one targeted repair round using the failing groups, the exact error, and their diffs.

### 4. Confirm

The dialog lists every group with editable text, paths, and warnings. Nothing is written before you confirm.

### 5. Commit

Group by group: an empty index check, `git add -- <paths>`, `git commit -F`, and a per-group rollback of its own staging on failure. The result reports what committed and what is still dirty.

## Safety rules

- One Angular `type` per commit; `chore` and unknown types are rejected.
- Header ≤ 72 chars, lowercase type/scope, subject ≤ 50 chars, no trailing punctuation, no leading capital, no `!` without a `BREAKING CHANGE:` footer.
- Every path is passed to `git add --` explicitly; `-A`, `.`, `-a`, `--amend`, `--force`, and `--no-verify` are never used.
- A non-empty index aborts the run; the dialog can release exactly the listed paths (the content stays in the working tree).
- Sensitive files are skipped and reported.
- A failed group is moved back out of the index so the next attempt starts clean.

## Development guide

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
npm test          # node --test, no third-party dependencies
```

```text
index.js          host half: probe, grouping, model call, validation, commit
client.js         client half: button and confirmation dialog
cordis.patch.yml  the loader row this bundle inserts
locale/           plugin metadata (en, zh)
test/             host tests with real temporary git repositories
```

The bundle has no runtime dependencies: the host half uses Node built-ins, and the client half gets React from the Harness module table. The tests create real temporary repositories and drive a stub LLM, covering grouping, consolidation without path loss, validation, repair rounds, blocked groups, index release, and failed-commit rollback.

## Contributing

Feel free to submit [Issues](https://github.com/wh131462/dsh-git-commit/issues) and [Pull Requests](https://github.com/wh131462/dsh-git-commit/pulls) to help improve this project.

## License

[MIT](LICENSE) © 2026 EternalHeart

## Acknowledgments

Thanks to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) for the plugin runtime, slot system, and the client UI that this plugin extends.
