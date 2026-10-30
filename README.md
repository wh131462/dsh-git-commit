# DSH Git Commit [![npm version](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=a1b858&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![downloads](https://img.shields.io/npm/dm/@eternalheart/dsh-git-commit?color=50a36f&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![license](https://img.shields.io/badge/license-MIT-1e8a7a)](LICENSE) [![github](https://img.shields.io/github/stars/wh131462/dsh-git-commit?style=social)](https://github.com/wh131462/dsh-git-commit)

[中文](./README_CN.md) · **English**

**DSH Git Commit** is a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that turns the composer into a one-click, model-named commit. It detects Git or SVN, groups the working tree by Angular type and scope, names every group with the session's current model, and runs the VCS itself after you confirm — no chat message, no agent turn, no tool calls.

## Interface

```
click → dialog opens immediately → git/svn status → type/scope buckets
      → one model call (progress inside the dialog) → edit → commit
```

The same flow works in a Git repository and in an SVN working copy; `vcs: auto` picks one, and `vcs: git` / `vcs: svn` pin it.

```text
┌ Confirm commit ─────────────────────────────────────────── × ┐
│ 5 groups / 79 files · main · GIT                              │
│ ⟳ Naming 5 groups with deepseek-official/deepseek-flash…      │
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

- **Visible progress, in the dialog.** Clicking opens the dialog immediately: “Reading the working tree”, then “Naming N groups with <model>”, then “Committing”. Closing the dialog aborts the model call.
- **Git and SVN.** `auto` prefers Git when both exist (a git-svn checkout), otherwise the SVN working copy. Git commits stage explicit paths; SVN commits schedule new files with `svn add` and commit explicit paths, one revision per group.
- **Semantic messages, always.** The model names every group. A header that fails the Angular rules is normalized, then retried in one targeted repair round; if it still fails, that group stays blank and the commit is blocked instead of silently falling back to generic text.
- **No agent turn and no command.** The button calls the plugin's own JSON channel on the host, so no `command/run` node is appended, no chat message is added, no tools run, and a model transport failure cannot leave a commit stuck in the conversation.
- **The rules live in code.** `@commitlint/config-angular` is enforced by the host: one type per commit, header ≤ 72, subject ≤ 50, explicit paths, no `--amend` / `--force` / `--no-verify`.
- **Editable confirmation dialog.** Review and rewrite every message before anything is written; paths, file counts, skipped sensitive files, and model notes are all visible. Every message is validated before the first group commits, so a bad header in group 3 cannot leave groups 1–2 committed.
- **Safe staging (Git).** A pre-existing index is never mixed in — the dialog lists those exact paths and can release them while keeping the work. A failed group is moved back out of the index so the next attempt starts clean.
- **Stale plans are refused.** Commit re-reads the working tree; if the file grouping changed while you edited, the plugin asks you to analyze again instead of committing a different set of files under your old messages.
- **Conflict-aware (SVN).** Unresolved conflicts stop the analysis before anything is written, and the plugin never runs `svn update`: a merge stays your decision. A failed SVN commit unschedules only the `svn add`s that run made and keeps every file on disk.
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
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-<version>.tgz"
```

Or from the Web sidebar: **Plugins → Add plugin** and paste the same spec. The plugin installs into the current profile and applies to every session in it.

### Requirements

- DeepSeek Harness with the standard host services (`webServer`, `connection`, `sessions`, `workingDirectory`, `llm`, `agentDefaultModel`) and client slots.
- `git` and/or `svn` on `PATH`; the plugin also probes `/usr/bin/git`, `/opt/homebrew/bin/git`, `/usr/local/bin/git`, `/usr/bin/svn`, `/opt/homebrew/bin/svn`, and `/usr/local/bin/svn`, so a Finder-launched app works.
- A usable model route for semantic messages. Set `useModel: false` to skip the model and write every message by hand.

## Usage

1. Click **提交 / Commit** in the composer tool row. The dialog opens immediately with “Reading the working tree…”.
2. The host reads `git status` / `svn status --xml` and groups the paths; the dialog then shows the groups while the session's model names them. Slow models keep the progress banner and the button in a busy state.
3. Review the messages — each is an editable textarea with its paths, file count, and the model's suggestion underneath.
4. Press **确认提交 / Commit**. The host re-analyzes the working tree, checks that the grouping has not changed, validates every message, and only then commits group by group.
5. The result appears in the dialog, with **重新分析 / Analyze again** after a failure. Closing the dialog aborts a model call that is still running.

`Escape`, the backdrop, and the close button dismiss the dialog while it is not committing.

### Phases and failures

| Phase | What you see | On failure |
| --- | --- | --- |
| `analyzing` | Skeleton plus “Reading the working tree…” | The dialog closes and a notice explains why (clean tree, not a repo) |
| `naming` | Groups already listed plus “Naming with <model>…” | Editing opens with the reason; retry naming or write by hand |
| `edit` | Every message editable | Per-group validation reason under its textarea |
| `committing` | Everything locked plus “Committing…” | Per-group result; `stale` / staged-index conflicts ask for a re-analysis |
| `done` | Result text | A failed run also offers “Analyze again” |

## Configuration

Override the inserted row in the profile's `cordis.patch.yml`:

