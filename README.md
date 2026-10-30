# dsh-git-commit

A DeepSeek Harness plugin: click **提交 / Commit** in the composer tool row. The plugin probes the
repository, groups the working tree by Angular type and scope, asks **the
Session's current model** to name every group in one call, shows editable
messages, and runs git itself once you confirm.

No chat message is sent and no Agent turn is created. The model is reached
through `ctx.llm.stream()` — the same provider/model route this Session already
uses — with a single bounded prompt and no tools.


## Install

```bash
# npm
plugin_manager install_bundle  target: "@eternalheart/dsh-git-commit"

# GitHub
plugin_manager install_bundle  target: "github:wh131462/dsh-git-commit"

# local tarball
plugin_manager install_bundle  target: "/absolute/path/eternalheart-dsh-git-commit-2.0.0.tgz"
```

Or from the Web sidebar: **Plugins → Add plugin** and paste the same spec. Installing needs `git` on the host; semantic messages need a working model route (otherwise set `useModel: false` and write messages yourself).

## Flow

1. **First click** runs `/smart-commit` (no argument).
   - `git status --porcelain -z --untracked-files=all` → one entry per path.
   - Each path gets a type (`ci` / `docs` / `test` / `build` / `feat` /
     `refactor`) and a scope, then paths are bucketed by `type + scope`.
   - A bounded prompt (paths, per-group diff excerpts, sampled new files) goes
     to the current model, which returns `{"messages":[...]}` — all headers in
     one response.
   - Every returned header is validated; an invalid or missing one keeps the
     heuristic `type(scope): subject` for that group.
   - The plan is stored for the Session and returned as readable text; the
     command row also lists the paths.
2. A **confirmation dialog** opens over the app (`shell.overlay`): one
   auto-growing textarea per group, the path list (first three inline, all on
   hover), file counts, skipped sensitive files, and the model note. If the
   index already holds staged work, the dialog lists those exact paths and
   requires ticking **先取消暂存** before the confirm button enables. `Escape`,
   the backdrop, or the close button dismiss it; nothing is written yet.
3. **Confirm** runs `/smart-commit commit <base64 of {"messages":[...]}>`. The
   Host re-validates every message, then for each group: refuses a non-empty
   index, `git add -- <paths>`, `git commit -F <tmpfile>`, and stops at the
   first failure. A failed group is moved back out of the index (`git restore
   --staged -- <its paths>`), so a failed run never leaves a dirty index behind.
   The dialog then shows the result in place, and the chat row carries the same
   text.

`/smart-commit cancel` drops a staged plan. A plan expires after 10 minutes.

**Commit messages are always semantic.** Heuristic text is only a hint inside
the prompt, never a final message:

- casing, spacing, and trailing punctuation are normalized before validation;
- a header that still fails gets one targeted repair round (the failing groups,
  the exact validation error, and their diffs go back to the model);
- if a header is still missing afterwards, that group stays **blank**, the
  dialog says which group and why, and the confirm button is disabled until you
  press **重新生成 message** or write one yourself;
- if the model call itself fails, the command returns an error and nothing is
  planned or committed.

## Model call details

| Item | Value |
| --- | --- |
| Service | `ctx.llm.stream()` (host-side, no Agent, no session message) |
| Route | The Session's last `request/header` `config`, else `agentDefaultModel.currentSelection()` |
| Effort | `off` when the route advertises it, else the Session's effort |
| Prompt | System rules plus per-group paths and diff excerpts |
| Budget | `maxInputChars` characters of diff, `maxTokens` output |
| Deadline | `modelTimeoutMs`, combined with the command's own signal |
| Reply | `{"messages":["<type>(<scope>): <subject>", ...]}`, one per group |

## What it refuses

The skill's hard rules are enforced in the Host, not by the model:

- one type per commit, from the `@commitlint/config-angular` enum; `chore` is rejected;
- header ≤ 72 chars, lowercase type/scope, subject ≤ 50 chars, no trailing
  punctuation, no leading capital, no `!` for breaking changes without a
  `BREAKING CHANGE:` footer;
- no `git add -A` / `.` / `git commit -a` — every path is listed explicitly;
- no `--amend`, `--force`, `--no-verify`;
- `.env*` (except `.env.example` / `.sample` / `.template`), `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*` are skipped and listed;
- a non-empty index aborts the whole run instead of mixing in somebody else's
  staged work.

## Grouping

- Type: `ci` → `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, …;
  `docs` → Markdown/reStructuredText/`docs/`; `test` → test paths and
  `*.test.*` / `*.spec.*`; `build` → lockfiles, package manifests, tool configs,
  `Dockerfile*`, `Makefile`, …; otherwise `feat` for added files and `refactor`
  for edits.
- Scope: the first path segment (or the first two for `apps/`, `packages/`,
  `backend/`, `services/`, `libs/`, `modules/`, `crates/`, `src/`), lowercased
  and hyphenated; omitted for root files and when it would repeat the type.
- Above `maxGroups` groups, the type with the most groups is consolidated into
  one commit (`refactor: 调整 N 个文件`). Types are never mixed and no path is
  ever dropped; raise `maxGroups` (for example to `20`) to keep one commit per
  module instead.

## Configuration

```yaml
- id: smart-commit
  name: '@local/dsh-smart-commit'
  config:
    gitPath: ''
    timeoutMs: 20000
    maxGroups: 6
    useModel: true
    modelTimeoutMs: 60000
    maxInputChars: 24000
    maxTokens: 2000
```

| Field | Default | Meaning |
| --- | --- | --- |
| `gitPath` | auto | Explicit git binary; empty checks `/usr/bin/git`, Homebrew, `/usr/local/bin/git` |
| `timeoutMs` | `20000` | Deadline for each git invocation |
| `maxGroups` | `6` | Above this, groups consolidate to one commit per type |
| `useModel` | `true` | `false` skips the model entirely; every message must be written by hand |
| `modelTimeoutMs` | `60000` | Deadline for the whole summarization call |
| `maxInputChars` | `24000` | Diff characters included in the prompt |
| `maxTokens` | `2000` | Output cap for the summarization |
| `repairRounds` | `1` | Targeted repair rounds for headers that failed validation (0–3) |

## Files

| File | Role |
| --- | --- |
| `index.js` | Host: probe, grouping, model summarization, validation, commit, `/smart-commit` |
| `client.js` | Client: button and the confirmation dialog (editable messages, result view) |
| `test/host.test.js` | 24 tests, including real temporary git repositories and a stub LLM |
| `locale/{en,zh}.json` | Plugin Manager metadata |
| `icon.svg` | Commit-node artwork |

## Verification

- `npm test` — 24/24 pass: classification, scoping, sensitive filtering,
  porcelain parsing, type-pure consolidation without path loss, Angular
  validation, real-repo analysis, multi-group commit, index refusal,
  invalid-message refusal, non-repo directory, command staging + commit + edit,
  base64 payloads, model messages replacing heuristics, hard failure and
  non-JSON errors, normalization, repair rounds, blocked groups after a failed
  repair, prompt budget, JSON extraction, pre-existing index release,
  failed-commit rollback, config clamping.
- A dry analysis of the author's `CoalMind` repository produced the expected
  groups over 50+ files with no write.
- The live slot registration is checked after installation; the button, dialog,
  and a real model round trip still need a visual pass because this session has
  no browser control.
