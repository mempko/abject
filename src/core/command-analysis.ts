/**
 * What a shell command line actually does, decided by reading it rather than
 * by pattern-matching it.
 *
 * The permission gate used to treat a shell metacharacter as a reason to give
 * up: any line containing `&&` or `|` could not be reduced to a program name,
 * so it could not be matched against a grant, so it went to the user. Every
 * time. Since an agent composes pipelines constantly, that meant a modal per
 * action forever, and the modal named the wrong program (`cd`, the first word)
 * because a compound line has no single program.
 *
 * A metacharacter is a reason to *parse*. This module splits a line into the
 * commands it really runs, classifies each one, and reports the paths it
 * touches. A line is then exactly as dangerous as its most dangerous segment,
 * which is a statement a permission policy can act on.
 *
 * Three rules keep this honest:
 *
 *   1. **Unknown is not safe.** An unrecognized program is `exec`, never
 *      `read`. Being unknown costs a prompt, not a containment failure.
 *   2. **Unparseable is not safe.** Anything the lexer cannot reduce with
 *      confidence (command substitution, `eval`, a pipe into an interpreter)
 *      is marked `opaque`, and no policy auto-approves an opaque line.
 *   3. **This is code, never an LLM.** The agent reads attacker-controlled
 *      files. Asking a model whether a command is safe would put a
 *      prompt-injection target inside the security boundary.
 *
 * Nothing here touches the disk or the environment. Paths are resolved
 * arithmetically against a supplied cwd, so a decision never depends on
 * whether a file has been created yet.
 */

import * as path from 'path';
import { require as contractRequire } from './contracts.js';
import { expandHome, isInside } from './path-scope.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * What a command does, ordered by how much trust running it requires.
 *
 * `exec` sits above `write` because a build script writes wherever it likes;
 * `network` above that because it can also exfiltrate; `dangerous` is the set
 * no autonomy level ever waves through.
 */
export type EffectClass = 'read' | 'write' | 'exec' | 'network' | 'dangerous';

const EFFECT_RANK: Record<EffectClass, number> = {
  read: 0, write: 1, exec: 2, network: 3, dangerous: 4,
};

export function effectRank(e: EffectClass): number { return EFFECT_RANK[e]; }

export function maxEffect(a: EffectClass, b: EffectClass): EffectClass {
  return EFFECT_RANK[a] >= EFFECT_RANK[b] ? a : b;
}

/** A path the command touches, and whether we could pin it down. */
export interface TouchedPath {
  /** As written on the command line. */
  raw: string;
  /** Absolute path, when it could be resolved against the cwd. */
  resolved?: string;
  /**
   * Set when the path contains an unexpanded variable or other construct whose
   * value we do not know. An unresolved path is never treated as contained.
   */
  unresolved?: boolean;
}

/** One command within a compound line. */
export interface Segment {
  /** The program, basename only, after stripping env assignments and wrappers. */
  program: string;
  /** Everything after the program, as written. */
  argv: string[];
  effect: EffectClass;
  /** Why this segment got the effect it did, for the dialog and the log. */
  reason: string;
  reads: TouchedPath[];
  writes: TouchedPath[];
}

export interface CommandAnalysis {
  /** The commands the line actually runs, in order. */
  segments: Segment[];
  /** The most dangerous segment's effect; `read` for an empty line. */
  effect: EffectClass;
  /** Distinct program names, in first-seen order. Useful for grants. */
  programs: string[];
  /**
   * The program a permission grant should be offered for: the one carrying the
   * segment that set the overall effect. Never `cd`, unless `cd` is all there
   * is.
   */
  principalProgram: string;
  /** True when the line could not be reduced with confidence. */
  opaque: boolean;
  opaqueReason?: string;
  reads: TouchedPath[];
  writes: TouchedPath[];
  /** Set when the line is in the never-auto set, with the reason why. */
  dangerReason?: string;
}

/** Whether every path the command touches sits inside one of `roots`. */
export interface ContainmentResult {
  contained: boolean;
  /** Paths that fall outside, or could not be resolved. */
  escapes: TouchedPath[];
}

// ═══════════════════════════════════════════════════════════════════════
// The program table
// ═══════════════════════════════════════════════════════════════════════

interface ProgramRule {
  effect: EffectClass;
  /** Effect chosen by the first non-flag argument, as `git status` does. */
  sub?: Record<string, EffectClass>;
  /** Effect for a subcommand not listed in `sub`. */
  subDefault?: EffectClass;
  /** Flags that raise this program to `write` (`sed -i`). */
  writeFlags?: string[];
  /** Flags that raise this program to `dangerous` (`find -delete`). */
  dangerFlags?: string[];
  /** Flags whose *value* is a file the command writes (`curl -o out`). */
  outFlags?: string[];
  /**
   * Flags that consume the next word, so it is not mistaken for a path.
   * `find -name '*.ts'` names a pattern, not a file.
   */
  valuedFlags?: string[];
  /** Leading non-flag arguments that are not paths (grep's pattern). */
  skipArgs?: number;
  /** Whether remaining non-flag arguments should be read as paths. */
  argsArePaths?: boolean;
  /** Non-flag path arguments are written, not read (`mkdir`, `rm`). */
  argsAreWrites?: boolean;
}