```yaml
- id: smart-commit
  name: '@eternalheart/dsh-git-commit'
  config:
    vcs: auto          # auto | git | svn
    gitPath: ''
    svnPath: ''
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
| `vcs` | `auto` | `auto` prefers Git and falls back to SVN; `git` / `svn` pin the adapter |
| `gitPath` | auto | Explicit git binary; empty probes `/usr/bin/git`, Homebrew, `/usr/local/bin/git` |
| `svnPath` | auto | Explicit svn binary; empty probes `/usr/bin/svn`, Homebrew, `/usr/local/bin/svn` |
| `timeoutMs` | `20000` | Deadline for each git / svn invocation |
| `maxGroups` | `6` | Above this, whole types are consolidated; types are never mixed and no path is dropped |
| `useModel` | `true` | `false` skips the model; every message must be written by hand |
| `modelTimeoutMs` | `60000` | Deadline for one summarization call |
| `maxInputChars` | `24000` | Diff characters sent to the model |
| `maxTokens` | `2000` | Output cap for the summarization |
| `repairRounds` | `1` | Targeted repair rounds for headers that failed validation (0–3) |

Raise `maxGroups` (for example to `20`) to keep one commit per module instead of one commit per type.

## How it works

### 1. Channel

The button calls `POST /dsh-git-commit/<endpoint>` directly; requests and responses are JSON. The route is registered on the Harness `webServer` and reuses `connection.admit()`: same origin, Host/Origin fence, browser session credentials, owner Peer only. The host keeps no “pending plan”, so `analyze` / `name` / `commit` are stateless and there is no TTL to expire.

### 2. Probe

Git: `git status --porcelain -z --untracked-files=all`, plus branch, `HEAD`, staged paths, and samples of new files. SVN: `svn info --xml` for the working-copy root and `svn status --xml` for the changes, with unversioned directories expanded into their files. Sensitive paths are dropped in both.

### 3. Group

Each path gets a type (`ci` / `docs` / `test` / `build` / `feat` / `refactor`) and a scope (first path segment, or the first two for `apps/`, `packages/`, `backend/`, `services/`, `libs/`, `modules/`, `crates/`, `src/`), then buckets by `type + scope`. Over `maxGroups`, whole types are merged — never different types.

### 4. Name

One `ctx.llm.stream()` call on the session's current route returns `{"messages":[...]}`. Casing, spacing, and trailing punctuation are normalized; invalid headers get one targeted repair round using the failing groups, the exact error, and their diffs. Naming runs after the dialog is already on screen, and closing the dialog aborts the model stream through the request signal.

### 5. Commit

`commit` re-analyzes the working tree and compares type, scope, and file sets group by group; any difference returns `stale` without writing. Every message is validated before the first group commits. Git: an empty index check, `git add -- <paths>`, `git commit -F`, and a per-group rollback of its own staging on failure. SVN: `svn add --parents --depth empty` for the group's unversioned files, then `svn commit -F` over the explicit paths (including newly added parent directories); a failure unschedules only that run's adds. The result reports what committed and what is still dirty.

## Safety rules

- One Angular `type` per commit; `chore` and unknown types are rejected.
- Header ≤ 72 chars, lowercase type/scope, subject ≤ 50 chars, no trailing punctuation, no leading capital, no `!` without a `BREAKING CHANGE:` footer.
- Every path is passed to `git add --` explicitly; `-A`, `.`, `-a`, `--amend`, `--force`, and `--no-verify` are never used.
- A non-empty index aborts the run; the dialog can release exactly the listed paths (the content stays in the working tree).
- Sensitive files are skipped and reported; a grouping change between confirm and commit is refused.
- A failed Git group is moved back out of the index so the next attempt starts clean.
- SVN conflicts abort before anything is written; missing files are skipped and reported. The plugin never runs `svn update`, `svn resolve`, `--force`, `--amend`, or `--no-verify`.
- A failed SVN commit reverts only the paths it scheduled itself; file contents always stay on disk.
- The HTTP channel only accepts same-origin, authenticated, owner-Peer JSON requests; it adds no unauthenticated port and puts no token in the URL.

## SVN notes

- **No staging area.** The “release staged paths” control is Git-only; SVN commits always take explicit paths.
- **One file, one group.** A file cannot be split across groups — the same limitation as the plugin's Git path, which never stages hunks.
- **New directories** are expanded into their files (bounded at 2000); a larger directory is skipped with a warning instead of being swept in. New parent directories are scheduled with `--depth empty`, so a sibling like `.env` never rides along.
- **Out-of-date commits** are rejected by the server and reported; run `svn update` yourself when you are ready to merge.
- **Credentials** are never touched: every command runs `--non-interactive`, so run `svn auth` beforehand if the server prompts.

## Upgrading from 2.x

3.0 removes the `/smart-commit` command and its `<base64>` argument: the button no longer goes through the command pipeline, so no `smart-commit` node appears in the conversation. Configuration is unchanged; restart DSH after upgrading so the host registers the new HTTP channel.

## Development guide

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
npm test          # node --test, no third-party dependencies
```

```text
index.js          host half: JSON channel, probe dispatch, grouping, model call, validation, commit
svn.js            SVN adapter: info/status probes, add, commit, revert, diff
client.js         client half: button, phased confirmation dialog, progress and errors
cordis.patch.yml  the loader row this bundle inserts
locale/           plugin metadata (en, zh)
test/             host and route tests with real temporary git / svn repositories
```

The bundle has no runtime dependencies: the host half uses Node built-ins, and the client half gets React from the Harness module table. The tests create real temporary repositories and drive a stub LLM, covering grouping, consolidation without path loss, validation, repair rounds, blocked groups, index release, failed-commit rollback, stale-plan refusal, and the channel's auth, method, and JSON checks; with `svn`/`svnadmin` installed they also run real SVN checkouts, revisions, sensitive-file skipping, and add rollback.

## Contributing

Feel free to submit [Issues](https://github.com/wh131462/dsh-git-commit/issues) and [Pull Requests](https://github.com/wh131462/dsh-git-commit/pulls) to help improve this project.

## License

[MIT](LICENSE) © 2026 EternalHeart

## Acknowledgments

Thanks to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) for the plugin runtime, slot system, and the client UI that this plugin extends.
