# DSH Git Commit [![npm version](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=a1b858&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![downloads](https://img.shields.io/npm/dm/@eternalheart/dsh-git-commit?color=50a36f&label=)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit) [![license](https://img.shields.io/badge/license-MIT-1e8a7a)](LICENSE) [![github](https://img.shields.io/github/stars/wh131462/dsh-git-commit?style=social)](https://github.com/wh131462/dsh-git-commit)

[中文](./README_CN.md) · **English**

**DSH Git Commit** is a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin that turns the composer into a one-click, model-planned commit. It detects Git or SVN and lets the session's current model decide how many commits the change set should become, which files belong together, and the Angular message for each — then runs the VCS itself after you confirm. No chat message, no agent turn, no tool calls.

## Interface

```
click → dialog opens immediately → git/svn status → rule-based preview
      → one model call (model picks the final groups and messages)
      → edit → commit
```

The same flow works in a Git repository and in an SVN working copy; `vcs: auto` picks one, and `vcs: git` / `vcs: svn` pin it.

```text
┌ Confirm commit ─────────────────────────────────────────── × ┐
│ 5 groups, 79 files   main   GIT                               │
│ ⟳ Planning the groups with deepseek-official/deepseek-flash…  │
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

- **Visible progress, in the dialog.** Clicking opens the dialog immediately: “Reading the working tree” plus a rule-based preview, then “Planning the groups with <model>”, then “Committing”. Closing the dialog aborts the model call.
- **Git and SVN.** `auto` prefers Git when both exist (a git-svn checkout), otherwise the SVN working copy. Git commits stage explicit paths; SVN commits schedule new files with `svn add` and commit explicit paths, one revision per group.
- **The model plans the groups, the host checks them.** The model receives a numbered list of every changed path (status, path, type hint, and the diff within budget) and decides the group count and membership, then names each group; `maxGroups` is only a ceiling. The host enforces coverage: files the model never claimed are grouped by the rules, repeated or out-of-range numbers are ignored, and no path is dropped. Docs, tests, CI, and build types are locked to what the path says; only source groups may pick `fix` / `refactor` / `perf`.
- **Semantic messages, always.** Every group is named by the model, and count-only subjects ("modified 5 files", "update files") are rejected outright. Headers are normalized, then invalid ones get a targeted repair round; groups the model missed, split out, or merged are sent back to the model for naming. A group that still has no valid message stays blank and blocks the commit, while the rule fallback names concrete files or areas (never file counts) and the dialog flags the groups that still need a better name.
- **No agent turn and no command.** The button calls the plugin's own JSON channel on the host, so no `command/run` node is appended, no chat message is added, no tools run, and a model transport failure cannot leave a commit stuck in the conversation.
- **The rules live in code.** `@commitlint/config-angular` is enforced by the host: one type per commit, header ≤ 72, subject ≤ 50, explicit paths, no `--amend` / `--force` / `--no-verify`.
- **Editable grouping and messages.** Before anything is written you can rewrite every message and also rearrange the groups: select files and move them to another group or a new one, drag a file onto a target group, or use ↑ to merge a group into the one above; changed groups are tagged “Grouping changed”. Paths, file counts, skipped sensitive files, and model notes stay visible. Every message is validated before the first group commits, so a bad header in group 3 cannot leave groups 1–2 committed.
- **Safe staging (Git).** A pre-existing index is never mixed in — the dialog lists those exact paths and can release them while keeping the work. A failed group is moved back out of the index so the next attempt starts clean.
- **Stale plans are refused.** Commit re-reads the working tree and requires the confirmed groups to cover exactly the current changed paths — no duplicates, no omissions, no empty groups. When they do not match, it asks you to analyze again instead of committing a different set of files under your old messages.
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
2. The host reads `git status` / `svn status --xml` and shows a rule-based preview grouping; it then sends the numbered path list to the session's model, which decides the final group count and membership and writes the message for each. Slow models keep the progress banner and the button in a busy state.
3. Review the groups — each is an editable textarea plus file chips. To fix a grouping, select files and choose a target (or “New group”), drag a file onto another group, or use ↑ to merge a group into the one above. Changed groups are tagged, and their messages may need a matching edit.
4. Press **确认提交 / Commit**. The host re-analyzes the working tree, checks that the (edited) groups cover the changed paths exactly, validates every message, and only then commits group by group.
5. The result appears in the dialog, with **重新分析 / Analyze again** after a failure. Closing the dialog aborts a model call that is still running.

`Escape`, the backdrop, and the close button dismiss the dialog while it is not committing.

### Phases and failures

| Phase | What you see | On failure |
| --- | --- | --- |
| `analyzing` | Skeleton plus “Reading the working tree…” | The dialog closes and a notice explains why (clean tree, not a repo) |
| `naming` | Rule preview already listed plus “Planning the groups with <model>…” | Editing opens with the reason; retry naming or write by hand |
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
    maxGroups: 12
    useModel: true
    modelTimeoutMs: 60000
    maxInputChars: 32000
    maxTokens: 2000
    repairRounds: 1
```

