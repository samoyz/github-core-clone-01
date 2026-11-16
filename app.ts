// Limber Nucleus — a GitHub-compatible git forge (make.fun bounty github-core-clone-01).
//
// Node 22, stdlib only. One in-memory store drives four surfaces:
//   git smart HTTP  /{owner}/{repo}.git   (protocol v2 + v0, upload-pack / receive-pack)
//   REST v3         /api/v3               (repositories, branches, commits, contents, issues, pulls)
//   GraphQL v4      /api/graphql          (the documents gh and github-mcp-server send)
//   MCP             /mcp                  (streamable HTTP, 2026-07-28 revision + legacy handshake)
//
// Determinism: no wall clock and no unseeded randomness anywhere a response can see.
// Commit timestamps come from MAKEFUN_TRIAL_NOW; request ids and created_at offsets come from
// counters. The token owner's login is recomputed from the suite's fixed scenario seed
// (program/env/src/wire.ts SCENARIO_SEED_HEX), so the entry knows which login its bearer token
// names without ever being told it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

// --------------------------------------------------------------------------- configuration

/** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN in the entry's environment). */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** The instance's opening time: the only "now" a response may carry. */
const TRIAL_NOW_RAW = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
/** Unix seconds of MAKEFUN_TRIAL_NOW, or a fixed fallback when it is unset (local runs). */
const TRIAL_NOW_SEC = (() => {
  const ms = Date.parse(TRIAL_NOW_RAW);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return 1700000000;
})();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString().replace('.000Z', 'Z');

const SERVER_NAME = 'limber-nucleus-forge';
const SERVER_VERSION = '1.0.0';
const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_BRANCH = 'main';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