/**
 * What each program does. Deliberately data rather than code, so the set can
 * grow (and be edited in Settings) without touching the classifier.
 *
 * Absent from this table means `exec`, which means a prompt. Adding a program
 * here is how the prompt goes away, and that is a decision worth making
 * explicitly rather than by regex.
 */
const PROGRAMS: Record<string, ProgramRule> = {
  // ── Reading and inspecting ──
  ls: { effect: 'read', argsArePaths: true },
  cat: { effect: 'read', argsArePaths: true },
  head: { effect: 'read', argsArePaths: true },
  tail: { effect: 'read', argsArePaths: true },
  wc: { effect: 'read', argsArePaths: true },
  file: { effect: 'read', argsArePaths: true },
  stat: { effect: 'read', argsArePaths: true },
  du: { effect: 'read', argsArePaths: true },
  df: { effect: 'read' },
  tree: { effect: 'read', argsArePaths: true },
  realpath: { effect: 'read', argsArePaths: true },
  dirname: { effect: 'read' },
  basename: { effect: 'read' },
  pwd: { effect: 'read' },
  cd: { effect: 'read', argsArePaths: true },
  echo: { effect: 'read' },
  printf: { effect: 'read' },
  true: { effect: 'read' },
  false: { effect: 'read' },
  which: { effect: 'read' },
  type: { effect: 'read' },
  date: { effect: 'read' },
  whoami: { effect: 'read' },
  hostname: { effect: 'read' },
  uname: { effect: 'read' },
  sort: { effect: 'read', argsArePaths: true },
  uniq: { effect: 'read', argsArePaths: true },
  cut: { effect: 'read', argsArePaths: true },
  tr: { effect: 'read' },
  column: { effect: 'read' },
  jq: { effect: 'read', skipArgs: 1, argsArePaths: true },
  yq: { effect: 'read', skipArgs: 1, argsArePaths: true },
  diff: { effect: 'read', argsArePaths: true },
  cmp: { effect: 'read', argsArePaths: true },
  md5sum: { effect: 'read', argsArePaths: true },
  sha256sum: { effect: 'read', argsArePaths: true },
  grep: { effect: 'read', skipArgs: 1, argsArePaths: true, valuedFlags: ['-e', '--regexp', '--include', '--exclude', '--exclude-dir', '-m', '-A', '-B', '-C'] },
  egrep: { effect: 'read', skipArgs: 1, argsArePaths: true },
  fgrep: { effect: 'read', skipArgs: 1, argsArePaths: true },
  rg: { effect: 'read', skipArgs: 1, argsArePaths: true, valuedFlags: ['-e', '--regexp', '-g', '--glob', '-t', '--type', '-m', '-A', '-B', '-C'] },
  ag: { effect: 'read', skipArgs: 1, argsArePaths: true },
  // `sed -n` prints; `sed -i` rewrites the file in place.
  sed: { effect: 'read', skipArgs: 1, argsArePaths: true, writeFlags: ['-i', '--in-place'] },
  awk: { effect: 'read', skipArgs: 1, argsArePaths: true },
  // `find -delete` and `find -exec` are the whole point of reading arguments.
  find: {
    effect: 'read', argsArePaths: true,
    dangerFlags: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint'],
    valuedFlags: ['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-type', '-maxdepth',
      '-mindepth', '-newermt', '-newer', '-size', '-perm', '-user', '-group', '-printf', '-exec', '-execdir'],
  },
  fd: { effect: 'read', skipArgs: 1, argsArePaths: true, dangerFlags: ['-x', '--exec', '-X', '--exec-batch'] },
  xxd: { effect: 'read', argsArePaths: true },
  less: { effect: 'read', argsArePaths: true },
  readlink: { effect: 'read', argsArePaths: true },

  // ── Writing inside a tree ──
  mkdir: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  touch: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  cp: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  mv: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  ln: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  rm: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  rmdir: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  tee: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  truncate: { effect: 'write', argsArePaths: true, argsAreWrites: true },
  patch: { effect: 'write', argsArePaths: true, argsAreWrites: true },

  // ── Version control, by subcommand ──
  git: {
    effect: 'exec',
    subDefault: 'exec',
    dangerFlags: ['--force', '-f', '--force-with-lease', '--hard'],
    sub: {
      status: 'read', log: 'read', diff: 'read', show: 'read', blame: 'read',
      'rev-parse': 'read', 'ls-files': 'read', 'ls-tree': 'read', 'cat-file': 'read',
      branch: 'read', tag: 'read', describe: 'read', 'symbolic-ref': 'read',
      'merge-base': 'read', 'name-rev': 'read', shortlog: 'read', grep: 'read',
      config: 'read', remote: 'read', 'check-ignore': 'read', 'diff-tree': 'read',
      add: 'write', commit: 'write', checkout: 'write', switch: 'write',
      restore: 'write', stash: 'write', merge: 'write', rebase: 'write',
      reset: 'write', revert: 'write', 'cherry-pick': 'write', apply: 'write',
      am: 'write', mv: 'write', clean: 'write', worktree: 'write', init: 'write',
      push: 'network', pull: 'network', fetch: 'network', clone: 'network',
      submodule: 'network',
    },
  },
  hg: { effect: 'exec' },

  // ── Toolchains, by subcommand ──
  npm: {
    effect: 'exec', subDefault: 'exec',
    sub: {
      install: 'network', i: 'network', add: 'network', ci: 'network',
      update: 'network', publish: 'dangerous', link: 'network', audit: 'network',
      run: 'exec', test: 'exec', exec: 'exec', start: 'exec', ls: 'read',
      view: 'network', version: 'read', why: 'read',
    },
  },
  pnpm: {
    effect: 'exec', subDefault: 'exec',
    sub: {
      install: 'network', i: 'network', add: 'network', update: 'network',
      publish: 'dangerous', dlx: 'network', audit: 'network',
      run: 'exec', test: 'exec', exec: 'exec', build: 'exec', start: 'exec',
      list: 'read', ls: 'read', why: 'read', licenses: 'read',
    },
  },
  yarn: { effect: 'exec', subDefault: 'exec', sub: { add: 'network', install: 'network', publish: 'dangerous', run: 'exec', test: 'exec' } },
  bun: { effect: 'exec', subDefault: 'exec', sub: { add: 'network', install: 'network', run: 'exec', test: 'exec' } },
  cargo: { effect: 'exec', subDefault: 'exec', sub: { build: 'exec', test: 'exec', check: 'exec', clippy: 'exec', fmt: 'write', publish: 'dangerous', add: 'network', update: 'network', install: 'network' } },
  go: { effect: 'exec', subDefault: 'exec', sub: { build: 'exec', test: 'exec', vet: 'exec', fmt: 'write', get: 'network', install: 'network', mod: 'network' } },
  pip: { effect: 'network', subDefault: 'network', sub: { list: 'read', show: 'read', freeze: 'read' } },
  pip3: { effect: 'network', subDefault: 'network', sub: { list: 'read', show: 'read', freeze: 'read' } },
  make: { effect: 'exec' },
  cmake: { effect: 'exec' },
  ninja: { effect: 'exec' },
  tsc: { effect: 'exec' },
  eslint: { effect: 'exec', writeFlags: ['--fix'] },
  prettier: { effect: 'exec', writeFlags: ['-w', '--write'] },
  pytest: { effect: 'exec' },
  vitest: { effect: 'exec' },
  jest: { effect: 'exec' },
  vale: { effect: 'exec' },
  pandoc: { effect: 'exec', outFlags: ['-o', '--output'] },

  // ── Network ──
  curl: { effect: 'network', outFlags: ['-o', '--output'] },
  wget: { effect: 'network', outFlags: ['-O', '--output-document'] },
  ssh: { effect: 'network' },
  scp: { effect: 'network' },
  sftp: { effect: 'network' },
  rsync: { effect: 'network' },
  nc: { effect: 'network' },
  netcat: { effect: 'network' },
  telnet: { effect: 'network' },
  ftp: { effect: 'network' },
  gh: { effect: 'network', subDefault: 'network', sub: { release: 'dangerous' } },
  glab: { effect: 'network' },
  aws: { effect: 'network' },
  gcloud: { effect: 'network' },
  az: { effect: 'network' },
  docker: { effect: 'dangerous' },
  podman: { effect: 'dangerous' },
  kubectl: { effect: 'dangerous' },

  // ── Never waved through, at any autonomy level ──
  sudo: { effect: 'dangerous' },
  su: { effect: 'dangerous' },
  doas: { effect: 'dangerous' },
  chmod: { effect: 'dangerous', argsArePaths: true, argsAreWrites: true },
  chown: { effect: 'dangerous', argsArePaths: true, argsAreWrites: true },
  chgrp: { effect: 'dangerous', argsArePaths: true, argsAreWrites: true },
  dd: { effect: 'dangerous' },
  mkfs: { effect: 'dangerous' },
  fdisk: { effect: 'dangerous' },
  mount: { effect: 'dangerous' },
  umount: { effect: 'dangerous' },
  shutdown: { effect: 'dangerous' },
  reboot: { effect: 'dangerous' },
  halt: { effect: 'dangerous' },
  poweroff: { effect: 'dangerous' },
  systemctl: { effect: 'dangerous' },
  service: { effect: 'dangerous' },
  launchctl: { effect: 'dangerous' },
  crontab: { effect: 'dangerous' },
  at: { effect: 'dangerous' },
  kill: { effect: 'dangerous' },
  killall: { effect: 'dangerous' },
  pkill: { effect: 'dangerous' },
  useradd: { effect: 'dangerous' },
  usermod: { effect: 'dangerous' },
  passwd: { effect: 'dangerous' },
  visudo: { effect: 'dangerous' },
  iptables: { effect: 'dangerous' },
  nft: { effect: 'dangerous' },
};