| Field | Default | Meaning |
| --- | --- | --- |
| `vcs` | `auto` | `auto` prefers Git and falls back to SVN; `git` / `svn` pin the adapter |
| `gitPath` | auto | Explicit git binary; empty probes `/usr/bin/git`, Homebrew, `/usr/local/bin/git` |
| `svnPath` | auto | Explicit svn binary; empty probes `/usr/bin/svn`, Homebrew, `/usr/local/bin/svn` |
| `timeoutMs` | `20000` | Deadline for each git / svn invocation |
| `maxGroups` | `12` | Safety ceiling: the model may use at most this many groups; beyond it whole types are merged and no path is dropped |
| `useModel` | `true` | `false` skips the model; every message must be written by hand |
| `modelTimeoutMs` | `60000` | Deadline for one model planning call |
| `maxInputChars` | `32000` | Character budget for one planning request: numbered list plus diff |
| `maxTokens` | `2000` | Output cap for the summarization |
| `repairRounds` | `1` | Targeted naming rounds for messages that failed validation or still hold a rule placeholder (0–3) |

The model picks the group count; `maxGroups` is only the ceiling. Raise it (for example to `20`) for finer commits, lower it for coarser ones. Large change sets degrade in three steps: numbered paths → numbered rule units (type+scope buckets) when the paths do not fit → rule grouping only when even the units do not fit. The last two modes can still be adjusted in the dialog.

## How it works

### 1. Channel

The button calls `POST /dsh-git-commit/<endpoint>` directly; requests and responses are JSON. The route is registered on the Harness `webServer` and reuses `connection.admit()`: same origin, Host/Origin fence, browser session credentials, owner Peer only. The host keeps no “pending plan”, so `analyze` / `name` / `commit` are stateless and there is no TTL to expire.

### 2. Probe

Git: `git status --porcelain -z --untracked-files=all`, plus branch, `HEAD`, staged paths, and samples of new files. SVN: `svn info --xml` for the working-copy root and `svn status --xml` for the changes, with unversioned directories expanded into their files. Sensitive paths are dropped in both.

### 3. Preview grouping (rules)

Each path gets a type (`ci` / `docs` / `test` / `build` / `feat` / `refactor`) and a scope (first path segment, or the first two for `apps/`, `packages/`, `backend/`, `services/`, `libs/`, `modules/`, `crates/`, `src/`), then buckets by `type + scope`. This preview fills the dialog immediately and is the fallback when no model is available; it also defines exactly which paths reach the model prompt.

### 4. Planning and naming (model)

When the change set is too large to number every path, the model instead receives a list of **rule units** (one type+scope bucket each, with up to four sample paths) and decides which units belong in each commit; a unit is never split. A few hundred files then cost a few dozen prompt lines, so the model still chooses the group count instead of falling back to the rules.

The changed paths are numbered in a fixed order (with status code, a `docs`/`test`/`build`/`ci` marker where the path decides the type, and the diff within budget) and sent to the session's model. One `ctx.llm.stream()` call returns:

```json
{"groups":[{"paths":[1,3],"type":"feat","scope":"auth","message":"feat(auth): add login endpoint"}]}
```

The host does not take the model's word for the risky parts: every number must be used exactly once, out-of-range and repeated numbers are ignored, and files the model missed are grouped by the rules. Types decided by the path (docs / test / CI / build) are locked; only source groups may choose `fix` / `refactor` / `perf`. Messages are normalized and validated, then invalid ones get one targeted repair round with the failing groups, the exact error, and their diffs. Groups that the rules had to fill, split, or merge are sent back to the model with their paths and diffs so a count-style subject never becomes a commit message; if naming still fails, the group stays blank and the commit is blocked. Planning runs after the dialog is already on screen, and closing the dialog aborts the model stream through the request signal.

### 5. Commit