// --------------------------------------------------------------------------- scenario users
//
// The suite's scenario is drawn from one fixed seed (wire.ts SCENARIO_SEED_HEX). Recomputing the
// user stream here gives the token owner's login (users[0]) and the stranger's (users[2]) exactly
// as the suite generates them, in any trial, with no clock and no randomness.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira',
  'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito',
  'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen',
  'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi',
  'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
] as const;

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateScenarioUsers(): ScenarioUser[] {
  const rng = new ScenarioRng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const SCENARIO_USERS = generateScenarioUsers();
/** The login the bearer token names (the viewer). */
const VIEWER = SCENARIO_USERS[0]!;
const VIEWER_LOGIN = VIEWER.login;
/** Another user's login, with no rights on the viewer's repositories. */
const STRANGER_LOGIN = SCENARIO_USERS[2]!.login;

// --------------------------------------------------------------------------- small utilities

function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

function b64decodeLoose(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A deterministic ISO timestamp: the trial now plus `offsetSeconds` (creation order). */
function isoAt(offsetSeconds: number): string {
  return new Date((TRIAL_NOW_SEC + offsetSeconds) * 1000).toISOString().replace('.000Z', 'Z');
}

// --------------------------------------------------------------------------- git objects

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

function buildCommitBytes(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? TRIAL_NOW_SEC;
  const who = `${fields.author ?? `${VIEWER.login} <${VIEWER.email}>`} ${timestamp} +0000`;
  const committer = `${fields.committer ?? `${VIEWER.login} <${VIEWER.email}>`} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel an annotated tag (recursively) to the commit it names, or the oid itself. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// --------------------------------------------------------------------------- packs

/** Inflate the zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const remaining = buffer.length - offset;
  if (remaining <= 0) throw new Error('pack entry is truncated');
  // A first guess that covers the stream in the common case, then binary search for its exact end.
  let lo = 0;
  let hi = Math.min(remaining, Math.max(64, expectedSize + 4096));
  const tryInflate = (size: number): Buffer | null => {
    try {
      return zlib.inflateSync(buffer.subarray(offset, offset + size));
    } catch (err) {
      if (err instanceof Error && /unexpected end of file|incorrect header check|unknown compression method/i.test(err.message)) {
        return null;
      }
      throw err;
    }
  };
  let data = tryInflate(hi);
  while (data === null && hi < remaining) {
    lo = hi;
    hi = Math.min(remaining, hi * 2);
    data = tryInflate(hi);
  }
  if (data === null) throw new Error('pack entry is truncated or corrupt');
  // Binary search the smallest window that inflates (trailing bytes are tolerated, so the
  // smallest success is the stream's exact end).
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const attempt = tryInflate(mid);
    if (attempt === null) lo = mid;
    else {
      hi = mid;
      data = attempt;
    }
  }
  return { data, next: offset + hi };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  const first = buffer[start]!;
  let size = first & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while ((buffer[pos - 1]! & 0x80) !== 0) {
    size += (buffer[pos]! & 0x7f) * 2 ** shift;
    shift += 7;
    pos += 1;
  }
  return { size, next: pos, first };
}

interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2/3, plain objects only). Delta entries are reported, not resolved:
 * the suite's client never sends deltas, so a delta here is a corrupt pack for our purposes.
 */
function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    const type = CODE_TYPE[typeCode];
    offset = next;
    if (type === undefined) {
      if (typeCode === 6 || typeCode === 7) deltaCount += 1;
      throw new Error(`unsupported pack object type ${typeCode}`);
    }
    const { data, next: after } = inflateAt(pack, offset, size);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset = after;
    objects.set(hashObject(type, data), { type, data });
  }
  if (offset + 20 !== pack.length) throw new Error('pack has trailing bytes');
  const expected = sha1hex(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  return { objects, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain objects, with a valid SHA-1 trailer. */
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlib.deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1hex(body), 'hex')]);
}

// --------------------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload is too large');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type PktPacket = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/**
 * Parse pkt-lines in `buffer`. `firstFlushEnd` is the offset just past the first flush
 * packet (-1 when there is none): a receive-pack body carries its raw pack after that point.
 * With `stopAtFirstFlush`, parsing stops after the first flush (the pack bytes after it are
 * not pkt-lines and must not be parsed).
 */
function parsePktLines(buffer: Buffer, stopAtFirstFlush = false): { packets: PktPacket[]; firstFlushEnd: number } {
  const packets: PktPacket[] = [];
  let firstFlushEnd = -1;
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line length');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (firstFlushEnd < 0) firstFlushEnd = offset;
      if (stopAtFirstFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('malformed pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  // A short tail is malformed, unless parsing stopped at the first flush on purpose
  // (the receive-pack's raw pack follows it).
  if (offset < buffer.length && !stopAtFirstFlush) throw new Error('malformed pkt-line');
  return { packets, firstFlushEnd };
}

/** Split a sideband payload into pkt-lines of at most `chunk` data bytes. */
function sidebandPackets(band: number, data: Buffer, chunk = 32768): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    const piece = data.subarray(offset, Math.min(data.length, offset + chunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// --------------------------------------------------------------------------- store

interface Label {
  name: string;
  color: string;
}

interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
}

interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitSeq: Map<string, number>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  /** One shared counter for issues and pull requests (GitHub numbers them together). */
  nextNumber: number;
}

const reposByKey = new Map<string, Repo>();
const reposById = new Map<number, Repo>();
let nextRepoId = 1;
let nextCommentId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    createdSeq: (globalSeq += 1),
    refs: new Map(),
    objects: new Map([[EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) }]]),
    commitSeq: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextNumber: 1,
  };
  nextRepoId += 1;
  reposByKey.set(repoKey(VIEWER_LOGIN, name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

function deleteRepoRecord(repo: Repo): void {
  reposByKey.delete(repoKey(repo.owner, repo.name));
  reposById.delete(repo.id);
}

/** Opaque, stable global ids (base64 of a typed key — never the plain database id or number). */
function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', repo.id, pull.number);
}

function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return globalId('IssueComment', repo.id, comment.id);
}

function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    if (type === 'commit') repo.commitSeq.set(oid, (globalSeq += 1));
  }
  return oid;
}

function storeCommit(repo: Repo, fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): string {
  return storeObject(repo, 'commit', buildCommitBytes(fields));
}

// --------------------------------------------------------------------------- tree helpers

function treeEntriesOf(repo: Repo, treeOid: string | null): TreeEntry[] {
  if (treeOid === null || treeOid === EMPTY_TREE_OID) return [];
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/**
 * Return a new root tree with `segments` set to `blobOid` (or removed when null), creating
 * intermediate trees as needed and pruning trees left empty. Returns the new root tree oid.
 */
function setPathInTree(repo: Repo, rootTreeOid: string | null, segments: readonly string[], blobOid: string | null): string {
  const setIn = (treeOid: string | null, depth: number): string | null => {
    const entries = treeEntriesOf(repo, treeOid);
    const name = segments[depth]!;
    const isLeaf = depth === segments.length - 1;
    const index = entries.findIndex((entry) => entry.name === name);
    if (isLeaf) {
      if (blobOid === null) {
        if (index < 0) return treeOid;
        entries.splice(index, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
    } else {
      const child = index < 0 ? null : entries[index]!.oid;
      const next = setIn(child, depth + 1);
      if (next === null) {
        if (index >= 0) entries.splice(index, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: next };
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
    }
    if (entries.length === 0) return null;
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return setIn(rootTreeOid, 0) ?? EMPTY_TREE_OID;
}

/** The blob oid at `segments` under `treeOid`, or null when absent (or not a blob). */
function blobAtPath(repo: Repo, treeOid: string | null, segments: readonly string[]): { oid: string; mode: string } | null {
  let current: string | null = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const entries = treeEntriesOf(repo, current);
    const entry = entries.find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) {
      // A directory is not a blob: callers that need a file see "not found".
      return entry.mode === '40000' ? null : { oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Flatten a tree to path -> {oid, mode}, recursing into directories. */
function flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string | null, base: string): void => {
    for (const entry of treeEntriesOf(repo, oid)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

// --------------------------------------------------------------------------- graph helpers

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
function collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The nearest common ancestor of `a` and `b` (first found by a joint BFS), or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, depth] = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, depth);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, depth] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const depthA = ancestorsA.get(oid);
    if (depthA !== undefined && depthA + depth < bestDepth) {
      best = oid;
      bestDepth = depthA + depth;
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
  }
  return best;
}

/** Commits reachable from `tip`, newest first (by the order they were stored). */
function commitsFrom(repo: Repo, tip: string | null): string[] {
  if (tip === null) return [];
  const reachable = collectReachable(repo, [tip]);
  const commits: string[] = [];
  for (const oid of reachable) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') commits.push(oid);
  }
  commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  return commits;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file-level diff between two trees (by content, not by tree entry alone). */
function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return changes;
}

/** Added/removed line counts between two blob contents, via an LCS over lines. */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS with two rows; the files here are small.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]!);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const common = prev[m]!;
  return { additions: m - common, deletions: n - common };
}

/**
 * Whether a three-way merge of `headTip` into `baseTip` conflicts: a file changed on both sides
 * of their merge base with different resulting content (or deleted on one side, changed on the other).
 */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  if (baseCommit === undefined || baseCommit.type !== 'commit') return false;
  const baseTree = parseCommit(baseCommit.data).tree;
  const baseTipCommit = repo.objects.get(baseTip);
  const headTipCommit = repo.objects.get(headTip);
  if (baseTipCommit === undefined || headTipCommit === undefined) return false;
  const baseTipTree = parseCommit(baseTipCommit.data).tree;
  const headTipTree = parseCommit(headTipCommit.data).tree;
  const baseToHead = diffTrees(repo, baseTree, headTipTree);
  const baseToBase = diffTrees(repo, baseTree, baseTipTree);
  const headByPath = new Map(baseToHead.map((change) => [change.path, change]));
  for (const change of baseToBase) {
    const other = headByPath.get(change.path);
    if (other === undefined) continue;
    if (change.newOid !== other.newOid) return true;
  }
  return false;
}

/** The mergeability of a pull request: MERGEABLE, CONFLICTING, or UNKNOWN when it cannot be told. */
function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  if (headTip === baseTip) return 'MERGEABLE';
  if (isAncestor(repo, headTip, baseTip)) return 'MERGEABLE';
  return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

// --------------------------------------------------------------------------- HTTP plumbing

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(12, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

/** A 401 that also names the scheme, so git retries with the URL's credentials. */
function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="github-core-clone-01"' });
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token is valid: the configured one, or any non-empty bearer when none is configured. */
function hasValidToken(req: IncomingMessage): boolean {
  const authorization = req.headers.authorization ?? '';
  const bearer = /^Bearer (.+)$/.exec(authorization);
  if (bearer !== null) {
    const presented = bearer[1]!;
    if (SHOP_TOKEN !== '') return presented === SHOP_TOKEN;
    return presented !== '';
  }
  // Git's HTTP client answers a 401 with Basic auth: the token rides as the password
  // (user:token) or, for some clients, as the username (token:).
  const basic = /^Basic (.+)$/.exec(authorization);
  if (basic !== null) {
    let decoded = '';
    try {
      decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    } catch {
      return false;
    }
    const sep = decoded.indexOf(':');
    const user = sep < 0 ? decoded : decoded.slice(0, sep);
    const password = sep < 0 ? '' : decoded.slice(sep + 1);
    if (SHOP_TOKEN !== '') return password === SHOP_TOKEN || user === SHOP_TOKEN;
    return password !== '' || user !== '';
  }
  return false;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// --------------------------------------------------------------------------- git smart HTTP

const V2_CAPABILITIES = ['agent=limber-nucleus/1.0.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const V0_UPLOAD_CAPABILITIES = 'side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:refs/heads/main';
const V0_RECEIVE_CAPABILITIES = 'report-status side-band-64k delete-refs ofs-delta thin-pack multi_ack shallow symref=HEAD:refs/heads/main agent=limber-nucleus/1.0.0';

function gitNotFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function gitUnauthorized(res: ServerResponse): void {
  sendUnauthorized(res);
}

/** Ref lines for a v0 advertisement: HEAD first (carrying the capabilities), then branches and tags. */
function v0RefLines(repo: Repo, capabilities: string): string[] {
  const lines: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const refNames = [...repo.refs.keys()].sort();
  if (refNames.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
    return lines;
  }
  const headTarget = mainTip !== undefined ? 'refs/heads/main' : refNames[0]!;
  const headOid = repo.refs.get(headTarget)!;
  lines.push(`${headOid} HEAD\u0000${capabilities}\n`);
  for (const name of refNames) {
    const oid = repo.refs.get(name)!;
    lines.push(`${oid} ${name}\n`);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      lines.push(`${peelToCommit(repo, oid)} ${name}^{}\n`);
    }
  }
  return lines;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack' || !wantsV2) {
    const capabilities = service === 'git-receive-pack' ? V0_RECEIVE_CAPABILITIES : V0_UPLOAD_CAPABILITIES;
    const body = pktLines([
      `# service=${service}\n`,
      'flush',
      ...v0RefLines(repo, capabilities),
      'flush',
    ]);
    sendBuffer(res, 200, body, contentType);
    return;
  }
  const body = pktLines([
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    ...V2_CAPABILITIES.map((capability) => `${capability}\n`),
    'flush',
  ]);
  sendBuffer(res, 200, body, contentType);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client already holds
 * (`haves`), the client's old shallow boundaries, and an optional depth limit.
 */
