#!/usr/bin/env node
/**
 * Build the Markdown body for a GitHub release.
 *
 * Everything committed between the previous `v*` tag and HEAD is grouped by its
 * Conventional Commit type, every subject links back to its commit, and the
 * install section is generated for the version being released.
 *
 * Usage:
 *   node scripts/release-notes.mjs [--version X.Y.Z] [--from vX.Y.Z] [--output FILE]
 *
 * --version defaults to package.json's version.
 * --from    defaults to the newest `v*` tag reachable from HEAD that is not the
 *           tag being released, so re-running for the same version still finds
 *           the previous release.
 * --output  defaults to stdout.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const TYPE_LABELS = new Map([
  ['feat', '新功能'],
  ['fix', '修复'],
  ['perf', '性能'],
  ['refactor', '重构'],
  ['docs', '文档'],
  ['build', '构建'],
  ['ci', 'CI'],
  ['test', '测试'],
  ['style', '代码风格'],
  ['chore', '杂项'],
]);
const BREAKING_LABEL = '破坏性变更';
const OTHER_LABEL = '其他';
const RELEASE_SUBJECT = /^(?:feat:\s*v\d+\.\d+\.\d+|chore\(release\):)/;

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }
  return options;
}

function repositoryUrl() {
  if (process.env.GITHUB_REPOSITORY) {
    return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  }
  const raw = typeof PKG.repository === 'string' ? PKG.repository : PKG.repository?.url ?? '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

function previousTag(version) {
  const tags = git('tag', '--sort=-v:refname', '--merged', 'HEAD', '--list', 'v[0-9]*')
    .split('\n')
    .filter(Boolean);
  return tags.find((tag) => tag !== `v${version}`) ?? '';
}

function readCommits(from) {
  const range = from ? `${from}..HEAD` : 'HEAD';
  const raw = git('log', range, '--no-merges', '--pretty=format:%H%x1f%h%x1f%s%x1e');
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, short, subject] = record.split('\x1f');
      const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
      return {
        sha,
        short,
        subject,
        type: match ? match[1].toLowerCase() : '',
        scope: match?.[2] ?? '',
        breaking: Boolean(match?.[3]),
        description: match ? match[4] : subject,
      };
    })
    .filter((commit) => !RELEASE_SUBJECT.test(commit.subject));
}

function sectionLabel(commit) {
  if (commit.breaking) return BREAKING_LABEL;
  return TYPE_LABELS.get(commit.type) ?? OTHER_LABEL;
}

function groupCommits(commits) {
  const groups = new Map();
  for (const commit of commits) {
    const label = sectionLabel(commit);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(commit);
  }
  const order = [BREAKING_LABEL, ...TYPE_LABELS.values(), OTHER_LABEL];
  return [...groups.entries()].sort(([left], [right]) => order.indexOf(left) - order.indexOf(right));
}

function renderNotes({ version, tag, repoUrl, from, commits }) {
  const lines = ['## 变更内容', ''];

  if (commits.length === 0) {
    lines.push('本次发布没有需要列出的提交变更。', '');
  } else {
    for (const [label, items] of groupCommits(commits)) {
      lines.push(`### ${label}`, '');
      for (const commit of items) {
        const text = commit.scope ? `**${commit.scope}**: ${commit.description}` : commit.description;
        const link = `${repoUrl}/commit/${commit.sha}`;
        lines.push(`- ${text} ([${commit.short}](${link}))`);
      }
      lines.push('');
    }
  }

  if (from) {
    lines.push(`**完整变更**: [\`${from}...${tag}\`](${repoUrl}/compare/${from}...${tag})`, '');
  } else {
    lines.push(`**完整变更**: [\`${tag}\`](${repoUrl}/commits/${tag})`, '');
  }

  const slug = repoUrl.replace(/^https:\/\/github\.com\//, '');
  const tarball = `${PKG.name.replace(/^@([^/]+)\//, '$1-').replace(/\//g, '-')}-${version}.tgz`;

  lines.push(
    '## 安装',
    '',
    '### DeepSeek Harness',
    '',
    '```bash',
    '# 从 npm 安装（推荐）',
    `plugin_manager install_bundle  target: "${PKG.name}@${version}"`,
    '',
    '# 从 GitHub tag 安装',
    `plugin_manager install_bundle  target: "github:${slug}#${tag}"`,
    '',
    '# 从本 Release 的压缩包安装',
    `plugin_manager install_bundle  target: "/absolute/path/${tarball}"`,
    '```',
    '',
    '也可以在网页侧边栏 **Plugins → Add plugin** 里粘贴同样的 spec。',
    '',
    '### npm',
    '',
    '```bash',
    `npm install ${PKG.name}@${version}`,
    '```',
    '',
    '### 环境要求',
    '',
    `- Node.js >= ${PKG.engines?.node?.replace(/^>=\s*/, '') ?? '20'}`,
    '- `PATH` 中有 `git`',
    '',
  );

  return lines.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = String(options.version || PKG.version);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version "${version}", expected X.Y.Z`);
  }

  const tag = `v${version}`;
  const from = typeof options.from === 'string' ? options.from : previousTag(version);
  const notes = renderNotes({
    version,
    tag,
    repoUrl: repositoryUrl(),
    from,
    commits: readCommits(from),
  });

  if (typeof options.output === 'string') {
    writeFileSync(resolve(ROOT, options.output), notes, 'utf8');
    console.error(
      `release notes for ${tag} written to ${options.output}` +
        (from ? ` (${from}..HEAD)` : ' (full history)'),
    );
  } else {
    process.stdout.write(notes);
  }
}

try {
  main();
} catch (error) {
  console.error(`release-notes: ${error.message}`);
  process.exitCode = 1;
}