`commit` re-analyzes the working tree and requires the confirmed groups to cover exactly the current changed paths (no duplicates, no omissions, no empty groups); otherwise it returns `stale` without writing. Every message is validated before the first group commits. Git: an empty index check, `git add -- <paths>`, `git commit -F`, and a per-group rollback of its own staging on failure. SVN: `svn add --parents --depth empty` for the group's unversioned files, then `svn commit -F` over the explicit paths (including newly added parent directories); a failure unschedules only that run's adds. The result reports what committed and what is still dirty.

Every git call that meets an `index.lock` first checks whether a process still holds it: a lock left behind by a crashed or timed-out git is cleared and the command retried once, so the commit continues; a lock held by another git process (a terminal commit, an IDE) is never deleted — the holder's PID is reported instead, and you retry once it finishes.

## Safety rules

- One Angular `type` per commit; `chore` and unknown types are rejected.
- Header ≤ 72 chars, lowercase type/scope, subject ≤ 50 chars, no trailing punctuation, no leading capital, no `!` without a `BREAKING CHANGE:` footer.
- A subject must describe the change; count-only subjects ("modified 5 files", "update 3 docs") and bare "update files" are rejected.
- Every path is passed to `git add --` explicitly; `-A`, `.`, `-a`, `--amend`, `--force`, and `--no-verify` are never used.
- A non-empty index aborts the run; the dialog can release exactly the listed paths (the content stays in the working tree).
- Sensitive files are skipped and reported; a grouping change between confirm and commit is refused.
- A failed Git group is moved back out of the index so the next attempt starts clean.
- `index.lock` is only cleared when no process holds it; a live holder is never deleted and its PID is reported instead.
- SVN conflicts abort before anything is written; missing files are skipped and reported. The plugin never runs `svn update`, `svn resolve`, `--force`, `--amend`, or `--no-verify`.
- A failed SVN commit reverts only the paths it scheduled itself; file contents always stay on disk.
- The HTTP channel only accepts same-origin, authenticated, owner-Peer JSON requests; it adds no unauthenticated port and puts no token in the URL.

## SVN notes

- **No staging area.** The “release staged paths” control is Git-only; SVN commits always take explicit paths.
- **One file, one group.** A file cannot be split across groups — the same limitation as the plugin's Git path, which never stages hunks.
- **New directories** are expanded into their files (bounded at 2000); a larger directory is skipped with a warning instead of being swept in. New parent directories are scheduled with `--depth empty`, so a sibling like `.env` never rides along.
- **Out-of-date commits** are rejected by the server and reported; run `svn update` yourself when you are ready to merge.
- **Non-ASCII paths and messages.** Every svn command runs under a UTF-8 locale (`C.UTF-8`, falling back to `en_US.UTF-8`), so Chinese or accented paths can be added and committed, and log text reads back as UTF-8 instead of `{U+...}` escapes; svn's own messages stay in English, so parsing is unaffected.
- **Credentials** are never touched: every command runs `--non-interactive`, so run `svn auth` beforehand if the server prompts.

## Upgrading from 2.0.3

2.1.0 handles `index.lock`: every git call probes whether the lock is still held, clears a lock left by a crashed or timed-out git and retries once, and refuses to delete a lock held by another git process — it reports the PID instead, so an in-flight index write is never corrupted. Configuration keys are unchanged; restart DSH after upgrading.

## Upgrading from 2.0.2

2.0.3 refines the confirmation dialog: selected-file actions now sit in the footer behind a themed "Move to" menu instead of a native select, selected chips are highlighted without moving the layout, and group selection uses a fixed-size checkbox. Configuration keys are unchanged; restart DSH after upgrading.

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

The bundle has no runtime dependencies: the host half uses Node built-ins, and the client half gets React from the Harness module table. The tests create real temporary repositories and drive a stub LLM, covering grouping, consolidation without path loss, validation, repair rounds, blocked groups, index release, failed-commit rollback, orphaned-lock recovery and live-lock refusal, stale-plan refusal, and the channel's auth, method, and JSON checks; with `svn`/`svnadmin` installed they also run real SVN checkouts, revisions, sensitive-file skipping, add rollback, and non-ASCII paths under the plugin's UTF-8 locale.

## Contributing

Feel free to submit [Issues](https://github.com/wh131462/dsh-git-commit/issues) and [Pull Requests](https://github.com/wh131462/dsh-git-commit/pulls) to help improve this project.

## License

[MIT](LICENSE) © 2026 EternalHeart

## Acknowledgments

Thanks to [DeepSeek Harness](https://github.com/deepseek-ai/dsh) for the plugin runtime, slot system, and the client UI that this plugin extends.