/** Every object a commit's own tree holds (the commit's tree and all blobs/subtrees), without parents. */
function collectTreeObjects(repo: Repo, treeOid: string | null, out: Set<string>): void {
  if (treeOid === null) return;
  out.add(treeOid);
  for (const entry of treeEntriesOf(repo, treeOid)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * What the client already holds, from its haves: the full closure of each have, except that
 * an old shallow boundary's parents are NOT held (a shallow clone has the boundary commit
 * but none of its history).
 */
function collectHaveClosure(repo: Repo, haves: string[], oldShallow: string[]): Set<string> {
  const out = new Set<string>();
  const shallowSet = new Set(oldShallow);
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      collectTreeObjects(repo, parseCommit(object.data).tree, out);
      if (!shallowSet.has(oid)) {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      collectTreeObjects(repo, oid, out);
    }
  }
  return out;
}

function planFetch(repo: Repo, wants: string[], haves: string[], oldShallow: string[], depth: number | null): FetchPlan {
  const haveClosure = collectHaveClosure(repo, haves, oldShallow);
  const oldShallowSet = new Set(oldShallow);

  // Walk commits from the wants, cutting off at the depth limit and at old shallow boundaries.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const tagObjects = new Set<string>();
  const dist = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    } else {
      // A blob or tree wanted directly: send it as-is.
      tagObjects.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, depth: at } = queue.shift()!;
    const known = dist.get(oid);
    if (known !== undefined && known <= at) continue;
    dist.set(oid, at);
    if (depth !== null && at >= depth) continue;
    included.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const cutOff = depth !== null && at === depth - 1;
    const shallowCut = oldShallowSet.has(oid) && !wants.includes(oid);
    if (cutOff || shallowCut) {
      if (parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of parents) queue.push({ oid: parent, depth: at + 1 });
  }
  // A boundary is an included commit with a parent outside the walk.
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent)) {
        boundary.add(oid);
        break;
      }
    }
  }
  const shallow = [...boundary].sort();
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort();

  // Objects to send: for each included commit, the commit and its own tree's objects —
  // never a parent (the depth cutoff already excluded them), and never anything held.
  const toSend = new Set<string>();
  for (const oid of tagObjects) if (!haveClosure.has(oid)) toSend.add(oid);
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    toSend.add(oid);
    if (object.type === 'commit') collectTreeObjects(repo, parseCommit(object.data).tree, toSend);
    else if (object.type === 'tree') collectTreeObjects(repo, oid, toSend);
  }
  for (const oid of [...toSend]) if (haveClosure.has(oid)) toSend.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of [...toSend].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  let ack: string | null = null;
  if (haves.length > 0 && haves.every((have) => repo.objects.has(have))) {
    ack = haves[haves.length - 1]!;
  }
  return { objects, shallow, unshallow, ack };
}