/**
 * Programs that carry no weight in a decision. Naming one of these in a
 * permission dialog tells the user nothing about what the line does.
 */
const TRIVIAL_PROGRAMS = new Set(['cd', 'echo', 'printf', 'pwd', 'true', 'false', ':']);

/** Programs that run whatever they are handed, so their payload is opaque. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'fish', 'csh', 'tcsh',
  'python', 'python2', 'python3', 'node', 'deno', 'perl', 'ruby', 'php', 'lua',
  'osascript', 'powershell', 'pwsh', 'cmd',
]);

/** Flags that make an interpreter take its program from the command line. */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-E', '--command']);

/** Wrappers that run another program; the real command is further along. */
const WRAPPERS = new Set([
  'nohup', 'setsid', 'time', 'nice', 'ionice', 'stdbuf', 'command', 'builtin', 'exec',
]);

/**
 * Paths that no autonomy level writes without asking, wherever they sit.
 *
 * ExternalProjectRegistry has its own `ALWAYS_PROTECTED` for project-relative
 * guards. This list is about absolute locations that hold credentials, and it
 * applies to reads as well: a command that reads a private key is not a
 * read-only command in any useful sense.
 */
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
  /(^|\/)credentials$/,
  /^\/etc\/(passwd|shadow|sudoers)/,
];

