# dsh-git-commit

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/@eternalheart/dsh-git-commit?color=blue)](https://www.npmjs.com/package/@eternalheart/dsh-git-commit)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

One-click, model-named git commits for **DeepSeek Harness**.

A **提交 / Commit** button in the composer probes the repository, groups the
working tree by Angular type and scope, asks the session's **current model** for
one commit message per group, shows an editable confirmation dialog, and runs
git itself. No chat message is sent and no agent turn is created.

```
click → git status → type/scope buckets → one model call → confirm dialog → git add/commit
```

## Why this exists

- **No agent turn in the commit path.** The button calls a host command, not
  `agent.followup()`. Nothing is written to the conversation, no tools run, and
  a model transport failure cannot leave a commit half-explained in chat.
- **Messages are semantic, always.** The model names every group. A header that
  fails the Angular rules gets normalized, then one targeted repair round; if it
  is still invalid, that group stays **blank** and the dialog blocks the commit
  instead of silently falling back to generic text.
- **The rules live in code.** `@commitlint/config-angular` is enforced by the
  host, not by prompt: one type per commit, header ≤ 72, subject ≤ 50, explicit
  paths, no `--amend/--force/--no-verify`, sensitive files skipped, and a
  non-empty index is never mixed into the run.

## Features

- Groups the working tree by Angular `type` + `scope`, one commit per group.
- One model call names all groups; bounded diff budget, no tools, no chat row.
- Validation, normalization, and a targeted repair round for bad headers.
- Editable confirmation dialog with per-group file paths and counts.
- Refuses a pre-existing index and offers to release exactly those paths.
- Rolls its own staging back when a commit fails, so a failure never blocks the
  next attempt.
- Skips `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`,
  `id_rsa*` (`.env.example` / `.sample` / `.template` stay allowed).
- Theme-token styling, keyboard and screen-reader friendly dialog.
- 24 tests, including real temporary git repositories and a stub LLM.

## Requirements

- DeepSeek Harness with the standard host services (`commands`, `llm`,
  `agentDefaultModel`, client slots). The shipped Desktop/Web profile has them.
- `git` on `PATH`. The plugin also probes `/usr/bin/git`,
  `/opt/homebrew/bin/git`, and `/usr/local/bin/git` so a Finder-launched app
  works.
- A usable model route for semantic messages. Set `useModel: false` to skip the
  model and write every message by hand.

## Install

```bash
# npm
plugin_manager install_bundle  target: "@eternalheart/dsh-git-commit"

# GitHub (SSH or HTTPS)
plugin_manager install_bundle  target: "github:wh131462/dsh-git-commit"

# local tarball
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-2.0.0.tgz"
```

Or from the Web sidebar: **Plugins → Add plugin** and paste the same spec.
Installation affects the current profile, i.e. every session in it.

## Usage

1. Click **提交 / Commit** in the composer tool row.
2. The host analyzes the repository (`git status --porcelain -z -uall`), groups
   the paths, names each group with the model, and opens a confirmation dialog.
3. Review the messages — each one is an editable textarea with its paths and
   file count underneath. Warnings list skipped sensitive files, a pre-existing
   index, and any group that still needs a message.
4. Press **确认提交 / Commit**. Each group runs
   `git add -- <paths>` + `git commit -F <tmpfile>`; the dialog then shows the
   per-group result, or the failure with a **重新分析 / Analyze again** action.

`Escape`, the backdrop, and the close button dismiss the dialog while it is not
committing.

### Command

The button calls `/smart-commit`, which is also available by typing:

| Command | Effect |
| --- | --- |
| `/smart-commit` | Analyze and plan (does not write anything) |
| `/smart-commit commit <base64>` | Commit the staged plan with the given messages |
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

Raise `maxGroups` (e.g. `20`) when you prefer one commit per module instead of
one commit per type.

## How it works

1. **Probe.** `git status --porcelain -z --untracked-files=all`, plus branch,
   `HEAD`, staged paths, and new-file samples. Sensitive paths are dropped.
2. **Group.** Each path gets a type (`ci` / `docs` / `test` / `build` / `feat` /
   `refactor`) and a scope (first path segment, or the first two for `apps/`,
   `packages/`, `backend/`, `services/`, `libs/`, `modules/`, `crates/`, `src/`),
   then buckets by `type + scope`. Over `maxGroups`, whole types are merged.
3. **Name.** One `ctx.llm.stream()` call on the session's current route returns
   `{"messages":[...]}`. Casing, spacing, and trailing punctuation are
   normalized; invalid headers are retried in one targeted repair round.
4. **Confirm.** The dialog lists every group with editable text, paths, and
   warnings. Nothing is written before you confirm.
5. **Commit.** Group by group: an empty index check, `git add -- <paths>`,
   `git commit -F`, with a per-group rollback of its own staging on failure. The
   result reports what committed and what is still dirty.

## Safety rules

- One Angular `type` per commit; `chore` and unknown types are rejected.
- Header ≤ 72 chars, lowercase type/scope, subject ≤ 50 chars, no trailing
  punctuation, no leading capital, no `!` without a `BREAKING CHANGE:` footer.
- Every path is passed to `git add --` explicitly; `-A`, `.`, `-a`, `--amend`,
  `--force`, and `--no-verify` are never used.
- A non-empty index aborts the run; the dialog can release exactly the listed
  paths (the content stays in the working tree).
- Sensitive files are skipped and reported.
- A failed group is moved back out of the index so the next attempt starts
  clean.

## Development

```bash
git clone git@github.com:wh131462/dsh-git-commit.git
cd dsh-git-commit
npm test          # node --test, no dependencies
```

```
index.js          host half: probe, grouping, model call, validation, commit
client.js         client half: button and confirmation dialog
cordis.patch.yml  the loader row this bundle inserts
locale/           plugin metadata (en, zh)
test/             host tests with real temporary git repositories
```

The bundle has no runtime dependencies: the host half uses Node built-ins, and
the client half gets React from the Harness module table.

## License

[MIT](LICENSE) © 2026 EternalHeart