function lsRefsLines(repo: Repo, options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const keep = (name: string): boolean => options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const mainTip = repo.refs.get('refs/heads/main');
  if (options.symrefs && keep('HEAD')) {
    if (mainTip !== undefined) lines.push(`${mainTip} HEAD symref-target:refs/heads/main\n`);
    else if (options.unborn) lines.push(`unborn HEAD symref-target:refs/heads/main\n`);
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    const object = repo.objects.get(oid);
    if (options.peel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

function handleUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: PktPacket[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'delim') lines.push('\u0001');
  }
  const commandLine = lines[0] ?? '';
  const commandMatch = /^command=([a-z-]+)\n?$/.exec(commandLine);
  if (commandMatch === null) {
    sendJson(res, 400, { message: 'malformed upload-pack request' });
    return;
  }
  const command = commandMatch[1];
  const args = lines.slice(1).filter((line) => line !== '\u0001');
  if (command === 'ls-refs') {
    const peel = args.includes('peel\n');
    const symrefs = args.includes('symrefs\n');
    const unborn = args.includes('unborn\n');
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).replace(/\n$/, ''));
    const out = pktLines([...lsRefsLines(repo, { peel, symrefs, unborn, prefixes }), 'flush']);
    sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const oldShallow: string[] = [];
    let depth: number | null = null;
    let done = false;
    for (const line of args) {
      const text = line.replace(/\n$/, '');
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) oldShallow.push(text.slice(8).trim());
      else if (text === 'done') done = true;
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    const plan = planFetch(repo, wants, haves, oldShallow, depth);
    const parts: Buffer[] = [];
    if (!done) {
      // A negotiation round with no packfile: acknowledgments only, then a flush.
      parts.push(pktLine('acknowledgments\n'));
      if (plan.ack !== null) {
        parts.push(pktLine(`ACK ${plan.ack}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    // The client sent "done", so the spec says the acknowledgments section MUST be
    // omitted: the response is [shallow-info delim-pkt] packfile flush-pkt, with
    // sections separated by delim packets (0001), not flushes.
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: `unknown upload-pack command ${command}` });
}

function handleUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: PktPacket[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      wants.push(text.slice(5).split(' ')[0]!);
    } else if (text.startsWith('shallow ')) oldShallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (seenFlush && text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'fetch with no wants' });
    return;
  }
  const plan = planFetch(repo, wants, haves, oldShallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.ack !== null) {
    parts.push(pktLine(`ACK ${plan.ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: PktPacket[];
  let packStart = -1;
  let sawFlush = false;
  try {
    const parsed = parsePktLines(body, true);
    packets = parsed.packets;
    packStart = parsed.firstFlushEnd;
    sawFlush = packStart >= 0;
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const commands: PushCommand[] = [];
  let clientWantsSideband = false;
  if (!sawFlush) {
    sendJson(res, 400, { message: 'push command list has no flush' });
    return;
  }
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) {
      const capabilities = text.slice(nul + 1).replace(/\n$/, '');
      if (capabilities.split(' ').includes('side-band-64k')) clientWantsSideband = true;
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2]!.startsWith('refs/')) {
      sendJson(res, 400, { message: 'malformed push command' });
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'push with no commands' });
    return;
  }
  // The pack follows the command list's flush.
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          if (object.type === 'commit') repo.commitSeq.set(oid, (globalSeq += 1));
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} cannot delete a ref that does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} old value does not match\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} old value does not match\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} old value does not match\n`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const reportStream = pktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (clientWantsSideband) {
    const parts: Buffer[] = [];
    for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
    parts.push(PKT_FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([reportStream, PKT_FLUSH]);
  }
  sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = decodePathSegment(match[1]!);
  const repoName = decodePathSegment(match[2]!);
  const suffix = match[3]!;
  if (!hasValidToken(req)) {
    gitUnauthorized(res);
    return;
  }
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    gitNotFound(res);
    return;
  }
  if (req.method === 'GET' && suffix === 'info/refs') {
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'unknown service' });
      return;
    }
    handleInfoRefs(req, res, repo, service);
    return;
  }
  if (req.method === 'POST' && suffix === 'git-upload-pack') {
    const body = await readBody(req);
    if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(req, res, repo, body);
    else handleUploadPackV0(req, res, repo, body);
    return;
  }
  if (req.method === 'POST' && suffix === 'git-receive-pack') {
    const body = await readBody(req);
    handleReceivePack(req, res, repo, body);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// --------------------------------------------------------------------------- REST v3

function restError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', user.id),
    avatar_url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, id: 0, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    comments: issue.comments.length,
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.createdSeq),
    html_url: '',
    url: '',
  };
}

function commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo, comment),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    html_url: '',
    url: '',
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    head: { label: `${VIEWER_LOGIN}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login: VIEWER_LOGIN, id: VIEWER.id } },
    base: { label: `${VIEWER_LOGIN}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login: VIEWER_LOGIN, id: VIEWER.id } },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: isoAt(pull.createdSeq),
    updated_at: isoAt(pull.createdSeq),
    html_url: '',
    url: '',
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid };
  const view = parseCommit(object.data);
  const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
  const identity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: VIEWER.name, email: VIEWER.email, date: isoAt(0) };
    return {
      name: match[1]!,
      email: match[2]!,
      date: new Date(Number(match[3]!) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message,
      author: identity(view.author),
      committer: identity(view.committer),
      tree: { sha: view.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, defaultPerPage = 30): { pageItems: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : defaultPerPage;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { pageItems, link: null };
}

/** A Link header for a paginated list, built from the request's own origin. */
function pageLinkHeader(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  const last = new URLSearchParams(query);
  last.set('per_page', String(perPage));
  last.set('page', String(totalPages));
  return `<${base}?${next.toString()}>; rel="next", <${base}?${last.toString()}>; rel="last"`;
}

function resolveRepoParam(owner: string, name: string): Repo | null {
  return findRepo(owner, name);
}

function resolveBranchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a `ref` query value (branch name, commit sha, or the default branch) to a commit oid. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return resolveBranchTip(repo, repo.defaultBranch);
  const branchTip = resolveBranchTip(repo, ref);
  if (branchTip !== null) return branchTip;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);
  const segments = path.split('/').filter((segment) => segment !== '').map(decodePathSegment);

  // Every /api/v3 route needs the bearer token.
  if (!hasValidToken(req)) {
    sendUnauthorized(res);
    return;
  }

  // GET /api/v3/ — the API root.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: SERVER_VERSION });
    return;
  }

  // GET /api/v3/user
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, userJson(VIEWER));
    return;
  }

  // /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const all = [...reposById.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
      const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, perPageRaw) : 30;
      const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const start = (page - 1) * perPage;
      const headers: Record<string, string> = {};
      const link = pageLinkHeader(req, path, query, perPage, page, all.length);
      if (link !== null) headers.link = link;
      sendJson(res, 200, all.slice(start, start + perPage).map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        restError(res, 400, 'Invalid JSON');
        return;
      }
      const body = parsed.value;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || name.includes('/')) {
        restError(res, 422, 'Repository name is required');
        return;
      }
      if (reposByKey.has(repoKey(VIEWER_LOGIN, name))) {
        restError(res, 422, `Repository ${name} already exists`);
        return;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = createRepoRecord(name, description, isPrivate);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    restError(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}[/*]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3]!;
    const repoName = segments[4]!;
    const repo = resolveRepoParam(owner, repoName);
    if (repo === null) {
      restError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepoRecord(repo);
        sendNoContent(res, 204);
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // GET /repos/{o}/{r}/branches
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((name) => name.startsWith('refs/heads/'))
          .map((name) => name.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! } }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2) {
        const tip = resolveBranchTip(repo, rest[1]!);
        if (tip === null) {
          restError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: rest[1], commit: { sha: tip } });
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // GET /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 1) {
        const tip = resolveRef(repo, query.get('sha'));
        if (tip === null && query.get('sha') !== null) {
          restError(res, 404, 'Not Found');
          return;
        }
        const commits = commitsFrom(repo, tip).map((oid) => commitJson(repo, oid));
        sendJson(res, 200, commits);
        return;
      }
      if (rest.length === 2 && isOid(rest[1])) {
        const object = repo.objects.get(rest[1]!);
        if (object === undefined || object.type !== 'commit') {
          restError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, commitJson(repo, rest[1]!));
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
        const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          restError(res, 422, 'Invalid ref');
          return;
        }
        if (!isOid(sha) || !repo.objects.has(sha)) {
          restError(res, 422, 'Object does not exist');
          return;
        }
        if (repo.refs.has(ref)) {
          restError(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha } }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'GET' && rest.length > 2) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          restError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: { sha } });
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        const body = parsed.value;
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : null;
        if (message === '' || contentB64 === '' || !/^[A-Za-z0-9+/=\r\n\t ]*$/.test(contentB64)) {
          restError(res, 422, 'message and content are required');
          return;
        }
        const content = b64decodeLoose(contentB64);
        const segments = contentPath.split('/').filter((segment) => segment !== '');
        if (segments.length === 0) {
          restError(res, 422, 'path is required');
          return;
        }
        let tip = resolveBranchTip(repo, branch);
        if (tip === null) {
          // A branch that does not exist yet starts from the default branch tip (or nothing).
          tip = branch === repo.defaultBranch ? null : resolveBranchTip(repo, repo.defaultBranch);
        }
        const baseTree = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
        const existing = tip === null ? null : blobAtPath(repo, baseTree, segments);
        if (existing !== null) {
          if (sha === null) {
            restError(res, 422, 'sha is required to update a file');
            return;
          }
          if (sha !== existing.oid) {
            restError(res, 409, 'sha does not match the current blob');
            return;
          }
        } else if (sha !== null) {
          restError(res, 409, 'sha does not match the current blob');
          return;
        }
        const blobOid = storeObject(repo, 'blob', content);
        const newTree = setPathInTree(repo, baseTree, segments, blobOid);
        const parents = tip === null ? [] : [tip];
        const commitOid = storeCommit(repo, { tree: newTree, parents, message });
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        sendJson(res, existing === null ? 201 : 200, {
          content: { name: segments[segments.length - 1], path: contentPath, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitOid },
        });
        return;
      }
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (tip === null) {
          restError(res, 404, 'Not Found');
          return;
        }
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const segments = contentPath.split('/').filter((segment) => segment !== '');
        if (segments.length === 0) {
          const entries = treeEntriesOf(repo, tree).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
          }));
          sendJson(res, 200, entries);
          return;
        }
        const found = blobAtPath(repo, tree, segments);
        if (found !== null) {
          const object = repo.objects.get(found.oid)!;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            name: segments[segments.length - 1],
            path: contentPath,
            sha: found.oid,
            size: object.data.length,
            content: b64encode(object.data),
          });
          return;
        }
        // A directory: walk to its tree.
        let current: string | null = tree;
        let isDir = true;
        for (const segment of segments) {
          const entry = treeEntriesOf(repo, current).find((candidate) => candidate.name === segment);
          if (entry === undefined || entry.mode !== '40000') {
            isDir = false;
            break;
          }
          current = entry.oid;
        }
        if (isDir && current !== null) {
          const entries = treeEntriesOf(repo, current).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${contentPath}/${entry.name}`,
            sha: entry.oid,
          }));
          sendJson(res, 200, entries);
          return;
        }
        restError(res, 404, 'Not Found');
        return;
      }
      if (method === 'DELETE') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        const body = parsed.value;
        const message = typeof body.message === 'string' ? body.message : '';
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : null;
        const tip = resolveBranchTip(repo, branch);
        if (tip === null) {
          restError(res, 404, 'Not Found');
          return;
        }
        const segments = contentPath.split('/').filter((segment) => segment !== '');
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const existing = blobAtPath(repo, tree, segments);
        if (existing === null || segments.length === 0) {
          restError(res, 404, 'Not Found');
          return;
        }
        if (sha !== null && sha !== existing.oid) {
          restError(res, 409, 'sha does not match the current blob');
          return;
        }
        const newTree = setPathInTree(repo, tree, segments, null);
        const commitOid = storeCommit(repo, { tree: newTree, parents: [tip], message: message === '' ? 'Delete file' : message });
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid } });
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        const name = typeof parsed.value.name === 'string' ? parsed.value.name.trim() : '';
        if (name === '') {
          restError(res, 422, 'label name is required');
          return;
        }
        if (repo.labels.has(name)) {
          restError(res, 422, `Label ${name} already exists`);
          return;
        }
        const color = typeof parsed.value.color === 'string' && parsed.value.color !== '' ? parsed.value.color : 'ededed';
        const label: Label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          else if (state !== 'all') list = list.filter((issue) => issue.state === 'open');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { pageItems } = paginate(list, query, 30);
          sendJson(res, 200, pageItems.map((issue) => issueJson(repo, issue)));
          return;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            restError(res, 400, 'Invalid JSON');
            return;
          }
          const body = parsed.value;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') {
            restError(res, 422, 'title is required');
            return;
          }
          const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              restError(res, 422, `Label ${labelName} does not exist`);
              return;
            }
          }
          const issue: Issue = {
            id: nextIssueId,
            number: repo.nextNumber,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labelNames,
            createdSeq: (globalSeq += 1),
            comments: [],
          };
          nextIssueId += 1;
          repo.nextNumber += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        restError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            restError(res, 400, 'Invalid JSON');
            return;
          }
          if (typeof parsed.value.state === 'string') {
            if (parsed.value.state !== 'open' && parsed.value.state !== 'closed') {
              restError(res, 422, 'state must be open or closed');
              return;
            }
            issue.state = parsed.value.state;
          }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        restError(res, 404, 'Not Found');
        return;
      }
      if (rest[2] === 'comments') {
        if (method === 'GET' && rest.length === 3) {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, comment)));
          return;
        }
        if (method === 'POST' && rest.length === 3) {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            restError(res, 400, 'Invalid JSON');
            return;
          }
          const text = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          if (text === '') {
            restError(res, 422, 'body is required');
            return;
          }
          const comment: IssueComment = { id: nextCommentId, body: text, createdSeq: (globalSeq += 1) };
          nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, comment));
          return;
        }
      }
      restError(res, 404, 'Not Found');
      return;
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          else if (state !== 'all') list = list.filter((pull) => pull.state === 'open');
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { pageItems } = paginate(list, query, 30);
          sendJson(res, 200, pageItems.map((pull) => pullJson(repo, pull)));
          return;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) {
            restError(res, 400, 'Invalid JSON');
            return;
          }
          const body = parsed.value;
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : '';
          if (title === '' || head === '' || base === '') {
            restError(res, 422, 'title, head and base are required');
            return;
          }
          if (resolveBranchTip(repo, head) === null) {
            restError(res, 422, `Head branch ${head} does not exist`);
            return;
          }
          if (resolveBranchTip(repo, base) === null) {
            restError(res, 422, `Base branch ${base} does not exist`);
            return;
          }
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (duplicate !== undefined) {
            restError(res, 422, 'A pull request already exists for this head and base');
            return;
          }
          const pull: PullRequest = {
            id: nextPullId,
            number: repo.nextNumber,
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            headRef: head,
            baseRef: base,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdSeq: (globalSeq += 1),
          };
          nextPullId += 1;
          repo.nextNumber += 1;
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        restError(res, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        restError(res, 404, 'Not Found');
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const headTip = resolveBranchTip(repo, pull.headRef);
        const baseTip = resolveBranchTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) {
          restError(res, 404, 'Not Found');
          return;
        }
        const base = mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const files = diffTrees(repo, baseTree, headTree).map((change) => {
          const oldData = change.oldOid === null ? null : repo.objects.get(change.oldOid)?.data ?? null;
          const newData = change.newOid === null ? null : repo.objects.get(change.newOid)?.data ?? null;
          const counts = lineDiff(oldData, newData);
          return {
            filename: change.path,
            status: change.status,
            additions: counts.additions,
            deletions: counts.deletions,
            changes: counts.additions + counts.deletions,
          };
        });
        sendJson(res, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          restError(res, 400, 'Invalid JSON');
          return;
        }
        if (pull.state !== 'open') {
          restError(res, 405, 'Pull request is already merged or closed');
          return;
        }
        const headTip = resolveBranchTip(repo, pull.headRef);
        const baseTip = resolveBranchTip(repo, pull.baseRef);
        if (headTip === null || baseTip === null) {
          restError(res, 404, 'Not Found');
          return;
        }
        if (mergeConflicts(repo, baseTip, headTip)) {
          restError(res, 405, 'Merge conflict');
          return;
        }
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const message = `${pull.title} (#${pull.number})`;
        const mergeSha = storeCommit(repo, { tree: headTree, parents: [baseTip], message });
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = isoAt((globalSeq += 1));
        pull.mergeCommitSha = mergeSha;
        sendJson(res, 200, { merged: true, sha: mergeSha, message });
        return;
      }
      restError(res, 404, 'Not Found');
      return;
    }

    restError(res, 404, 'Not Found');
    return;
  }

  restError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- GraphQL