export function isSensitivePath(p: string): boolean {
  const normalized = p.split(path.sep).join('/');
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(normalized));
}

// ═══════════════════════════════════════════════════════════════════════
// Lexing
// ═══════════════════════════════════════════════════════════════════════

interface Word {
  text: string;
  /** Set when the word contained an unexpanded `$VAR` or `${VAR}`. */
  hasVariable: boolean;
  /** Set when the word was written entirely inside single quotes. */
  fullyQuoted: boolean;
}

type Item =
  | { kind: 'word'; word: Word }
  | { kind: 'op'; op: string }
  | { kind: 'redirect'; op: string; target?: Word };

interface LexResult {
  items: Item[];
  opaqueReason?: string;
}

/**
 * Reduce a command line to words, control operators, and redirections.
 *
 * Anything that would make the reduction a guess sets `opaqueReason` and the
 * caller stops trusting the result for auto-approval. The lexer keeps going so
 * the dialog can still show a best-effort breakdown.
 */
function lex(input: string): LexResult {
  const items: Item[] = [];
  let opaqueReason: string | undefined;
  const noteOpaque = (reason: string) => { if (!opaqueReason) opaqueReason = reason; };

  let buf = '';
  let hasVariable = false;
  let sawQuote = false;
  let sawUnquoted = false;
  let quote: '' | "'" | '"' = '';
  let pendingRedirect: string | undefined;

  const flushWord = () => {
    if (buf === '' && !sawQuote) return;
    const word: Word = { text: buf, hasVariable, fullyQuoted: sawQuote && !sawUnquoted };
    if (pendingRedirect) {
      items.push({ kind: 'redirect', op: pendingRedirect, target: word });
      pendingRedirect = undefined;
    } else {
      items.push({ kind: 'word', word });
    }
    buf = ''; hasVariable = false; sawQuote = false; sawUnquoted = false;
  };

  const pushOp = (op: string) => {
    flushWord();
    if (pendingRedirect) { items.push({ kind: 'redirect', op: pendingRedirect }); pendingRedirect = undefined; }
    items.push({ kind: 'op', op });
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    const next = input[i + 1];

    if (quote === "'") {
      if (c === "'") { quote = ''; continue; }
      buf += c;
      continue;
    }

    if (quote === '"') {
      if (c === '\\' && next !== undefined && '$`"\\'.includes(next)) { buf += next; i++; continue; }
      if (c === '"') { quote = ''; continue; }
      if (c === '$' && next === '(') { noteOpaque('command substitution'); }
      if (c === '`') { noteOpaque('command substitution'); }
      if (c === '$') { hasVariable = true; }
      buf += c;
      continue;
    }

    // Unquoted from here down.
    if (c === '\\') {
      if (next !== undefined) { buf += next; sawUnquoted = true; i++; }
      continue;
    }
    if (c === "'") { quote = "'"; sawQuote = true; continue; }
    if (c === '"') { quote = '"'; sawQuote = true; continue; }

    if (c === '$' && next === '(') { noteOpaque('command substitution'); buf += c; sawUnquoted = true; continue; }
    if (c === '`') { noteOpaque('command substitution'); buf += c; sawUnquoted = true; continue; }
    if ((c === '<' || c === '>') && next === '(') { noteOpaque('process substitution'); buf += c; sawUnquoted = true; continue; }
    if (c === '$') { hasVariable = true; buf += c; sawUnquoted = true; continue; }

    if (c === ' ' || c === '\t') { flushWord(); continue; }
    if (c === '\n' || c === '\r') { pushOp('\n'); continue; }

    if (c === '&' && next === '&') { pushOp('&&'); i++; continue; }
    if (c === '|' && next === '|') { pushOp('||'); i++; continue; }
    if (c === '|' && next === '&') { pushOp('|'); i++; continue; }
    if (c === '|') { pushOp('|'); continue; }
    if (c === ';') { pushOp(';'); continue; }
    if (c === '(' || c === ')') { pushOp(c); continue; }

    if (c === '&' && next === '>') {
      flushWord(); pendingRedirect = '&>'; i++;
      if (input[i + 1] === '>') i++;
      continue;
    }
    if (c === '&') { pushOp(';'); continue; }

    if (c === '>' || c === '<') {
      // A file-descriptor prefix (`2>`) lexes as a word; fold it back in.
      const fd = /^[0-9]$/.test(buf) ? buf : '';
      if (fd) buf = '';
      flushWord();
      let op = fd + c;
      if (c === '>' && next === '>') { op = fd + '>>'; i++; }
      else if (c === '<' && next === '<') {
        // A heredoc body is data. Skipping to its terminator keeps the command
        // in front of it readable: `cat > f.txt <<EOF` is an ordinary write,
        // and treating it as opaque would prompt on every file an agent writes.
        op = fd + '<<';
        i++;
        if (input[i + 1] === '<') { i++; continue; }  // <<< is a here-string
        const rest = input.slice(i + 1);
        const m = /^\s*-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(rest);
        if (m) {
          const delimiter = m[2];
          const bodyStart = i + 1 + m[0].length;
          const end = findHeredocEnd(input, bodyStart, delimiter);
          if (end < 0) { noteOpaque('unterminated heredoc'); i = input.length; }
          else { i = end - 1; }
          pendingRedirect = undefined;
          continue;
        }
        noteOpaque('heredoc');
      }
      pendingRedirect = op;
      continue;
    }

    buf += c;
    sawUnquoted = true;
  }

  if (quote !== '') noteOpaque('unterminated quote');
  flushWord();
  if (pendingRedirect) items.push({ kind: 'redirect', op: pendingRedirect });

  return { items, opaqueReason };
}