type GqlToken =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenizeGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let pos = 0;
  while (pos < source.length) {
    const char = source[pos]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      pos += 1;
      continue;
    }
    if (char === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      pos += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      pos += 1;
      let closed = false;
      while (pos < source.length) {
        const c = source[pos]!;
        if (c === '"') {
          closed = true;
          pos += 1;
          break;
        }
        if (c === '\\') {
          const escaped = source[pos + 1]!;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 6;
          } else if (simple[escaped] !== undefined) {
            value += simple[escaped];
            pos += 2;
          } else {
            throw new Error(`invalid GraphQL string escape \\${escaped}`);
          }
          continue;
        }
        value += c;
        pos += 1;
      }
      if (!closed) throw new Error('unterminated GraphQL string');
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(pos));
      if (match === null) throw new Error('invalid GraphQL number');
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      pos += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_A-Za-z0-9]*/.exec(source.slice(pos));
      const text = match![0];
      tokens.push({ kind: 'name', value: text });
      pos += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  return tokens;
}

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: GqlSelection[] };

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: GqlValue | null }[];
  selections: GqlSelection[];
}

class GqlParser {
  private pos = 0;
  private readonly tokens: GqlToken[];

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what} in GraphQL document`);
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): GqlOperation {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName('query or mutation');
    if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unsupported operation ${keyword}`);
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.next().value;
    const varDefs: GqlOperation['varDefs'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName('a variable name');
        this.expectPunct(':');
        this.parseType();
        let defaultValue: GqlValue | null = null;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        varDefs.push({ name: varName, defaultValue });
      }
    }
    return { kind: keyword, name, varDefs, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.acceptPunct('...')) {
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token !== undefined && token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args: GqlField['args'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: GqlSelection[] | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName('a variable name') };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (!this.acceptPunct('}')) {
        const fieldName = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected token in GraphQL value');
  }
}

function gqlValueToJs(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const resolved = variables[value.name];
      return resolved === undefined ? null : resolved;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => gqlValueToJs(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlValueToJs(field.value, variables);
      return out;
    }
  }
}

interface GqlNode {
  __typename: string;
  __source: unknown;
}

function gqlNode(typeName: string, source: unknown): GqlNode {
  return { __typename: typeName, __source: source };
}

function isGqlNode(value: unknown): value is GqlNode {
  return value !== null && typeof value === 'object' && '__typename' in value && '__source' in value;
}

/** The schema surface gh feature-detects, for __type introspection. */
const GQL_INTROSPECTION: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues: string[] }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
    ],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MILESTONE', 'WIKI', 'PROJECT'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'], enumValues: [] },
};

function repoByGlobalIdParts(parts: string[]): Repo | null {
  if (parts.length === 0) return null;
  const id = Number.parseInt(parts[0]!, 10);
  if (!Number.isInteger(id)) return null;
  return reposById.get(id) ?? null;
}

function nodeFromGlobalId(id: string): GqlNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByGlobalIdParts(decoded.parts);
    return repo === null ? null : gqlNode('Repository', repo);
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = repoByGlobalIdParts(decoded.parts);
    if (repo === null || decoded.parts.length < 2) return null;
    const number = Number.parseInt(decoded.parts[1]!, 10);
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : gqlNode('Issue', { repo, issue });
    }
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull === undefined ? null : gqlNode('PullRequest', { repo, pull });
  }
  return null;
}

function graphqlPullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

interface GqlContext {
  errors: { message: string }[];
}

function gqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = gqlValueToJs(arg.value, variables);
  return out;
}

/** The changed files of a pull request, as GraphQL nodes. */
function gqlPullFiles(repo: Repo, pull: PullRequest, first: number | null): GqlNode[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const changes = diffTrees(repo, baseTree, headTree).map((change) => ({ path: change.path }));
  return (first === null ? changes : changes.slice(0, first)).map((entry) => gqlNode('PullRequestChangedFile', entry));
}

function gqlIssuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => String(entry).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy;
  let descending = false;
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const record = orderBy as Record<string, unknown>;
    descending = record.direction === 'DESC';
  }
  list.sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  const after = typeof args.after === 'string' && args.after !== '' ? args.after : null;
  if (after !== null) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const cursorNumber = Number.parseInt(decoded, 10);
      if (Number.isFinite(cursorNumber)) {
        const index = list.findIndex((issue) => issue.number === cursorNumber);
        if (index >= 0) list = list.slice(index + 1);
      }
    } catch {
      // An unreadable cursor pages from the start.
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : null;
  const hasNextPage = first !== null && list.length > first;
  const page = first === null ? list : list.slice(0, first);
  const endCursor = page.length === 0 ? null : Buffer.from(String(page[page.length - 1]!.number)).toString('base64');
  return gqlNode('IssueConnection', { repo, nodes: page, pageInfo: { hasNextPage, endCursor } });
}