// ═══════════════════════════════════════════════════════════════════════
// Classification
// ═══════════════════════════════════════════════════════════════════════

/**
 * Where a heredoc body ends: the first line that is exactly the delimiter.
 * Returns the index just past that line, or -1 when it never terminates.
 */
function findHeredocEnd(input: string, from: number, delimiter: string): number {
  let lineStart = input.indexOf('\n', from);
  if (lineStart < 0) return -1;
  lineStart += 1;
  while (lineStart <= input.length) {
    let lineEnd = input.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = input.length;
    if (input.slice(lineStart, lineEnd).trim() === delimiter) return lineEnd;
    if (lineEnd >= input.length) return -1;
    lineStart = lineEnd + 1;
  }
  return -1;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Step past everything that is not yet the program: environment assignments,
 * an `env` prefix, and wrappers that exist to run something else.
 *
 * `sudo` is deliberately not stepped through. It is not a wrapper for
 * permission purposes, it is the thing being asked about.
 */
function findProgram(words: Word[]): { index: number; program: string } {
  let i = 0;
  while (i < words.length) {
    const t = words[i].text;
    if (ASSIGNMENT.test(t)) { i++; continue; }
    const base = path.basename(t);
    if (base === 'env' || base === '/usr/bin/env') {
      i++;
      while (i < words.length && ASSIGNMENT.test(words[i].text)) i++;
      continue;
    }
    if (WRAPPERS.has(base)) {
      i++;
      // `timeout 30 cmd` and `nice -n 5 cmd` carry a value before the program.
      while (i < words.length && words[i].text.startsWith('-')) i++;
      continue;
    }
    if (base === 'timeout') {
      i++;
      while (i < words.length && words[i].text.startsWith('-')) i++;
      if (i < words.length) i++;  // the duration
      continue;
    }
    if (base === 'xargs') {
      i++;
      // xargs flags that take a value, so the value is not mistaken for the
      // program it is about to run.
      const valued = new Set(['-n', '-P', '-I', '-d', '-a', '-E', '-L', '-s', '--max-args', '--max-procs', '--replace', '--delimiter']);
      while (i < words.length && words[i].text.startsWith('-')) {
        const flag = words[i].text.split('=')[0];
        i++;
        if (valued.has(flag) && !words[i - 1].text.includes('=')) i++;
      }
      continue;
    }
    break;
  }
  const raw = words[i]?.text ?? '';
  return { index: i, program: path.basename(raw) || raw };
}

/** Whether a word looks like something we should try to resolve as a path. */
function isPathCandidate(w: Word): boolean {
  const t = w.text;
  if (t === '' || t === '-') return false;
  if (t.startsWith('-')) return false;
  return true;
}

function resolveTouched(w: Word, cwd?: string): TouchedPath {
  const raw = w.text;
  if (w.hasVariable) return { raw, unresolved: true };
  try {
    if (raw.startsWith('~')) return { raw, resolved: expandHome(raw) };
    if (path.isAbsolute(raw)) return { raw, resolved: path.resolve(raw) };
    if (!cwd) return { raw, unresolved: true };
    return { raw, resolved: path.resolve(cwd, raw) };
  } catch {
    return { raw, unresolved: true };
  }
}

/** Classify one command, given its words and its redirections. */
function classifySegment(
  words: Word[],
  redirects: Array<{ op: string; target?: Word }>,
  cwd: string | undefined,
  pipedInto: boolean,
  noteOpaque: (reason: string) => void,
): Segment {
  const { index, program } = findProgram(words);
  const argv = words.slice(index + 1).map(w => w.text);
  const argWords = words.slice(index + 1);

  const reads: TouchedPath[] = [];
  const writes: TouchedPath[] = [];

  let redirectWrite = false;
  for (const r of redirects) {
    if (r.op.includes('<')) {
      if (r.target) reads.push(resolveTouched(r.target, cwd));
      continue;
    }
    // `echo hi > notes.txt` is a write even though `echo` is not.
    redirectWrite = true;
    if (r.target) writes.push(resolveTouched(r.target, cwd));
  }

  if (program === '') {
    return { program: '', argv, effect: 'read', reason: 'no command', reads, writes };
  }

  // An interpreter handed inline code, or fed by a pipe, runs something this
  // module cannot see. That is the classic `curl … | sh` shape.
  if (INTERPRETERS.has(program)) {
    const inline = argWords.some(w => INLINE_CODE_FLAGS.has(w.text));
    if (inline || pipedInto || argWords.length === 0) {
      noteOpaque(pipedInto ? 'pipe into an interpreter' : 'inline interpreter code');
      return {
        program, argv, effect: 'dangerous',
        reason: pipedInto ? 'runs whatever it is piped' : 'runs inline code',
        reads, writes,
      };
    }
  }

  if (program === 'eval' || program === 'source' || program === '.') {
    noteOpaque(`\`${program}\` runs text as code`);
    return { program, argv, effect: 'dangerous', reason: 'runs text as code', reads, writes };
  }

  const rule = PROGRAMS[program];
  if (!rule) {
    // Unknown is not safe. It is `exec`, which prompts, rather than `read`.
    for (const w of argWords) {
      if (isPathCandidate(w) && looksPathish(w.text)) reads.push(resolveTouched(w, cwd));
    }
    return { program, argv, effect: 'exec', reason: 'not a known program', reads, writes };
  }

  let effect = rule.effect;
  let reason = `${program} is ${rule.effect}`;
  if (redirectWrite) { effect = maxEffect(effect, 'write'); reason = `${program} redirects into a file`; }

  // Subcommand-driven programs (`git`, `pnpm`).
  if (rule.sub) {
    const subWord = argWords.find(w => !w.text.startsWith('-'));
    const sub = subWord?.text;
    if (sub && rule.sub[sub]) {
      effect = rule.sub[sub];
      reason = `${program} ${sub} is ${effect}`;
    } else if (rule.subDefault) {
      effect = rule.subDefault;
      reason = sub ? `${program} ${sub} is not a known subcommand` : `${program} with no subcommand`;
    }
  }

  const flagSet = new Set(argWords.map(w => w.text.split('=')[0]));
  let argsAreWrites = rule.argsAreWrites ?? false;
  if (rule.writeFlags?.some(f => flagSet.has(f))) {
    effect = maxEffect(effect, 'write');
    reason = `${program} writes in place`;
    // `sed -i file` edits the file it would otherwise have only read.
    argsAreWrites = true;
  }
  if (rule.dangerFlags?.some(f => flagSet.has(f))) {
    effect = maxEffect(effect, 'dangerous');
    reason = `${program} runs or deletes via ${rule.dangerFlags.find(f => flagSet.has(f))}`;
  }

  // Flags whose value is a file being written.
  if (rule.outFlags) {
    for (let i = 0; i < argWords.length; i++) {
      const t = argWords[i].text;
      const eq = t.indexOf('=');
      const flag = eq > 0 ? t.slice(0, eq) : t;
      if (!rule.outFlags.includes(flag)) continue;
      if (eq > 0) writes.push(resolveTouched({ ...argWords[i], text: t.slice(eq + 1) }, cwd));
      else if (argWords[i + 1]) { writes.push(resolveTouched(argWords[i + 1], cwd)); i++; }
    }
  }

  if (rule.argsArePaths) {
    let skipped = 0;
    for (let i = 0; i < argWords.length; i++) {
      const w = argWords[i];
      // A flag that takes a value swallows the next word, so `-name '*.ts'`
      // does not leave a phantom path in the report.
      if (w.text.startsWith('-') && rule.dangerFlags?.includes(w.text.split('=')[0])
          && (w.text === '-exec' || w.text === '-execdir' || w.text === '-ok' || w.text === '-okdir')) {
        // Everything past `-exec` is the command find will run, not a path.
        break;
      }
      if (w.text.startsWith('-') && rule.valuedFlags?.includes(w.text.split('=')[0])) {
        if (!w.text.includes('=')) i++;
        continue;
      }
      if (!isPathCandidate(w)) continue;
      if (skipped < (rule.skipArgs ?? 0)) { skipped++; continue; }
      const touched = resolveTouched(w, cwd);
      if (argsAreWrites) writes.push(touched);
      else reads.push(touched);
    }
  }

  // A writer taking its targets from a pipe (`find … | xargs rm`) writes to
  // paths that are not on this command line at all. Unknown targets are never
  // contained, so this stays a question for the user.
  if (pipedInto && effectRank(effect) >= effectRank('write') && writes.length === 0) {
    writes.push({ raw: `<paths piped into ${program}>`, unresolved: true });
  }

  // Reading a private key is not a read-only operation in any useful sense.
  const sensitive = [...reads, ...writes].find(
    t => (t.resolved && isSensitivePath(t.resolved)) || isSensitivePath(t.raw));
  if (sensitive) {
    effect = maxEffect(effect, 'dangerous');
    reason = `touches ${sensitive.raw}`;
  }

  // `rm -rf` aimed at a root, a home directory, or an unresolvable target.
  if ((program === 'rm' || program === 'rmdir') && isRecursiveForce(argWords)) {
    const wild = writes.find(t => t.unresolved || (t.resolved && isTopLevelish(t.resolved)));
    if (wild) {
      effect = 'dangerous';
      reason = `recursive delete of ${wild.raw}`;
    }
  }

  return { program, argv, effect, reason, reads, writes };
}

function isRecursiveForce(argWords: Word[]): boolean {
  return argWords.some(w => /^-[a-zA-Z]*r/i.test(w.text) || w.text === '--recursive');
}

/** A path close enough to the root of something that deleting it is a mistake. */
function isTopLevelish(p: string): boolean {
  const segments = p.split(path.sep).filter(Boolean);
  return segments.length <= 2;
}

/** Whether a bare word is worth resolving as a path at all. */
function looksPathish(t: string): boolean {
  return t.includes('/') || t.startsWith('~') || t.startsWith('.') || /\.[A-Za-z0-9]{1,6}$/.test(t);
}

// ═══════════════════════════════════════════════════════════════════════
// The entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Analyze a command line.
 *
 * @param command the line as it would be handed to a shell
 * @param opts.cwd where it will run, so relative paths can be resolved. Without
 *        one, every relative path is `unresolved`, which means uncontained,
 *        which means it will not auto-approve.
 */
export function analyzeCommand(
  command: string,
  opts: { cwd?: string } = {},
): CommandAnalysis {
  contractRequire(typeof command === 'string', 'command must be a string');

  const { items, opaqueReason: lexOpaque } = lex(command);
  let opaqueReason = lexOpaque;
  const noteOpaque = (reason: string) => { if (!opaqueReason) opaqueReason = reason; };

  const segments: Segment[] = [];
  let words: Word[] = [];
  let redirects: Array<{ op: string; target?: Word }> = [];
  let pipedInto = false;
  let nextPipedInto = false;

  const closeSegment = () => {
    if (words.length > 0 || redirects.length > 0) {
      segments.push(classifySegment(words, redirects, opts.cwd, pipedInto, noteOpaque));
    }
    words = [];
    redirects = [];
    pipedInto = nextPipedInto;
    nextPipedInto = false;
  };

  for (const item of items) {
    if (item.kind === 'word') { words.push(item.word); continue; }
    if (item.kind === 'redirect') { redirects.push({ op: item.op, target: item.target }); continue; }
    if (item.op === '|') { nextPipedInto = true; closeSegment(); continue; }
    closeSegment();
  }
  closeSegment();

  const programs: string[] = [];
  for (const s of segments) {
    if (s.program && !programs.includes(s.program)) programs.push(s.program);
  }

  let effect: EffectClass = 'read';
  let principal: Segment | undefined;
  for (const s of segments) {
    if (!principal) { principal = s; }
    else if (effectRank(s.effect) > effectRank(principal.effect)) { principal = s; }
    else if (effectRank(s.effect) === effectRank(principal.effect)
             && TRIVIAL_PROGRAMS.has(principal.program) && !TRIVIAL_PROGRAMS.has(s.program)) {
      // Offering to block `cd` was the old dialog's mistake. On a tie, name the
      // program the user would recognise as doing the work.
      principal = s;
    }
    effect = maxEffect(effect, s.effect);
  }

  const reads = segments.flatMap(s => s.reads);
  const writes = segments.flatMap(s => s.writes);

  // An opaque line could be doing anything, so it is never below `exec`.
  if (opaqueReason) effect = maxEffect(effect, 'exec');

  const dangerReason = effect === 'dangerous'
    ? (principal ? `${principal.program}: ${principal.reason}` : 'dangerous command')
    : undefined;

  return {
    segments,
    effect,
    programs,
    principalProgram: principal?.program ?? programs[0] ?? '',
    opaque: !!opaqueReason,
    opaqueReason,
    reads,
    writes,
    dangerReason,
  };
}

/**
 * Whether every path the command touches lies inside one of `roots`.
 *
 * An unresolved path never counts as contained: not knowing where something
 * points is not the same as knowing it is safe.
 */
export function checkContainment(
  analysis: CommandAnalysis,
  roots: readonly string[],
): ContainmentResult {
  const escapes: TouchedPath[] = [];
  for (const t of [...analysis.reads, ...analysis.writes]) {
    if (t.unresolved || !t.resolved) { escapes.push(t); continue; }
    if (!roots.some(r => isInside(r, t.resolved!))) escapes.push(t);
  }
  return { contained: escapes.length === 0, escapes };
}

/**
 * Which of the command's writes hit a protected path.
 *
 * `protectedPaths` are project-relative, in the shape ExternalProjectRegistry
 * stores them: a trailing slash means a directory, a bare name matches at any
 * depth (`.env`), and anything else is an exact relative path.
 */
export function protectedWrites(
  analysis: CommandAnalysis,
  root: string,
  protectedPaths: readonly string[],
): TouchedPath[] {
  const hits: TouchedPath[] = [];
  for (const t of analysis.writes) {
    if (!t.resolved) { continue; }
    if (isSensitivePath(t.resolved)) { hits.push(t); continue; }
    if (!isInside(root, t.resolved)) continue;
    const rel = path.relative(root, t.resolved).split(path.sep).join('/');
    for (const guard of protectedPaths) {
      const g = guard.split(path.sep).join('/');
      const hit = g.endsWith('/')
        ? rel === g.slice(0, -1) || rel.startsWith(g)
        : rel === g || path.posix.basename(rel) === g;
      if (hit) { hits.push(t); break; }
    }
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════════════
// Presentation
// ═══════════════════════════════════════════════════════════════════════

const SECRETISH = /^(?:sk-|pk-|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|glpat-)/;

/**
 * Blank out anything that looks like a credential.
 *
 * Applied before a command reaches a dialog, a log, or the stored rule set.
 * `TOKEN=abc123 curl …` is an ordinary shape for an agent to emit, and the old
 * `accept_always` path stored that line verbatim and then rendered it in a
 * Settings list.
 */
export function redactCommand(command: string): string {
  return command
    // NAME=value where the name says it holds a credential. The leading class
    // is optional on purpose: a bare `TOKEN=` has nothing in front of it.
    .replace(/([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|APIKEY|AUTH)[A-Za-z0-9_]*)=(\S+)/g,
      (_m, name: string) => `${name}=***`)
    // `--token value` and `--token=value`. No \b here: the boundary between a
    // space and a dash is not a word boundary, so it would never fire.
    .replace(/(^|\s)(--?(?:token|password|passwd|secret|api[-_]?key|auth)[A-Za-z-]*)(=|\s+)(\S+)/gi,
      (_m, lead: string, flag: string, sep: string) => `${lead}${flag}${sep}***`)
    // Anything shaped like a known credential, wherever it appears.
    .split(/(\s+)/)
    .map(part => (SECRETISH.test(part) && part.length >= 16 ? '***' : part))
    .join('');
}

/**
 * Whether an environment variable's NAME says it holds a credential.
 *
 * Used to strip secrets from commands that ran without a human seeing them.
 * Matching on the name rather than the value keeps a toolchain working: PATH,
 * HOME and NODE_OPTIONS survive, an API key does not.
 */
export function isCredentialVarName(name: string): boolean {
  return /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_AUTH|SESSION|COOKIE|PRIVATE)/i.test(name)
    // A few names carry keys without saying so.
    || /^(AWS_|GH_|GITHUB_|NPM_|OPENAI|ANTHROPIC|GOOGLE_|AZURE_)/i.test(name);
}

/** A short, human-readable account of what the line does, for the dialog. */
export function describeAnalysis(analysis: CommandAnalysis, root?: string): {
  programs: string;
  effect: string;
  reads: string;
  writes: string;
  note?: string;
} {
  const rel = (t: TouchedPath): string => {
    if (t.unresolved || !t.resolved) return `${t.raw} (unresolved)`;
    if (root && isInside(root, t.resolved)) return path.relative(root, t.resolved) || '.';
    return t.resolved;
  };
  const list = (ts: TouchedPath[]): string => {
    const seen: string[] = [];
    for (const t of ts) {
      const s = rel(t);
      if (!seen.includes(s)) seen.push(s);
    }
    if (seen.length === 0) return 'nothing';
    if (seen.length <= 4) return seen.join(', ');
    return `${seen.slice(0, 4).join(', ')} and ${seen.length - 4} more`;
  };

  return {
    programs: analysis.programs.join(', ') || '(none)',
    effect: analysis.effect === 'read' ? 'read-only' : analysis.effect,
    reads: list(analysis.reads),
    writes: list(analysis.writes),
    note: analysis.opaqueReason
      ? `Cannot be read with confidence: ${analysis.opaqueReason}`
      : analysis.dangerReason,
  };
}