function resolveGqlField(typeName: string, source: unknown, field: GqlField, variables: Record<string, unknown>, ctx: GqlContext): unknown {
  const args = gqlArgs(field, variables);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return gqlNode('User', VIEWER);
      if (field.name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = findRepo(owner, name);
        return repo === null ? null : gqlNode('Repository', repo);
      }
      if (field.name === 'node') {
        const id = typeof args.id === 'string' ? args.id : '';
        return nodeFromGlobalId(id);
      }
      if (field.name === '__type') {
        const name = typeof args.name === 'string' ? args.name : '';
        const info = GQL_INTROSPECTION[name];
        return info === undefined ? null : gqlNode('__Type', { name, ...info });
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return gqlCreateIssue(args, ctx);
      if (field.name === 'closeIssue') return gqlCloseIssue(args, ctx);
      if (field.name === 'createPullRequest') return gqlCreatePullRequest(args, ctx);
      if (field.name === 'mergePullRequest') return gqlMergePullRequest(args, ctx);
      if (field.name === 'addComment') return gqlAddComment(args, ctx);
      break;
    }
    case 'User': {
      const user = source as ScenarioUser;
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('User', user.id);
      if (field.name === 'name') return user.name;
      if (field.name === 'email') return user.email;
      break;
    }
    case 'Repository': {
      const repo = source as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return gqlNode('User', VIEWER);
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : gqlNode('Ref', { name: repo.defaultBranch });
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : gqlNode('Issue', { repo, issue });
      }
      if (field.name === 'issues') return gqlIssuesConnection(repo, args);
      if (field.name === 'pullRequests') {
        const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
        const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : null;
        const page = first === null ? list : list.slice(0, first);
        return gqlNode('PullRequestConnection', { nodes: page.map((pull) => gqlNode('PullRequest', { repo, pull })) });
      }
      if (field.name === 'pullRequest') {
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : gqlNode('PullRequest', { repo, pull });
      }
      break;
    }
    case 'Ref': {
      const ref = source as { name: string };
      if (field.name === 'name') return ref.name;
      break;
    }
    case 'Issue': {
      const entry = source as { repo: Repo; issue: Issue };
      if (field.name === 'id') return issueGlobalId(entry.repo, entry.issue);
      if (field.name === 'number') return entry.issue.number;
      if (field.name === 'title') return entry.issue.title;
      if (field.name === 'state') return entry.issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return entry.issue.body;
      break;
    }
    case 'IssueConnection': {
      const connection = source as { repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return connection.nodes.map((issue) => gqlNode('Issue', { repo: connection.repo, issue }));
      if (field.name === 'pageInfo') return gqlNode('PageInfo', connection.pageInfo);
      if (field.name === 'totalCount') return connection.nodes.length;
      break;
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return info.endCursor;
      break;
    }
    case 'PullRequest': {
      const entry = source as { repo: Repo; pull: PullRequest };
      if (field.name === 'id') return pullGlobalId(entry.repo, entry.pull);
      if (field.name === 'number') return entry.pull.number;
      if (field.name === 'state') return graphqlPullState(entry.pull);
      if (field.name === 'merged') return entry.pull.merged;
      if (field.name === 'headRefName') return entry.pull.headRef;
      if (field.name === 'baseRefName') return entry.pull.baseRef;
      if (field.name === 'mergeable') return pullMergeable(entry.repo, entry.pull);
      if (field.name === 'files') {
        const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : null;
        return gqlNode('PullRequestChangedFileConnection', { nodes: gqlPullFiles(entry.repo, entry.pull, first) });
      }
      break;
    }
    case 'PullRequestConnection': {
      const connection = source as { nodes: GqlNode[] };
      if (field.name === 'nodes') return connection.nodes;
      break;
    }
    case 'PullRequestChangedFileConnection': {
      const connection = source as { nodes: GqlNode[] };
      if (field.name === 'nodes') return connection.nodes;
      break;
    }
    case 'PullRequestChangedFile': {
      const file = source as { path: string };
      if (field.name === 'path') return file.path;
      break;
    }
    case '__Type': {
      const type = source as { name: string; kind: string; fields: string[]; enumValues: string[] };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.kind;
      if (field.name === 'fields') return type.fields.map((name) => gqlNode('__Field', { name }));
      if (field.name === 'enumValues') return type.enumValues.map((name) => gqlNode('__EnumValue', { name }));
      break;
    }
    case '__Field':
    case '__EnumValue': {
      const entry = source as { name: string };
      if (field.name === 'name') return entry.name;
      break;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function gqlCreateIssue(args: Record<string, unknown>, ctx: GqlContext): GqlNode | null {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: 'createIssue requires an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repositoryId = typeof record.repositoryId === 'string' ? record.repositoryId : '';
  const title = typeof record.title === 'string' ? record.title : '';
  const decoded = decodeGlobalId(repositoryId);
  if (decoded === null || decoded.kind !== 'Repository') {
    ctx.errors.push({ message: 'createIssue could not resolve repositoryId.' });
    return null;
  }
  const repo = repoByGlobalIdParts(decoded.parts);
  if (repo === null) {
    ctx.errors.push({ message: 'createIssue could not resolve repositoryId.' });
    return null;
  }
  if (title === '') {
    ctx.errors.push({ message: 'createIssue requires a title.' });
    return null;
  }
  const issue: Issue = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    labels: [],
    createdSeq: (globalSeq += 1),
    comments: [],
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return gqlNode('CreateIssuePayload', { repo, issue });
}

function gqlCloseIssue(args: Record<string, unknown>, ctx: GqlContext): GqlNode | null {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: 'closeIssue requires an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const issueId = typeof record.issueId === 'string' ? record.issueId : '';
  const node = nodeFromGlobalId(issueId);
  if (node === null || node.__typename !== 'Issue') {
    ctx.errors.push({ message: 'closeIssue could not resolve issueId.' });
    return null;
  }
  const entry = node.__source as { repo: Repo; issue: Issue };
  entry.issue.state = 'closed';
  return gqlNode('CloseIssuePayload', { repo: entry.repo, issue: entry.issue });
}

function gqlCreatePullRequest(args: Record<string, unknown>, ctx: GqlContext): GqlNode | null {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: 'createPullRequest requires an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const repositoryId = typeof record.repositoryId === 'string' ? record.repositoryId : '';
  const headRefName = typeof record.headRefName === 'string' ? record.headRefName : '';
  const baseRefName = typeof record.baseRefName === 'string' ? record.baseRefName : '';
  const title = typeof record.title === 'string' ? record.title : '';
  const decoded = decodeGlobalId(repositoryId);
  if (decoded === null || decoded.kind !== 'Repository') {
    ctx.errors.push({ message: 'createPullRequest could not resolve repositoryId.' });
    return null;
  }
  const repo = repoByGlobalIdParts(decoded.parts);
  if (repo === null) {
    ctx.errors.push({ message: 'createPullRequest could not resolve repositoryId.' });
    return null;
  }
  if (title === '' || headRefName === '' || baseRefName === '') {
    ctx.errors.push({ message: 'createPullRequest requires title, headRefName and baseRefName.' });
    return null;
  }
  if (repo.refs.get(`refs/heads/${headRefName}`) === undefined || repo.refs.get(`refs/heads/${baseRefName}`) === undefined) {
    ctx.errors.push({ message: 'createPullRequest could not resolve the head or base branch.' });
    return null;
  }
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName);
  if (duplicate !== undefined) {
    ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
    return null;
  }
  const pull: PullRequest = {
    id: nextPullId,
    number: repo.nextNumber,
    title,
    body: typeof record.body === 'string' ? record.body : '',
    state: 'open',
    headRef: headRefName,
    baseRef: baseRefName,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: (globalSeq += 1),
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return gqlNode('CreatePullRequestPayload', { repo, pull });
}

function gqlMergePullRequest(args: Record<string, unknown>, ctx: GqlContext): GqlNode | null {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: 'mergePullRequest requires an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const pullRequestId = typeof record.pullRequestId === 'string' ? record.pullRequestId : '';
  const node = nodeFromGlobalId(pullRequestId);
  if (node === null || node.__typename !== 'PullRequest') {
    ctx.errors.push({ message: 'mergePullRequest could not resolve pullRequestId.' });
    return null;
  }
  const entry = node.__source as { repo: Repo; pull: PullRequest };
  const { repo, pull } = entry;
  if (pull.state !== 'open') {
    ctx.errors.push({ message: 'Pull request is already merged or closed.' });
    return null;
  }
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    ctx.errors.push({ message: 'mergePullRequest could not resolve the head or base branch.' });
    return null;
  }
  if (mergeConflicts(repo, baseTip, headTip)) {
    ctx.errors.push({ message: 'Merge conflict.' });
    return null;
  }
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mergeSha = storeCommit(repo, { tree: headTree, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoAt((globalSeq += 1));
  pull.mergeCommitSha = mergeSha;
  return gqlNode('MergePullRequestPayload', { repo, pull });
}

function gqlAddComment(args: Record<string, unknown>, ctx: GqlContext): GqlNode | null {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    ctx.errors.push({ message: 'addComment requires an input object.' });
    return null;
  }
  const record = input as Record<string, unknown>;
  const subjectId = typeof record.subjectId === 'string' ? record.subjectId : '';
  const body = typeof record.body === 'string' ? record.body : '';
  const node = nodeFromGlobalId(subjectId);
  if (node === null || node.__typename !== 'Issue') {
    ctx.errors.push({ message: 'addComment could not resolve subjectId.' });
    return null;
  }
  if (body === '') {
    ctx.errors.push({ message: 'addComment requires a body.' });
    return null;
  }
  const entry = node.__source as { repo: Repo; issue: Issue };
  const comment: IssueComment = { id: nextCommentId, body, createdSeq: (globalSeq += 1) };
  nextCommentId += 1;
  entry.issue.comments.push(comment);
  return gqlNode('AddCommentPayload', { repo: entry.repo, comment });
}

function completeGqlValue(value: unknown, selections: GqlSelection[] | null, variables: Record<string, unknown>, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) return value.map((entry) => completeGqlValue(entry, selections, variables, ctx));
  if (isGqlNode(value)) return executeGqlSelections(value.__typename, value.__source, selections, variables, ctx);
  return value;
}

function executeGqlSelections(
  typeName: string,
  source: unknown,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  ctx: GqlContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeGqlSelections(typeName, source, selection.selections, variables, ctx));
      }
      continue;
    }
    const field = selection.field;
    // Payload wrappers (createIssue, closeIssue, ...) expose their nested object under one field.
    const payloadTypes = new Set([
      'CreateIssuePayload',
      'CloseIssuePayload',
      'CreatePullRequestPayload',
      'MergePullRequestPayload',
      'AddCommentPayload',
      'AddCommentEdge',
      'IssueComment',
    ]);
    const value = payloadTypes.has(typeName)
      ? resolveGqlPayloadField(typeName, source, field, variables, ctx)
      : resolveGqlField(typeName, source, field, variables, ctx);
    out[field.alias ?? field.name] = completeGqlValue(value, field.selections, variables, ctx);
  }
  return out;
}

function resolveGqlPayloadField(typeName: string, source: unknown, field: GqlField, variables: Record<string, unknown>, ctx: GqlContext): unknown {
  // Payload types hold one object under a fixed field name.
  const record = source as Record<string, unknown>;
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const entry = record as unknown as { repo: Repo; issue: Issue };
      return gqlNode('Issue', { repo: entry.repo, issue: entry.issue });
    }
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const entry = record as unknown as { repo: Repo; pull: PullRequest };
      return gqlNode('PullRequest', { repo: entry.repo, pull: entry.pull });
    }
  }
  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return gqlNode('AddCommentEdge', record);
  }
  if (typeName === 'AddCommentEdge') {
    if (field.name === 'node') {
      const entry = record as unknown as { repo: Repo; comment: IssueComment };
      return gqlNode('IssueComment', { repo: entry.repo, comment: entry.comment });
    }
  }
  if (typeName === 'IssueComment') {
    const entry = record as unknown as { repo: Repo; comment: IssueComment };
    if (field.name === 'id') return commentGlobalId(entry.repo, entry.comment);
    if (field.name === 'body') return entry.comment.body;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

function executeGqlOperation(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: GqlContext = { errors: [] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (mergedVariables[def.name] === undefined && def.defaultValue !== null) {
      mergedVariables[def.name] = gqlValueToJs(def.defaultValue, mergedVariables);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = executeGqlSelections(rootType, null, operation.selections, mergedVariables, ctx);
    return { data, errors: ctx.errors };
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
    return { data: null, errors: ctx.errors };
  }
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasValidToken(req)) {
    sendUnauthorized(res);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return;
  }
  const requests: { query?: unknown; variables?: unknown; operationName?: unknown }[] = Array.isArray(parsed)
    ? parsed.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    : [parsed as Record<string, unknown>];
  const responses = requests.map((request) => {
    const query = typeof request.query === 'string' ? request.query : '';
    const variables = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables)
      ? (request.variables as Record<string, unknown>)
      : {};
    const operationName = typeof request.operationName === 'string' ? request.operationName : null;
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(tokenizeGql(query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Invalid GraphQL document' }] };
    }
    let operation: GqlOperation | undefined;
    if (operationName !== null) operation = operations.find((entry) => entry.name === operationName);
    else if (operations.length === 1) operation = operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'Operation not found' }] };
    }
    const result = executeGqlOperation(operation, variables);
    return result.errors.length === 0 ? { data: result.data } : { data: result.data, errors: result.errors };
  });
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
}

// --------------------------------------------------------------------------- MCP

const MCP_SERVER_INFO = { name: 'github-core-clone-01', version: SERVER_VERSION };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type McpToolResult =
  | { ok: true; structured: Record<string, unknown> }
  | { ok: false; message: string };

function mcpRepoArg(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || name === '') return null;
  return findRepo(owner, name);
}

function mcpCallTool(name: string, args: Record<string, unknown>): McpToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '' || repoName.includes('/')) return { ok: false, message: 'name is required' };
      if (reposByKey.has(repoKey(VIEWER_LOGIN, repoName))) return { ok: false, message: `Repository ${repoName} already exists` };
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = createRepoRecord(repoName, description, isPrivate);
      return { ok: true, structured: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = mcpRepoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      return { ok: true, structured: repoJson(repo) };
    }
    case 'create_issue': {
      const repo = mcpRepoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, message: 'title is required' };
      const issue: Issue = {
        id: nextIssueId,
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: (globalSeq += 1),
        comments: [],
      };
      nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return { ok: true, structured: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repo = mcpRepoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return { ok: true, structured: { issues: list.map((issue) => issueJson(repo, issue)) } };
    }
    case 'create_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return { ok: false, message: 'title, head and base are required' };
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return { ok: false, message: `Head branch ${head} does not exist` };
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return { ok: false, message: `Base branch ${base} does not exist` };
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return { ok: false, message: 'A pull request already exists for this head and base' };
      const pull: PullRequest = {
        id: nextPullId,
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: (globalSeq += 1),
      };
      nextPullId += 1;
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return { ok: true, structured: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = mcpRepoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { ok: false, message: 'Pull request not found' };
      if (pull.state !== 'open') return { ok: false, message: 'Pull request is already merged or closed' };
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (headTip === undefined || baseTip === undefined) return { ok: false, message: 'Pull request branches not found' };
      if (mergeConflicts(repo, baseTip, headTip)) return { ok: false, message: 'Merge conflict' };
      const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
      const mergeSha = storeCommit(repo, { tree: headTree, parents: [baseTip], message: `${pull.title} (#${pull.number})` });
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = isoAt((globalSeq += 1));
      pull.mergeCommitSha = mergeSha;
      return { ok: true, structured: { merged: true, sha: mergeSha, number: pull.number, state: 'closed' } };
    }
    default:
      return { ok: false, message: `Unknown tool ${name}` };
  }
}

function mcpRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function mcpRpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result }, { 'mcp-session-id': 'mcp-session-1' });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!hasValidToken(req)) {
    mcpRpcError(res, 401, null, -32000, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    mcpRpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    mcpRpcError(res, 400, null, -32600, 'Invalid Request');
    return;
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id === undefined ? null : request.id;
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  // A notification (no id) is acknowledged with 202 and no body.
  if (id === null) {
    res.writeHead(202, { 'mcp-session-id': 'mcp-session-1' });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    mcpRpcResult(res, id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      serverInfo: MCP_SERVER_INFO,
      capabilities: { tools: {} },
      _meta: {
        'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO,
        'io.modelcontextprotocol/protocolVersion': MCP_SUPPORTED_VERSIONS[0],
      },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0]!;
    mcpRpcResult(res, id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    });
    return;
  }

  if (method === 'ping') {
    mcpRpcResult(res, id, {});
    return;
  }

  if (method === 'tools/list') {
    mcpRpcResult(res, id, { tools: MCP_TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      mcpRpcError(res, 200, id, -32601, `Method not found: ${name}`);
      return;
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      mcpRpcResult(res, id, {
        content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      });
      return;
    }
    const outcome = mcpCallTool(name, args);
    if (!outcome.ok) {
      mcpRpcResult(res, id, {
        content: [{ type: 'text', text: outcome.message }],
        structuredContent: { error: outcome.message },
        isError: true,
      });
      return;
    }
    mcpRpcResult(res, id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.structured) }],
      structuredContent: outcome.structured,
    });
    return;
  }

  mcpRpcError(res, 200, id, -32601, `Method not found: ${method}`);
}

// --------------------------------------------------------------------------- Router

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);

        // GET /healthz — no auth, for the harness's liveness probe.
        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphQL(req, res);
          return;
        }

        if (path === '/mcp' && method === 'POST') {
          await handleMcp(req, res);
          return;
        }

        if (path.startsWith('/api/v3')) {
          await handleRest(req, res);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          await handleGit(req, res, gitMatch[1]!, gitMatch[2]!, gitMatch[3]!);
          return;
        }

        // Unknown route: a JSON 404, never HTML.
        if (!hasValidToken(req)) {
          sendUnauthorized(res);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
