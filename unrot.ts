#!/usr/bin/env -S bun --no-env-file
/**
 * unrot: the reels and posts you saved and never went back to, sorted into lists you'll use.
 *
 *   browser login ─► sync ─► SQLite (raw API JSON) ─► process (one model call per item) ─► export ─► lists/
 *
 * One file for Bun (https://bun.sh), no dependencies; ffmpeg is optional. The model comes from your
 * Claude Pro/Max or ChatGPT (Codex) subscription via OAuth, or from an OpenRouter API key.
 * Run `bun unrot.ts help`.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

// ── Default lists. Users tune them in their data folder (about.md, lists.json), never in this file. ──

type ListSpec = Record<string, [title: string, description: string]>;

/** Instagram: each saved post yields one or more entries, each filed under one of these lists. */
const DEFAULT_IG_LISTS: ListSpec = {
  ideas: ["Ideas & Thinking", "mental models, insights, advice, quotes, history/facts worth remembering"],
  movies_tv: ["Movies & TV", "movies, series, documentaries, anime to watch"],
  books: ["Books", "books, authors and long-form reads"],
  food: ["Food", "recipes to cook, restaurants / cafes / street food to try, specific dishes"],
  places: ["Places", "travel destinations, attractions, neighbourhoods, stays, location-bound experiences"],
  fitness: ["Fitness & Health", "workouts, exercises, mobility, posture, nutrition and health routines"],
  learning: ["Learning & Career", "courses, papers, resources and skills to learn for work or career"],
  art_design: ["Art, Design & DIY", "art pieces and artists, design, architecture, interiors, DIY/craft builds, style and hair inspiration"],
  products: ["Products & Tools", "things to buy or try: products, apps, software tools, gadgets"],
  music: ["Music", "songs, artists, albums to listen to"],
  howto: ["How-tos", "practical skills, tutorials and life hacks not covered by another list"],
  other: ["Other", "memes, humour, pure entertainment, anything that fits nowhere else"],
};
/** Instagram lists whose Markdown is grouped by city instead of being one flat list. */
const DEFAULT_IG_GROUP_BY_LOCATION = ["food", "places"];

/** X: why a bookmark was saved. One main intent, optionally up to two more. */
const DEFAULT_X_INTENTS: ListSpec = {
  product: ["Products to try", "a specific thing to try, use or buy: app, software tool, library or GitHub repo, AI model, service, gadget. Launch / 'introducing X' posts are products."],
  design: ["Design to reuse", "liked how something looks, moves or feels and might borrow it for their own work: UI, landing pages, components, typography, colour, animation and motion, illustration, visual effects, data viz, branding, physical spaces and objects."],
  read: ["Read or watch later", "long-form content whose value is beyond the post itself: articles, blog posts, papers, essays, books, long threads, X articles, talks, videos, podcasts."],
  learn: ["Learn and apply", "a concrete technique, tip, trick, code snippet, how-to or explanation to apply in their own work (a CSS trick, a prompting technique, a performance fix, a concept explained)."],
  idea: ["Ideas", "an insight, opinion, prediction, quote, mental model, or startup / project idea worth remembering; the post itself is the value."],
  other: ["Other", "news, memes and jokes, food and places, personal updates, anything with no clear reason to come back to."],
};
/** X: what a bookmark is about, for grouping inside each list. */
const DEFAULT_X_TOPICS: Record<string, string> = {
  ai: "AI & LLMs",
  engineering: "Software engineering",
  design: "Design",
  startups: "Startups & business",
  career: "Career & work",
  hardware: "Hardware & gadgets",
  science: "Science & math",
  money: "Money & markets",
  life: "Life & self",
  culture: "Culture & world",
  food_places: "Food & places",
  fun: "Humour & memes",
};

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────

const HOME = process.env.UNROT_HOME || join(homedir(), ".local/share/unrot");
loadDotenv(join(HOME, ".env"));
const AUTH_FILE = join(HOME, "auth.json");
const IG_DB = join(HOME, "instagram/reels.db");
const IG_MEDIA = join(HOME, "instagram/media");
const IG_OUT = join(HOME, "instagram/lists");
const X_DB = join(HOME, "x/bookmarks.db");
const X_OUT = join(HOME, "x/lists");

type Provider = "openrouter" | "claude" | "codex";
const PROVIDERS: Provider[] = ["openrouter", "claude", "codex"];
const DEFAULT_MODELS: Record<Provider, string> = {
  openrouter: "xiaomi/mimo-v2.6-flash", // open-weight; watches video with audio
  claude: "claude-haiku-5-5",
  codex: "gpt-6-luna",
};

/** The person in their own words: who they are and why they save things. Every prompt includes it. */
const ABOUT = existsSync(join(HOME, "about.md")) ? readFileSync(join(HOME, "about.md"), "utf8").trim() : "";
const { IG_LISTS, IG_GROUP_BY_LOCATION, X_INTENTS, X_TOPICS } = loadLists(join(HOME, "lists.json"));

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    process.env[line.slice(0, at).trim()] ??= line.slice(at + 1).trim().replace(/^["']+|["']+$/g, "");
  }
}

/**
 * The lists in use: the defaults, with whatever the user's lists.json replaces. Shape:
 * { "instagram": { "lists": { key: [title, description] }, "groupByLocation": [key] },
 *   "x": { "intents": { key: [title, description] }, "topics": { key: label } } }, every part optional.
 */
function loadLists(path: string) {
  const fail = (message: string): never => {
    process.stderr.write(`error: ${path}: ${message}\n`);
    process.exit(1);
  };
  let custom: unknown;
  if (existsSync(path)) {
    try {
      custom = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      fail(`not valid JSON (${err instanceof Error ? err.message : err})`);
    }
  }
  // `keyed`: the keys become file names and list ids, so keep them plain.
  const object = (value: unknown, what: string, keyed = false): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) fail(`${what} must be a non-empty object`);
    const record = value as Record<string, unknown>; // checked just above
    for (const key of keyed ? Object.keys(record) : []) {
      if (!/^[a-z][a-z0-9_]*$/.test(key)) fail(`${what}: key "${key}" must be lowercase letters, digits and _`);
    }
    return record;
  };
  const lists = (value: unknown, what: string): ListSpec | undefined => {
    const record = object(value, what, true);
    if (!record) return undefined;
    const spec: ListSpec = {};
    for (const [key, entry] of Object.entries(record)) {
      if (!Array.isArray(entry) || entry.length !== 2 || entry.some((s) => typeof s !== "string" || !s.trim())) {
        return fail(`${what}.${key} must be ["Title", "what belongs on it"]`);
      }
      spec[key] = [String(entry[0]), String(entry[1])];
    }
    return spec;
  };
  const root = object(custom, "the file") ?? {};
  const ig = object(root.instagram, "instagram") ?? {};
  const x = object(root.x, "x") ?? {};
  const igLists = lists(ig.lists, "instagram.lists") ?? DEFAULT_IG_LISTS;
  if (!igLists.other) fail('instagram.lists needs an "other" list for posts that fit nowhere else');
  const group = ig.groupByLocation ?? DEFAULT_IG_GROUP_BY_LOCATION.filter((key) => igLists[key]);
  if (!Array.isArray(group) || group.some((key) => typeof key !== "string" || !igLists[key])) {
    fail("instagram.groupByLocation must be an array of instagram list keys");
  }
  const topics: Record<string, string> = {};
  for (const [key, label] of Object.entries(object(x.topics, "x.topics", true) ?? DEFAULT_X_TOPICS)) {
    if (typeof label !== "string" || !label.trim()) fail(`x.topics.${key} must be a label`);
    topics[key] = String(label);
  }
  return {
    IG_LISTS: igLists,
    IG_GROUP_BY_LOCATION: Object.fromEntries((group as string[]).map((key) => [key, true])) as Record<string, true>,
    X_INTENTS: lists(x.intents, "x.intents") ?? DEFAULT_X_INTENTS,
    X_TOPICS: topics,
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────

/** An expected failure: printed as one line, without a stack trace. Stops a batch instead of failing one item. */
class Fatal extends Error {}
/** The model provider's usage limit was hit: stop the batch, unprocessed items stay pending. */
class QuotaError extends Fatal {}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly headers: Headers, what: string) {
    super(`${what} HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

const log = (message: string) => void process.stderr.write(`${message}\n`);
const sleep = (seconds: number) => Bun.sleep(seconds * 1000);
const pad = (n: number) => String(n).padStart(2, "0");
const nowSeconds = () => Math.floor(Date.now() / 1000);
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
const fold = (text: string) => squash(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " "));
const placeholders = (n: number) => Array(n).fill("?").join(",");
const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** Own-key membership in a lookup table; narrows `key` to a string. */
function has(record: object, key: unknown): key is string {
  return typeof key === "string" && Object.hasOwn(record, key);
}

/** A JSON object's fields (none for anything else), for reading model answers before validating them. */
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A response body read as `T`. Unchecked: every API shape here keeps its fields optional and is read with `?.`. */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function localDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local "YYYY-MM-DD HH:MM", now or `secondsFromNow` ahead. */
function clock(secondsFromNow = 0): string {
  const d = new Date(Date.now() + secondsFromNow * 1000);
  return `${localDay(d.getTime() / 1000)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openDb(path: string, schema: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL"); // sync and process can run side by side
  db.run("PRAGMA busy_timeout = 30000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(schema);
  return db;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  if (await proc.exited) throw new Error(`${cmd[0]} failed: ${(await new Response(proc.stderr).text()).trim().slice(0, 300)}`);
}

function sniffImage(data: Buffer): string | undefined {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (data.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Runs `work` over `items` with `workers` in flight; stops picking up new items once `stopped()`. */
async function pool<T>(items: T[], workers: number, work: (item: T) => Promise<void>, stopped: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
}

// ── Browser sessions: cookies from Firefox, Chromium-family browsers, or a cookies.txt ─────────────

type Cookies = Record<string, string>;
interface Session { cookies: Cookies; userAgent: string; source: string }
interface SessionOptions { browser?: string; profile?: string; cookies?: string }

const BROWSER_MAJOR = "160"; // used when the installed version can't be read
const CHROMIUM: Record<string, { mac: string; linux?: [dir: string, secretApp: string]; keychain: string }> = {
  chrome: { mac: "Google/Chrome", linux: ["google-chrome", "chrome"], keychain: "Chrome" },
  chromium: { mac: "Chromium", linux: ["chromium", "chromium"], keychain: "Chromium" },
  brave: { mac: "BraveSoftware/Brave-Browser", linux: ["BraveSoftware/Brave-Browser", "brave"], keychain: "Brave" },
  edge: { mac: "Microsoft Edge", linux: ["microsoft-edge", "microsoft-edge"], keychain: "Microsoft Edge" },
  vivaldi: { mac: "Vivaldi", linux: ["vivaldi", "vivaldi"], keychain: "Vivaldi" },
  arc: { mac: "Arc/User Data", keychain: "Arc" },
  dia: { mac: "Dia/User Data", keychain: "Dia" },
};

const cookieHosts = (domain: string) => [domain, `.${domain}`, `www.${domain}`];
const cookieHeader = (cookies: Cookies) => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

/** Reads a browser's SQLite file through a copy: browsers keep it locked while running. */
function withSnapshot<T>(file: string, read: (db: Database) => T): T {
  if (!existsSync(file)) throw new Fatal(`${file} not found`);
  const dir = mkdtempSync(join(tmpdir(), "unrot-"));
  try {
    const copy = join(dir, basename(file));
    copyFileSync(file, copy);
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
    const db = new Database(copy);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function firefoxRoot(): string {
  const home = homedir();
  const candidates = process.platform === "darwin" ? [join(home, "Library/Application Support/Firefox")]
    : process.platform === "win32" ? [join(process.env.APPDATA ?? home, "Mozilla/Firefox")]
    : [join(home, ".mozilla/firefox"), join(home, "snap/firefox/common/.mozilla/firefox"),
       join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox")];
  return candidates.find((dir) => existsSync(join(dir, "profiles.ini"))) ?? candidates[0]!;
}

function firefoxDefaultProfile(): string {
  const root = firefoxRoot();
  const ini = join(root, "profiles.ini");
  if (!existsSync(ini)) throw new Fatal(`no Firefox profiles in ${root}; pass --browser or --cookies`);
  const sections: [string, Record<string, string>][] = [];
  for (const raw of readFileSync(ini, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) sections.push([header[1]!, {}]);
    else if (line.includes("=") && sections.length) {
      const at = line.indexOf("=");
      sections.at(-1)![1][line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  // The profile this Firefox install launches, else the one marked default.
  const install = sections.find(([name, s]) => name.startsWith("Install") && s.Default);
  if (install) return join(root, install[1].Default!);
  const marked = sections.find(([, s]) => s.Default === "1" && s.Path);
  if (marked) return (marked[1].IsRelative ?? "1") === "1" ? join(root, marked[1].Path!) : marked[1].Path!;
  throw new Fatal(`no default Firefox profile in ${ini}; pass --profile DIR`);
}

function firefoxCookies(profile: string, domain: string): Cookies {
  const hosts = cookieHosts(domain);
  const rows = withSnapshot(join(profile, "cookies.sqlite"), (db) => db.query<{ name: string; value: string }, string[]>(
    `SELECT name, value FROM moz_cookies WHERE host IN (${placeholders(hosts.length)}) AND originAttributes = ''`,
  ).all(...hosts));
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

const chromiumKeys = new Map<string, Buffer>();
function chromiumKey(browser: string, scheme: string): Buffer {
  const cached = chromiumKeys.get(`${browser}:${scheme}`);
  if (cached) return cached;
  const spec = CHROMIUM[browser]!;
  let password: string;
  let iterations = 1;
  if (process.platform === "darwin") {
    log(`reading "${spec.keychain} Safe Storage" from the macOS keychain (allow it if asked)`);
    const out = Bun.spawnSync(["security", "find-generic-password", "-w", "-s", `${spec.keychain} Safe Storage`]);
    if (out.exitCode) throw new Fatal(`could not read "${spec.keychain} Safe Storage" from the keychain`);
    password = out.stdout.toString().trim();
    iterations = 1003;
  } else if (scheme === "v10") {
    password = "peanuts"; // Chromium's fixed Linux key when no keyring is in use
  } else {
    const out = Bun.spawnSync(["secret-tool", "lookup", "application", spec.linux![1]]);
    if (out.exitCode) throw new Fatal(`could not read the ${browser} cookie key with secret-tool; use --cookies FILE`);
    password = out.stdout.toString().trim();
  }
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  chromiumKeys.set(`${browser}:${scheme}`, key);
  return key;
}

function chromiumCookies(browser: string, profile: string | undefined, domain: string): Cookies {
  const spec = CHROMIUM[browser]!;
  const root = process.platform === "darwin" ? join(homedir(), "Library/Application Support", spec.mac)
    : process.platform === "linux" && spec.linux ? join(homedir(), ".config", spec.linux[0])
    : undefined;
  if (!root) throw new Fatal(`can't read ${browser} cookies on ${process.platform}; use --browser firefox or --cookies FILE`);
  const dir = profile?.includes("/") ? profile : join(root, profile ?? "Default");
  const file = [join(dir, "Network/Cookies"), join(dir, "Cookies")].find((f) => existsSync(f));
  if (!file) throw new Fatal(`no ${browser} cookie database in ${dir}`);
  const hosts = cookieHosts(domain);
  const { rows, version } = withSnapshot(file, (db) => ({
    rows: db.query<{ name: string; value: string; encrypted_value: Uint8Array | null }, string[]>(
      `SELECT name, value, encrypted_value FROM cookies WHERE host_key IN (${placeholders(hosts.length)})`).all(...hosts),
    version: Number(db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0),
  }));
  const cookies: Cookies = {};
  for (const row of rows) {
    const encrypted = Buffer.from(row.encrypted_value ?? []);
    if (!encrypted.length) {
      cookies[row.name] = row.value;
      continue;
    }
    const scheme = encrypted.toString("latin1", 0, 3);
    if (scheme !== "v10" && scheme !== "v11") throw new Fatal(`unsupported ${browser} cookie encryption "${scheme}"; use --cookies FILE`);
    const decipher = createDecipheriv("aes-128-cbc", chromiumKey(browser, scheme), Buffer.alloc(16, " "));
    let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    if (version >= 24) plain = plain.subarray(32); // newer databases prefix the value with sha256(host)
    cookies[row.name] = plain.toString("utf8");
  }
  return cookies;
}

function netscapeCookies(path: string, domain: string): Cookies {
  const hosts = cookieHosts(domain);
  const cookies: Cookies = {};
  for (let line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length === 7 && hosts.includes(parts[0]!)) cookies[parts[5]!] = parts[6]!;
  }
  return cookies;
}

function writeNetscapeCookies(cookies: Cookies, domain: string, path: string): void {
  const expiry = nowSeconds() + 365 * 86400;
  const lines = ["# Netscape HTTP Cookie File",
    ...Object.entries(cookies).map(([k, v]) => `.${domain}\tTRUE\t/\tTRUE\t${expiry}\t${k}\t${v}`)];
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function appMajorVersion(app: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const plist = readFileSync(`/Applications/${app}.app/Contents/Info.plist`, "utf8");
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)/)?.[1];
  } catch {
    return undefined; // not installed in /Applications
  }
}

/** A user agent matching the browser that owns the session. */
function userAgent(browser: string): string {
  if (browser === "firefox") {
    const major = appMajorVersion("Firefox") ?? BROWSER_MAJOR;
    const os = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10.15"
      : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
    return `Mozilla/5.0 (${os}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
  }
  const major = (browser === "chrome" && appMajorVersion("Google Chrome")) || BROWSER_MAJOR;
  const os = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function browserSession(domain: string, opts: SessionOptions): Session {
  if (opts.cookies) {
    return { cookies: netscapeCookies(opts.cookies, domain), userAgent: userAgent("firefox"), source: opts.cookies };
  }
  const browser = opts.browser?.toLowerCase() ?? process.env.UNROT_BROWSER?.toLowerCase()
    ?? (existsSync(join(firefoxRoot(), "profiles.ini")) ? "firefox" : "chrome");
  if (browser === "firefox") {
    const profile = opts.profile ?? firefoxDefaultProfile();
    return { cookies: firefoxCookies(profile, domain), userAgent: userAgent("firefox"), source: `Firefox profile ${basename(profile)}` };
  }
  if (!has(CHROMIUM, browser)) {
    throw new Fatal(`unknown browser "${browser}": use firefox, ${Object.keys(CHROMIUM).join(", ")}, or --cookies FILE`);
  }
  return {
    cookies: chromiumCookies(browser, opts.profile, domain),
    userAgent: userAgent(browser),
    source: `${browser} profile ${opts.profile ?? "Default"}`,
  };
}

// ── Model providers ────────────────────────────────────────────────────────────────────────────────

interface Media { kind: "image" | "video"; mime: string; data: Buffer }
interface Ask { name: string; prompt: string; schema: object; media: Media[]; temperature?: number; timeoutMs: number }
interface Answer { json: unknown; cost: number | null }
interface Model {
  provider: Provider;
  model: string;
  /** What analysis rows record: the OpenRouter model id, or `claude:<model>` / `codex:<model>`. */
  id: string;
  /** Takes a video file with its audio (OpenRouter). Otherwise videos are sent as frames. */
  video: boolean;
  ask(req: Ask): Promise<Answer>;
}

// Replies, reduced to the fields read here.
interface OpenRouterReply { error?: unknown; choices?: { message?: { content?: string | null } }[]; usage?: { cost?: number } }
interface ClaudeReply { stop_reason?: string; content?: { type: string; input?: unknown }[] }
interface CodexEvent {
  type?: string;
  error?: unknown;
  response?: { error?: unknown; incomplete_details?: unknown; output?: { type: string; content?: { type: string; text?: string }[] }[] };
}
interface TokenReply { access_token: string; refresh_token?: string; expires_in: number; account?: { email_address?: string } }
interface OpenAIClaims {
  exp?: number;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  "https://api.openai.com/profile"?: { email?: string };
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Subscription access works like the official CLIs: OAuth (PKCE) against their public clients.
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_CODE_VERSION = "2.1.317";
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."; // required first system block
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_SCOPES = "openid profile email offline_access";
const CODEX_API = "https://chatgpt.com/backend-api/codex";
const CODEX_VERSION = "0.167.0"; // Codex CLI version to present; the model list depends on it

/** This tool's own login (`bun unrot.ts login`), the only kind it ever refreshes. */
interface Token { access: string; refresh: string; expires: number; email?: string }
type AuthFile = Partial<Record<"claude" | "codex", Token>>;
/** A subscription login found on this machine. */
interface Login { access: string; expires: number; source: string; own?: Token }

function readAuth(): AuthFile {
  return existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
}
function writeAuth(auth: AuthFile): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(`${AUTH_FILE}.tmp`, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${AUTH_FILE}.tmp`, AUTH_FILE);
}

/** The claims of an OpenAI access token (a JWT: decoded, not verified). */
function openAIClaims(access: string): OpenAIClaims {
  try {
    return JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
  } catch {
    return {}; // not a JWT
  }
}

async function tokenRequest(provider: "claude" | "codex", body: Record<string, string>): Promise<Token> {
  const res = provider === "claude"
    ? await fetch(CLAUDE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    : await fetch(CODEX_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) {
    const again = body.grant_type === "refresh_token" ? `; run \`bun unrot.ts login ${provider}\` again` : "";
    throw new Fatal(`${provider} token request failed (HTTP ${res.status}): ${text.slice(0, 300)}${again}`);
  }
  const data: TokenReply = JSON.parse(text);
  const refresh = data.refresh_token ?? body.refresh_token ?? "";
  if (provider === "claude") {
    return { access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000 - 5 * 60_000, email: data.account?.email_address };
  }
  const claims = openAIClaims(data.access_token);
  if (!claims["https://api.openai.com/auth"]?.chatgpt_account_id) {
    throw new Fatal("the ChatGPT token carries no account id; is this a ChatGPT Plus/Pro/Business account?");
  }
  return { access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000, email: claims["https://api.openai.com/profile"]?.email };
}

/** Parsed JSON, or undefined: other apps' credential stores are optional sources, read best-effort. */
function parseJson(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/**
 * Subscription logins already on this machine, preferred first: an explicit token, this tool's own login,
 * then the coding agents the user runs (Claude Code, Codex CLI, oh-my-pi, pi). Borrowed logins are only
 * read, never refreshed: refreshing rotates the refresh token and would sign the other app out. They stay
 * fresh because the agent running this skill keeps refreshing them.
 */
function findLogins(provider: "claude" | "codex"): Login[] {
  const logins: Login[] = [];
  const codexExpiry = (access: string) => (openAIClaims(access).exp ?? 0) * 1000;
  const add = (access: unknown, expires: unknown, source: string) => {
    if (typeof access !== "string" || !access) return;
    logins.push({ access, expires: provider === "codex" ? codexExpiry(access) : Number(expires) || 0, source });
  };
  if (provider === "claude") add(process.env.CLAUDE_CODE_OAUTH_TOKEN, Infinity, "CLAUDE_CODE_OAUTH_TOKEN");
  const own = readAuth()[provider];
  if (own) logins.push({ access: own.access, expires: own.expires, source: "unrot", own });
  if (provider === "claude") {
    if (process.platform === "darwin") {
      const out = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stderr: "ignore", timeout: 60_000 });
      const oauth = fields(fields(out.exitCode ? undefined : parseJson(out.stdout.toString())).claudeAiOauth);
      add(oauth.accessToken, oauth.expiresAt, "Claude Code");
    }
    const oauth = fields(fields(parseJson(readText(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json")))).claudeAiOauth);
    add(oauth.accessToken, oauth.expiresAt, "Claude Code");
  } else {
    const tokens = fields(fields(parseJson(readText(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")))).tokens);
    add(tokens.access_token, undefined, "Codex CLI");
  }
  const key = provider === "claude" ? "anthropic" : "openai-codex";
  for (const dir of new Set([process.env.PI_CODING_AGENT_DIR, join(homedir(), ".omp/agent"), join(homedir(), ".pi/agent")])) {
    if (!dir) continue;
    if (existsSync(join(dir, "agent.db"))) { // oh-my-pi
      try {
        const db = new Database(join(dir, "agent.db"), { readonly: true });
        try {
          for (const row of db.query<{ data: string }, [string]>(
            "SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth' AND disabled_cause IS NULL").all(key)) {
            const data = fields(parseJson(row.data));
            add(data.access, data.expires, "oh-my-pi");
          }
        } finally {
          db.close();
        }
      } catch {
        // another schema or a locked file: not a store this script can read
      }
    }
    const pi = fields(fields(parseJson(readText(join(dir, "auth.json"))))[key]);
    add(pi.access, pi.expires, "pi");
  }
  return logins;
}

const loginInUse = new Map<string, Login>();
const refreshing = new Map<string, Promise<Login>>();
/** A usable login: the first one found that isn't expiring or `rejected` (an access token the API refused). */
async function subscriptionLogin(provider: "claude" | "codex", rejected?: string): Promise<Login> {
  const fresh = (l: Login) => l.access !== rejected && l.expires > Date.now() + 60_000;
  const cached = loginInUse.get(provider);
  if (cached && fresh(cached)) return cached;
  const logins = findLogins(provider);
  const usable = logins.find(fresh);
  const own = logins.find((l) => l.own)?.own;
  let chosen: Login;
  if (usable) {
    chosen = usable;
  } else if (own) {
    let pending = refreshing.get(provider);
    if (!pending) {
      pending = (async () => {
        const next = await tokenRequest(provider, provider === "claude"
          ? { grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: own.refresh }
          : { grant_type: "refresh_token", refresh_token: own.refresh, client_id: CODEX_CLIENT_ID });
        const token: Token = { ...next, email: next.email ?? own.email };
        const auth = readAuth();
        auth[provider] = token;
        writeAuth(auth);
        return { access: token.access, expires: token.expires, source: "unrot", own: token };
      })().finally(() => refreshing.delete(provider));
      refreshing.set(provider, pending);
    }
    chosen = await pending;
  } else {
    const app = provider === "claude" ? "Claude Code" : "Codex CLI";
    throw new Fatal(logins.length
      ? `the ${provider} logins found (${[...new Set(logins.map((l) => l.source))].join(", ")}) have expired; use that app once so it `
        + `refreshes its login, or run \`bun unrot.ts login ${provider}\``
      : `no ${provider} subscription login found: log into ${app} (or oh-my-pi / pi), or run \`bun unrot.ts login ${provider}\``);
  }
  if (cached?.source !== chosen.source) log(`  using the ${chosen.source} login for ${provider}`);
  loginInUse.set(provider, chosen);
  return chosen;
}

/** POSTs with a subscription login, looking for a fresh one once if the API rejects it. */
async function subscriptionPost(provider: "claude" | "codex", url: string, headers: (access: string) => Record<string, string>, body: string, timeoutMs: number): Promise<Response> {
  let login = await subscriptionLogin(provider);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: headers(login.access), body, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 401) return res;
    if (attempt) throw new Fatal(`${provider} rejected the ${login.source} login (HTTP 401); log in again there or run \`bun unrot.ts login ${provider}\``);
    login = await subscriptionLogin(provider, login.access);
  }
}

const claudeHeaders = (access: string): Record<string, string> => ({
  Authorization: `Bearer ${access}`,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
  "x-app": "cli",
  "Content-Type": "application/json",
  Accept: "application/json",
});

const codexHeaders = (access: string): Record<string, string> => ({
  Authorization: `Bearer ${access}`,
  "chatgpt-account-id": openAIClaims(access)["https://api.openai.com/auth"]?.chatgpt_account_id ?? "",
  "OpenAI-Beta": "responses=experimental",
  originator: "codex_cli_rs",
  version: CODEX_VERSION,
  "Content-Type": "application/json",
});

/** JSON from a model's text answer (tolerates a ```json fence). */
function parseJsonText(content: string | null | undefined): unknown {
  let text = content?.trim();
  if (!text) throw new Error("model returned an empty response");
  if (text.startsWith("```")) text = text.slice(text.indexOf("\n") + 1, text.lastIndexOf("```"));
  return JSON.parse(text);
}

function openRouterModel(model: string): Model {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Fatal(`OPENROUTER_API_KEY is not set (put it in ${join(HOME, ".env")})`);
  return {
    provider: "openrouter", model, id: model, video: true,
    async ask(req) {
      const content = [{ type: "text", text: req.prompt }, ...req.media.map((m) => m.kind === "video"
        ? { type: "video_url", video_url: { url: `data:${m.mime};base64,${m.data.toString("base64")}` } }
        : { type: "image_url", image_url: { url: `data:${m.mime};base64,${m.data.toString("base64")}` } })];
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "unrot" },
        body: JSON.stringify({
          model,
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          messages: [{ role: "user", content }],
          response_format: { type: "json_schema", json_schema: { name: req.name, strict: true, schema: req.schema } },
          provider: { data_collection: "deny", require_parameters: true },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      if (!res.ok) throw new HttpError(res.status, await res.text(), res.headers, "OpenRouter");
      const data = await readJson<OpenRouterReply>(res);
      if (data.error) throw new Error(`OpenRouter: ${JSON.stringify(data.error)}`);
      return { json: parseJsonText(data.choices?.[0]?.message?.content), cost: data.usage?.cost ?? null };
    },
  };
}

function claudeModel(model: string): Model {
  return {
    provider: "claude", model, id: `claude:${model}`, video: false,
    async ask(req) {
      // Structured output = one forced tool call whose input follows the schema.
      const body = JSON.stringify({
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: CLAUDE_IDENTITY }, { type: "text", text: `Answer by calling the ${req.name} tool once.` }],
        messages: [{
          role: "user",
          content: [{ type: "text", text: req.prompt }, ...req.media.map((m) => {
            if (m.kind !== "image") throw new Error("Claude does not take video");
            return { type: "image", source: { type: "base64", media_type: m.mime, data: m.data.toString("base64") } };
          })],
        }],
        tools: [{ name: req.name, description: "Record the result.", input_schema: req.schema }],
        tool_choice: { type: "tool", name: req.name },
      });
      const res = await subscriptionPost("claude", "https://api.anthropic.com/v1/messages", claudeHeaders, body, req.timeoutMs);
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 404 && text.includes("model")) {
          throw new Fatal(`claude doesn't offer model "${model}" to this account; list them with \`bun unrot.ts models claude\``);
        }
        throw new HttpError(res.status, text, res.headers, "Claude");
      }
      const data = await readJson<ClaudeReply>(res);
      if (data.stop_reason === "max_tokens") throw new Error("Claude ran out of output tokens");
      const call = data.content?.find((block) => block.type === "tool_use");
      if (!call) throw new Error(`Claude returned no ${req.name} call (stop_reason ${data.stop_reason})`);
      return { json: call.input, cost: null };
    },
  };
}

function codexModel(model: string): Model {
  return {
    provider: "codex", model, id: `codex:${model}`, video: false,
    async ask(req) {
      const body = JSON.stringify({
        model,
        instructions: "Answer with JSON that follows the given schema.",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: req.prompt }, ...req.media.map((m) => {
            if (m.kind !== "image") throw new Error("Codex does not take video");
            return { type: "input_image", detail: "auto", image_url: `data:${m.mime};base64,${m.data.toString("base64")}` };
          })],
        }],
        text: { format: { type: "json_schema", name: req.name, strict: true, schema: req.schema } },
        reasoning: { effort: "low" },
        stream: true, // the ChatGPT backend only streams
        store: false,
      });
      const res = await subscriptionPost("codex", `${CODEX_API}/responses`, (t) => ({ ...codexHeaders(t), Accept: "text/event-stream" }), body, req.timeoutMs);
      if (!res.ok) {
        const text = await res.text();
        if (text.includes("model_not_found")) {
          throw new Fatal(`codex doesn't offer model "${model}" to this account; list them with \`bun unrot.ts models codex\``);
        }
        throw new HttpError(res.status, text, res.headers, "Codex");
      }
      // Server-sent events; the final `response.completed` carries the whole answer.
      for (const event of (await res.text()).split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const parsed: CodexEvent = JSON.parse(data);
        if (parsed.type === "error" || parsed.type === "response.failed") {
          throw new Error(`Codex: ${JSON.stringify(parsed.error ?? parsed.response?.error ?? parsed).slice(0, 500)}`);
        }
        if (parsed.type === "response.incomplete") {
          throw new Error(`Codex: incomplete answer (${JSON.stringify(parsed.response?.incomplete_details)})`);
        }
        if (parsed.type === "response.completed") {
          const text = (parsed.response?.output ?? []).filter((item) => item.type === "message")
            .flatMap((item) => item.content ?? []).filter((c) => c.type === "output_text")
            .map((c) => c.text ?? "").join("");
          return { json: parseJsonText(text), cost: null };
        }
      }
      throw new Error("Codex stream ended without a completed response");
    },
  };
}

function chooseModel(opts: { provider?: string; model?: string }): Model {
  const chosen = (opts.provider ?? process.env.UNROT_PROVIDER)?.toLowerCase();
  let provider = PROVIDERS.find((p) => p === chosen);
  if (chosen && !provider) throw new Fatal(`unknown provider "${chosen}": use ${PROVIDERS.join(", ")}`);
  if (!provider) {
    const usable = (p: "claude" | "codex") => findLogins(p).some((l) => l.own || l.expires > Date.now() + 60_000);
    provider = process.env.OPENROUTER_API_KEY ? "openrouter" : usable("claude") ? "claude" : usable("codex") ? "codex" : undefined;
  }
  if (!provider) {
    throw new Fatal("no model access: log into Claude Code or Codex CLI (this script reuses their subscription login), run "
      + `\`bun unrot.ts login claude\` or \`bun unrot.ts login codex\`, or put OPENROUTER_API_KEY in ${join(HOME, ".env")}`);
  }
  const model = opts.model ?? process.env.UNROT_MODEL ?? DEFAULT_MODELS[provider];
  return provider === "openrouter" ? openRouterModel(model) : provider === "claude" ? claudeModel(model) : codexModel(model);
}

/** Seconds until a 429 clears, from the provider's headers or body; Infinity when the plan's usage is used up. */
function rateLimitWait(err: HttpError): number {
  const after = err.headers.get("retry-after");
  if (after) return Number.isFinite(Number(after)) ? Number(after) : (Date.parse(after) - Date.now()) / 1000;
  if (err.headers.get("anthropic-ratelimit-unified-status") === "rejected") {
    return Number(err.headers.get("anthropic-ratelimit-unified-reset")) - Date.now() / 1000;
  }
  if (/usage_limit_reached|usage_not_included/.test(err.body)) {
    try {
      const resets = fields(fields(JSON.parse(err.body)).error).resets_in_seconds;
      return typeof resets === "number" ? resets : Infinity;
    } catch {
      return Infinity; // not JSON: the limit message itself is the signal
    }
  }
  return 0;
}

/** One model call with retries for transient failures and answers that fail `validate`. */
async function askModel<T>(model: Model, req: Ask, validate: (json: unknown) => T): Promise<{ result: T; cost: number | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { json, cost } = await model.ask(req);
      return { result: validate(json), cost };
    } catch (err) {
      if (err instanceof Fatal) throw err;
      let wait = 5 * attempt;
      if (err instanceof HttpError && err.status === 429) {
        const clears = rateLimitWait(err);
        if (clears > 120) {
          throw new QuotaError(`${model.provider} usage limit reached${Number.isFinite(clears) ? `; it resets around ${clock(clears)}` : ""}`);
        }
        wait = Math.max(wait, clears);
      } else if (err instanceof HttpError && err.status < 500 && err.status !== 408) {
        throw err; // a bad request won't get better by retrying
      }
      if (attempt >= 3) throw err;
      await sleep(wait);
    }
  }
}

// ── Login ──────────────────────────────────────────────────────────────────────────────────────────

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (URL.canParse(value)) {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

interface CallbackServer { code: Promise<string>; port: number; stop(): void }

/** A loopback server that receives the OAuth redirect. Throws if the port is taken. */
function callbackServer(port: number, path: string, state: string): CallbackServer {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const page = (text: string, status = 200) => new Response(
    `<!doctype html><meta charset="utf-8"><title>unrot</title><p style="font:16px system-ui;margin:40px">${text}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== path) return new Response("not found", { status: 404 });
      const error = url.searchParams.get("error");
      if (error) {
        reject(new Fatal(`login failed: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim()));
        return page("Login failed. Check the terminal.", 400);
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code) return page("Unexpected login response.", 400);
      resolve(code);
      return page("Logged in. You can close this tab and go back to the terminal.");
    },
  });
  return { code: promise, port: server.port ?? port, stop: () => void server.stop(true) };
}

/** The first non-empty line typed or pasted into the terminal. */
async function pastedLine(): Promise<string> {
  for await (const line of console) if (line.trim()) return line.trim();
  throw new Fatal("login cancelled");
}

async function login(provider: string | undefined): Promise<void> {
  if (provider !== "claude" && provider !== "codex") throw new Fatal("usage: bun unrot.ts login <claude|codex>");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let server: CallbackServer | undefined;
  let url: URL;
  let redirectUri: string;
  let state: string;
  if (provider === "claude") {
    state = verifier;
    for (const port of [53692, 0]) { // Anthropic accepts any loopback port
      try {
        server = callbackServer(port, "/callback", state);
        break;
      } catch {
        // port taken: try the next one
      }
    }
    redirectUri = `http://localhost:${server?.port ?? 53692}/callback`;
    url = new URL(CLAUDE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      code: "true", client_id: CLAUDE_CLIENT_ID, response_type: "code", redirect_uri: redirectUri, scope: CLAUDE_SCOPES,
      code_challenge: challenge, code_challenge_method: "S256", state,
    }).toString();
  } else {
    state = randomBytes(16).toString("hex");
    redirectUri = "http://localhost:1455/auth/callback"; // the only redirect OpenAI accepts for this client
    try {
      server = callbackServer(1455, "/auth/callback", state);
    } catch {
      log("port 1455 is busy (a Codex CLI login?); after approving, paste the URL your browser lands on");
    }
    url = new URL(CODEX_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code", client_id: CODEX_CLIENT_ID, redirect_uri: redirectUri, scope: CODEX_SCOPES,
      code_challenge: challenge, code_challenge_method: "S256", state,
      id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
    }).toString();
  }
  if (!server && !process.stdin.isTTY) throw new Fatal("no free port for the login callback and no terminal to paste into");

  const name = provider === "claude" ? "Claude (Pro/Max)" : "ChatGPT (Codex)";
  console.log(`Log in to ${name} in your browser:\n\n  ${url}\n`);
  if (process.stdin.isTTY) console.log("If the browser is on another machine, approve there, then paste the URL it ends up on here.");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  if (Bun.which(opener)) Bun.spawn([opener, url.toString()], { stdout: "ignore", stderr: "ignore" });

  const pasted = async () => {
    const parsed = parseAuthorizationInput(await pastedLine());
    if (parsed.state && parsed.state !== state) throw new Fatal("that URL belongs to a different login attempt");
    if (!parsed.code) throw new Fatal("no authorization code in what was pasted");
    return parsed.code;
  };
  try {
    const code = await Promise.race([...(server ? [server.code] : []), ...(process.stdin.isTTY ? [pasted()] : [])]);
    const token = await tokenRequest(provider, provider === "claude"
      ? { grant_type: "authorization_code", client_id: CLAUDE_CLIENT_ID, code, state, redirect_uri: redirectUri, code_verifier: verifier }
      : { grant_type: "authorization_code", client_id: CODEX_CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirectUri });
    const auth = readAuth();
    auth[provider] = token;
    writeAuth(auth);
    console.log(`Logged in to ${name}${token.email ? ` as ${token.email}` : ""}. Saved to ${AUTH_FILE}`);
  } finally {
    server?.stop();
  }
}

async function listModels(provider: string | undefined): Promise<void> {
  if (provider === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: claudeHeaders((await subscriptionLogin("claude")).access) });
    if (!res.ok) throw new HttpError(res.status, await res.text(), res.headers, "Claude");
    const reply = await readJson<{ data: { id: string; display_name?: string }[] }>(res);
    for (const m of reply.data) console.log(`${m.id}\t${m.display_name ?? ""}`);
  } else if (provider === "codex") {
    const res = await fetch(`${CODEX_API}/models?client_version=${CODEX_VERSION}`, { headers: codexHeaders((await subscriptionLogin("codex")).access) });
    if (!res.ok) throw new HttpError(res.status, await res.text(), res.headers, "Codex");
    const reply = await readJson<{ models: { slug: string; description?: string; visibility?: string; input_modalities?: string[] }[] }>(res);
    for (const m of reply.models) {
      if (m.visibility === "list" && m.input_modalities?.includes("image")) console.log(`${m.slug}\t${m.description ?? ""}`);
    }
  } else if (provider === "openrouter") {
    console.log("Any https://openrouter.ai/models model with structured outputs and image input. For Instagram, one\n"
      + "that also takes video with audio (default xiaomi/mimo-v2.6-flash) hears speech instead of reading frames.");
  } else {
    throw new Fatal("usage: bun unrot.ts models <claude|codex|openrouter>");
  }
}

// ── Instagram: saved feed ──────────────────────────────────────────────────────────────────────────

const IG_API = "https://www.instagram.com/api/v1";
const IG_APP_ID = "936619743392459"; // instagram.com web client
const IG_ASBD_ID = "359341";
const IG_MAX_CAROUSEL = 6;
const IG_FRAMES = 8; // frames per video for models that can't watch video
const MAX_INLINE_VIDEO = 15 * 1024 * 1024; // bigger videos get downscaled with ffmpeg first

// The saved feed's media objects, reduced to the fields read here.
interface IgRendition { url: string; width?: number; height?: number }
interface IgMedia {
  code: string;
  pk?: string | number;
  media_type?: number; // 1 photo, 2 video, 8 carousel
  product_type?: string;
  taken_at?: number;
  user?: { username?: string; full_name?: string };
  caption?: { text?: string } | null;
  location?: { name?: string; address?: string; city?: string; lat?: number; lng?: number } | null;
  clips_metadata?: {
    music_info?: { music_asset_info?: { title?: string; display_artist?: string } } | null;
    original_sound_info?: { original_audio_title?: string } | null;
  } | null;
  video_versions?: IgRendition[];
  image_versions2?: { candidates?: IgRendition[] };
  carousel_media?: IgMedia[];
  video_duration?: number;
  video_subtitles_uri?: string | null;
}
interface IgFeedPage { status?: string; message?: string; items?: { media: IgMedia }[]; more_available?: boolean; next_max_id?: string }

/** Only one private endpoint is used: the saved feed, 50 items per request, sent like instagram.com sends it. */
class Instagram {
  private wwwClaim = "0";

  constructor(private session: Session) {
    if (!session.cookies.sessionid) throw new Fatal(`no Instagram login in ${session.source}; log into instagram.com there`);
  }

  get userId(): string {
    return this.session.cookies.ds_user_id ?? "?";
  }

  private async get(path: string, params: Record<string, string>): Promise<IgFeedPage> {
    const c = this.session.cookies;
    const res = await fetch(`${IG_API}${path}?${new URLSearchParams(params)}`, {
      redirect: "manual", // a redirect means "go log in"
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent": this.session.userAgent,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.instagram.com/",
        "X-CSRFToken": c.csrftoken ?? "",
        "X-IG-App-ID": IG_APP_ID,
        "X-ASBD-ID": IG_ASBD_ID,
        "X-IG-WWW-Claim": this.wwwClaim,
        "X-Requested-With": "XMLHttpRequest",
        Cookie: cookieHeader(c),
      },
    });
    if (res.status === 429) throw new Fatal("instagram: HTTP 429 (rate limited); stop and retry in a few hours");
    if ([301, 302, 401, 403].includes(res.status)) {
      throw new Fatal(`instagram: HTTP ${res.status} ${res.headers.get("location") ?? ""}: session expired or challenged; `
        + "open instagram.com in the browser and log in again");
    }
    if (!res.ok) throw new HttpError(res.status, await res.text(), res.headers, "Instagram");
    this.wwwClaim = res.headers.get("x-ig-set-www-claim") || this.wwwClaim;
    const data = await readJson<IgFeedPage>(res);
    if (data.status !== "ok") {
      if (["login_required", "checkpoint_required", "challenge_required"].includes(data.message ?? "")) {
        throw new Fatal(`instagram: ${data.message}: open instagram.com in the browser and resolve it`);
      }
      throw new Error(`Instagram error: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  /** Saved items newest-first, one array per page, `delay` seconds apart. */
  async *savedPages(delay: [min: number, max: number]): AsyncGenerator<IgMedia[]> {
    const params: Record<string, string> = { count: "50" };
    for (;;) {
      const data = await this.get("/feed/saved/posts/", params);
      yield (data.items ?? []).map((item) => item.media);
      if (!data.more_available || !data.next_max_id) return;
      params.max_id = data.next_max_id;
      await sleep(delay[0] + Math.random() * (delay[1] - delay[0]));
    }
  }
}

function igVideoUrl(m: IgMedia): string | undefined {
  const versions = m.video_versions ?? [];
  if (!versions.length) return undefined;
  // Smallest rendition that's still >= 480 px wide: plenty for a model, light to upload.
  const wide = versions.filter((v) => (v.width ?? 0) >= 480);
  const area = (v: IgRendition) => (v.width ?? 0) * (v.height ?? 0);
  return (wide.length ? wide : versions).reduce((a, b) => (area(b) < area(a) ? b : a)).url;
}

function igImageUrl(m: IgMedia): string | undefined {
  const candidates = m.image_versions2?.candidates ?? [];
  if (!candidates.length) return undefined;
  const ok = candidates.filter((c) => (c.width ?? 0) <= 1080);
  return (ok.length ? ok : candidates).reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a)).url;
}

interface IgAsset { kind: "video" | "image"; url: string; cover?: string; duration?: number }
/** Providers take one video per request: the first video goes as video, later ones as their cover image. */
function igAssets(m: IgMedia): IgAsset[] {
  const nodes = m.media_type === 8 ? (m.carousel_media ?? []).slice(0, IG_MAX_CAROUSEL) : [m];
  const assets: IgAsset[] = [];
  for (const node of nodes) {
    const video = assets.some((a) => a.kind === "video") ? undefined : igVideoUrl(node);
    const image = igImageUrl(node);
    if (video) assets.push({ kind: "video", url: video, cover: image, duration: node.video_duration });
    else if (image) assets.push({ kind: "image", url: image });
  }
  return assets;
}

async function igDownload(url: string, dest: string, agent: string): Promise<void> {
  if (existsSync(dest)) return;
  const res = await fetch(url, { headers: { "User-Agent": agent, Referer: "https://www.instagram.com/" }, signal: AbortSignal.timeout(120_000) });
  if ([403, 404, 410].includes(res.status)) {
    throw new Error("media URL expired: run `ig sync --full`, then `ig process --retry-errors`");
  }
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
  await Bun.write(`${dest}.part`, res);
  renameSync(`${dest}.part`, dest);
}

async function shrinkVideo(path: string): Promise<string> {
  const small = path.replace(/\.mp4$/, ".small.mp4");
  if (existsSync(small)) return small;
  if (!Bun.which("ffmpeg")) throw new Error(`${basename(path)} is over ${MAX_INLINE_VIDEO >> 20} MB and ffmpeg is not installed`);
  await run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-vf", "scale=-2:480", "-r", "15", "-c:v", "libx264",
    "-preset", "veryfast", "-b:v", "500k", "-c:a", "aac", "-b:a", "64k", "-ac", "1", small]);
  return small;
}

/** `count` frames spread evenly over the video, 480 px wide. */
async function videoFrames(path: string, duration: number | undefined, count: number): Promise<string[]> {
  const stem = basename(path, ".mp4");
  const seconds = duration && duration > 0 ? duration : 30;
  await run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-vf", `fps=${count}/${seconds},scale=480:-2`,
    "-frames:v", String(count), "-q:v", "5", join(dirname(path), `${stem}.frame%02d.jpg`)]);
  return readdirSync(dirname(path)).filter((f) => f.startsWith(`${stem}.frame`)).sort().map((f) => join(dirname(path), f));
}

function imageFile(path: string): Media {
  const data = readFileSync(path);
  return { kind: "image", mime: sniffImage(data) ?? "image/jpeg", data };
}

/** Instagram's own speech-to-text (an .srt) when the reel has one: the only speech a frames-only model gets. */
async function igAutoCaptions(m: IgMedia): Promise<string> {
  if (!m.video_subtitles_uri) return "";
  const res = await fetch(m.video_subtitles_uri, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
  if (!res?.ok) return ""; // expired like the other CDN URLs: the post is judged from everything else
  const lines: string[] = [];
  for (const raw of (await res.text()).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\d+$/.test(line) || line.includes("-->") || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines.join(" ");
}

function igMetadata(m: IgMedia, captions: string): string {
  const lines = [`Creator: @${m.user?.username ?? "?"} (${m.user?.full_name ?? ""})`];
  if (m.taken_at) lines.push(`Posted: ${new Date(m.taken_at * 1000).toISOString().slice(0, 10)}`);
  const loc = m.location;
  if (loc) {
    const where = [loc.name, loc.address, loc.city].filter(Boolean).join(", ");
    const coords = loc.lat && loc.lng ? ` [${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}]` : "";
    lines.push(`Location tag: ${where}${coords}`);
  }
  const music = m.clips_metadata?.music_info?.music_asset_info;
  const audio = music?.title ? `${music.title} - ${music.display_artist ?? ""}`.replace(/^[ -]+|[ -]+$/g, "")
    : m.clips_metadata?.original_sound_info?.original_audio_title;
  if (audio) lines.push(`Audio track: ${audio}`);
  lines.push(`Caption:\n${m.caption?.text?.trim() || "(none)"}`);
  if (captions) lines.push(`Auto-captions (Instagram's transcription of the speech):\n${captions.slice(0, 6000)}`);
  return lines.join("\n");
}

const IG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "language", "transcript", "on_screen_text", "entries"],
  properties: {
    summary: { type: "string" },
    language: { type: "string" },
    transcript: { type: "string" },
    on_screen_text: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "kind", "creator", "location", "details", "confidence"],
        properties: {
          category: { type: "string", enum: Object.keys(IG_LISTS) },
          title: { type: "string" },
          kind: { type: "string" },
          creator: { type: "string" },
          location: { type: "string" },
          details: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
};

function igPrompt(m: IgMedia, captions: string, watchesVideo: boolean): string {
  const lists = Object.entries(IG_LISTS).map(([key, [title, desc]]) => `- ${key}: ${title} - ${desc}`).join("\n");
  const look = watchesVideo
    ? "Watch the attached media (listen to the speech, read all on-screen text) and use the metadata below."
    : "The attached images are the post's photos and, for a video, frames taken from it in order (you can't hear\n"
      + "its audio). Read all on-screen text and use the metadata below.";
  const transcript = watchesVideo
    ? `- transcript: human speech verbatim in its original language; "" if the audio is only
  music/song/ambient. Never put song lyrics, on-screen text or the caption here.`
    : `- transcript: the speech from the "Auto-captions" in the metadata, verbatim, when there are any; else "".
  Never put song lyrics, on-screen text or the caption here.`;
  const located = Object.keys(IG_GROUP_BY_LOCATION).join(", ");
  return `You catalogue Instagram posts a person saved, so each lands on the right personal list.
${look}
${ABOUT ? `\nAbout the person, in their words (use it to judge why they saved a post and where it belongs):\n${ABOUT}\n` : ""}
Lists:
${lists}

Return JSON:
- summary: 1-2 sentences, what this post is and why someone would save it.
- language: spoken/written language(s), e.g. "en", "es", "hi-en" for mixed speech, "none".
${transcript}
- on_screen_text: text visible in the video/images themselves, deduplicated; NOT the caption. "" if none.
- entries: one entry per distinct thing worth acting on or remembering. A "5 books you must read"
  post yields 5 entries; a recipe yields one entry; a talk with one key insight yields one entry.
  Every post yields AT LEAST one entry: the person saved it for a reason, so when nothing specific
  is named, file the post itself under the closest list (a summit vlog: the mountain; a build video:
  the build; a joke: other). Fields:
  The "Audio track" in the metadata is usually background music the creator picked: add an entry
  for it ONLY when the post itself is about music (the song, artist, a cover or performance).
  - category: one list key from above.
  - title: the specific name (film, book, restaurant, dish, place, product, song), or for ideas the
    idea itself in <= 15 words. NEVER invent a name that is not in the speech, on-screen text,
    caption or tags; if the specific name is missing, describe it and lower confidence.
  - kind: finer type, e.g. movie, series, documentary, novel, recipe, restaurant, cafe, street food,
    city, beach, hotel, app, gadget, song, mental model, workout.
  - creator: director / author / chef / brand / artist when known, else "".
  - location: "area, city, country" when the thing is tied to a place${located ? ` (always for ${located})` : ""}; use the
    location tag when it applies; else "".
  - details: one line: why it is worth it, the key takeaway, or for recipes the core ingredients +
    method. Keep the creator's concrete specifics (prices, timings, quantities) when stated.
  - confidence: 0-1, how sure you are the entry is correctly identified and categorised.
  Pure entertainment / memes: a single "other" entry describing it.

Metadata:
${igMetadata(m, captions)}`;
}

interface IgEntry { category: string; title: string; kind: string; creator: string; location: string; details: string; confidence: number }
interface IgResult { summary: string; language: string; transcript: string; on_screen_text: string; entries: IgEntry[] }

/** Validates a model answer; the licensed track behind a movie edit or travel clip is not a music pick. */
function igResult(json: unknown, m: IgMedia): IgResult {
  const r = fields(json);
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let entries: IgEntry[] = (Array.isArray(r.entries) ? r.entries : []).map(fields).filter((e) => text(e.title)).map((e) => ({
    category: has(IG_LISTS, e.category) ? e.category : "other",
    title: text(e.title),
    kind: text(e.kind),
    creator: text(e.creator),
    location: text(e.location),
    details: text(e.details),
    confidence: Number(e.confidence) || 0,
  }));
  const track = fold(m.clips_metadata?.music_info?.music_asset_info?.title ?? "");
  if (track && !entries.every((e) => e.category === "music")) {
    entries = entries.filter((e) => !(e.category === "music" && fold(e.title).includes(track)));
  }
  return { summary: text(r.summary), language: text(r.language), transcript: text(r.transcript), on_screen_text: text(r.on_screen_text), entries };
}

async function igAnalyze(model: Model, m: IgMedia, folder: string, agent: string): Promise<{ result: IgResult; cost: number | null }> {
  const assets = igAssets(m);
  if (!assets.length) throw new Error("no downloadable media in the saved item");
  mkdirSync(folder, { recursive: true });
  const media: Media[] = [];
  for (const [i, asset] of assets.entries()) {
    const video = join(folder, `${i}.mp4`);
    const image = join(folder, `${i}.jpg`);
    if (asset.kind === "image") {
      await igDownload(asset.url, image, agent);
      media.push(imageFile(image));
    } else if (model.video) {
      await igDownload(asset.url, video, agent);
      const upload = statSync(video).size > MAX_INLINE_VIDEO ? await shrinkVideo(video) : video;
      media.push({ kind: "video", mime: "video/mp4", data: readFileSync(upload) });
    } else if (Bun.which("ffmpeg")) {
      await igDownload(asset.url, video, agent);
      for (const frame of await videoFrames(video, asset.duration, IG_FRAMES)) media.push(imageFile(frame));
    } else if (asset.cover) {
      await igDownload(asset.cover, image, agent);
      media.push(imageFile(image));
    }
  }
  const captions = await igAutoCaptions(m);
  const req = { name: "saved_post", prompt: igPrompt(m, captions, model.video), schema: IG_SCHEMA, media, temperature: 0, timeoutMs: 300_000 };
  return askModel(model, req, (json) => igResult(json, m));
}

const IG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS media (
    code          TEXT PRIMARY KEY,           -- Instagram shortcode
    pk            TEXT NOT NULL,
    url           TEXT NOT NULL,
    media_type    INTEGER NOT NULL,           -- 1 photo, 2 video, 8 carousel
    product_type  TEXT,                       -- clips = reel, feed, carousel_container, igtv
    username      TEXT,
    caption       TEXT,
    taken_at      INTEGER,
    saved_order   INTEGER NOT NULL,           -- higher = saved more recently (see igUpsert)
    raw_json      TEXT NOT NULL,              -- full API object, refreshed on every sync that sees it
    status        TEXT NOT NULL DEFAULT 'new', -- new | analyzed | error
    error         TEXT
);
CREATE INDEX IF NOT EXISTS media_status ON media(status, saved_order);

CREATE TABLE IF NOT EXISTS analysis (
    code            TEXT PRIMARY KEY REFERENCES media(code) ON DELETE CASCADE,
    model           TEXT NOT NULL,
    analyzed_at     INTEGER NOT NULL,
    summary         TEXT,
    language        TEXT,
    transcript      TEXT,
    on_screen_text  TEXT,
    cost_usd        REAL,
    json            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL REFERENCES media(code) ON DELETE CASCADE,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    kind        TEXT,
    creator     TEXT,
    location    TEXT,
    details     TEXT,
    confidence  REAL
);
CREATE INDEX IF NOT EXISTS entries_category ON entries(category);

CREATE VIEW IF NOT EXISTS entries_v AS
    SELECT e.category, e.title, e.kind, e.creator, e.location, e.details, e.confidence,
           m.url, m.username, m.saved_order, a.summary, e.code
    FROM entries e JOIN media m USING (code) LEFT JOIN analysis a USING (code);
`;

/**
 * Inserts a saved item or refreshes its raw JSON (CDN URLs expire); true if it was already known.
 * The feed has no saved-at time, so `savedOrder` is `sync start ms - feed position`: newest first within
 * a sync, and every later sync starts higher.
 */
function igUpsert(db: Database, m: IgMedia, savedOrder: number): boolean {
  const raw = JSON.stringify(m);
  if (db.query<{ found: number }, [string]>("SELECT 1 AS found FROM media WHERE code = ?").get(m.code)) {
    db.run("UPDATE media SET raw_json = ? WHERE code = ?", [raw, m.code]);
    return true;
  }
  const url = `https://www.instagram.com/${m.product_type === "clips" ? "reel" : "p"}/${m.code}/`;
  db.run(
    "INSERT INTO media (code, pk, url, media_type, product_type, username, caption, taken_at, saved_order, raw_json)"
      + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [m.code, String(m.pk), url, m.media_type ?? null, m.product_type ?? null, m.user?.username ?? null,
      m.caption?.text ?? null, m.taken_at ?? null, savedOrder, raw],
  );
  return false;
}

function igSaveAnalysis(db: Database, code: string, model: string, r: IgResult, cost: number | null): void {
  db.transaction(() => {
    db.run("DELETE FROM entries WHERE code = ?", [code]);
    db.run(
      "INSERT OR REPLACE INTO analysis (code, model, analyzed_at, summary, language, transcript, on_screen_text, cost_usd, json)"
        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [code, model, nowSeconds(), r.summary, r.language, r.transcript, r.on_screen_text, cost, JSON.stringify(r)],
    );
    const insert = db.query("INSERT INTO entries (code, category, title, kind, creator, location, details, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of r.entries) {
      insert.run(code, e.category, e.title, e.kind || null, e.creator || null, e.location || null, e.details || null, e.confidence);
    }
    db.run("UPDATE media SET status = 'analyzed', error = NULL WHERE code = ?", [code]);
  })();
}

interface CommonOptions extends SessionOptions {
  full?: boolean; maxPages?: number; minDelay?: number; maxDelay?: number;
  limit?: number; workers?: number; retryErrors?: boolean; redo?: boolean; keepMedia?: boolean;
  provider?: string; model?: string;
}

async function igSync(o: CommonOptions): Promise<void> {
  const db = openDb(IG_DB, IG_SCHEMA_SQL);
  const ig = new Instagram(browserSession("instagram.com", o));
  log(`syncing saved posts for Instagram user id ${ig.userId}`);
  const start = Date.now();
  let seen = 0, fresh = 0, page = 0;
  for await (const items of ig.savedPages([o.minDelay ?? 15, o.maxDelay ?? 30])) {
    page++;
    const known = db.transaction(() => items.filter((m, i) => igUpsert(db, m, start - seen - i)).length)();
    seen += items.length;
    fresh += items.length - known;
    log(`  page ${page}: ${items.length} items, ${items.length - known} new`);
    if (!o.full && known === items.length) break; // caught up with what's stored
    if (o.maxPages && page >= o.maxPages) break;
  }
  log(`sync done: ${fresh} new of ${seen} seen`);
}

/** Logs how a batch ended; rethrows what stopped it unless that was a usage limit. */
function finishBatch(done: number, failed: number, model: Model, spent: number, stop: Fatal | undefined): void {
  log(`processed ${done - failed}, failed ${failed}${model.provider === "openrouter" ? `, cost $${spent.toFixed(4)}` : ""}`);
  if (stop instanceof QuotaError) log(`stopped early: ${stop.message}. The rest stay pending; run again later.`);
  else if (stop) throw stop;
}

async function igProcess(o: CommonOptions): Promise<void> {
  const db = openDb(IG_DB, IG_SCHEMA_SQL);
  const statuses = ["new", ...(o.retryErrors ? ["error"] : []), ...(o.redo ? ["analyzed"] : [])];
  const rows = db.query<{ code: string; raw_json: string }, SQLQueryBindings[]>(
    `SELECT code, raw_json FROM media WHERE status IN (${placeholders(statuses.length)}) ORDER BY saved_order DESC LIMIT ?`,
  ).all(...statuses, o.limit || -1);
  if (!rows.length) return log("nothing to process");
  const model = chooseModel(o);
  const workers = o.workers ?? (model.provider === "openrouter" ? 16 : 4);
  log(`processing ${rows.length} saved posts with ${model.provider} ${model.model} (${workers} workers)`);
  if (!model.video && !Bun.which("ffmpeg")) log("  ffmpeg not found: videos are judged by their cover image only");
  const agent = userAgent("firefox");
  let done = 0, failed = 0, spent = 0;
  let stop: Fatal | undefined;
  await pool(rows, workers, async ({ code, raw_json }) => {
    const folder = join(IG_MEDIA, code);
    try {
      const { result, cost } = await igAnalyze(model, JSON.parse(raw_json), folder, agent);
      igSaveAnalysis(db, code, model.id, result, cost);
      spent += cost ?? 0;
      const found = result.entries.map((e) => `${e.category}: ${e.title}`).join("; ") || "(nothing)";
      log(`  [${++done}/${rows.length}] ${code} -> ${found}`);
    } catch (err) {
      if (err instanceof Fatal) {
        stop ??= err; // usage limit, login or model problem: the same for every item
        return;
      }
      failed++;
      db.run("UPDATE media SET status = 'error', error = ? WHERE code = ?", [errorText(err).slice(0, 2000), code]);
      log(`  [${++done}/${rows.length}] x ${code}: ${err instanceof Error ? err.message : err}`);
    } finally {
      if (!o.keepMedia) rmSync(folder, { recursive: true, force: true }); // transcript and summary stay in the DB
    }
  }, () => stop !== undefined);
  finishBatch(done, failed, model, spent, stop);
}

function igExport(): string[] {
  const db = openDb(IG_DB, IG_SCHEMA_SQL);
  mkdirSync(IG_OUT, { recursive: true });
  type Row = { category: string; title: string; kind: string | null; creator: string | null; location: string | null;
    details: string | null; confidence: number | null; url: string; username: string | null };
  const byCategory = new Map<string, Row[]>();
  for (const row of db.query<Row, []>("SELECT * FROM entries_v ORDER BY saved_order DESC, title").all()) {
    byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
  }
  // One bullet per distinct thing (case-insensitive title); every post that mentioned it is a source.
  const merge = (rows: Row[]) => {
    const merged = new Map<string, Row[]>();
    for (const row of rows) {
      const key = squash(row.title.toLowerCase());
      merged.set(key, [...(merged.get(key) ?? []), row]);
    }
    return [...merged.values()];
  };
  const line = (rows: Row[], heading?: string) => {
    const row = rows[0]!; // the newest save carries the details
    const location = row.location !== heading ? row.location : null;
    const meta = [row.kind, row.creator, location].filter(Boolean).join(" · ");
    const unsure = Math.max(...rows.map((r) => r.confidence ?? 0)) < 0.6 ? " _(unsure)_" : "";
    let text = `- **${row.title}**${unsure}`;
    if (meta) text += ` · ${meta}`;
    if (row.details) text += `: ${row.details}`;
    return `${text} · ${[...new Set(rows.map((r) => `[@${r.username ?? "?"}](${r.url})`))].join(", ")}`;
  };
  // "Shoreditch, London, UK" -> "London, UK", so neighbourhoods share a heading.
  const city = (location: string | null) => location?.split(",").map((p) => p.trim()).filter(Boolean).slice(-2).join(", ") || "Unspecified";

  const written: string[] = [];
  const index: string[] = [];
  for (const [key, [title, description]] of Object.entries(IG_LISTS)) {
    const path = join(IG_OUT, `${key}.md`);
    const rows = byCategory.get(key);
    if (!rows) {
      rmSync(path, { force: true });
      continue;
    }
    const lines = [`# ${title}`, "", `_${merge(rows).length} saved · ${description} · newest first_`, ""];
    if (IG_GROUP_BY_LOCATION[key]) {
      const groups = new Map<string, Row[]>();
      for (const row of rows) groups.set(city(row.location), [...(groups.get(city(row.location)) ?? []), row]);
      const order = [...groups.keys()].sort((a, b) =>
        Number(a === "Unspecified") - Number(b === "Unspecified") || (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
      for (const c of order) lines.push(`## ${c}`, "", ...merge(groups.get(c)!).map((g) => line(g, c)), "");
    } else {
      lines.push(...merge(rows).map((g) => line(g)), "");
    }
    writeFileSync(path, lines.join("\n"));
    written.push(path);
    index.push(`| [${title}](${key}.md) | ${merge(rows).length} |`);
  }
  const pending = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media WHERE status != 'analyzed'").get()!.n;
  const readme = join(IG_OUT, "README.md");
  writeFileSync(readme, ["# Saved reels", "", `_Generated ${clock()} · ${pending} saved posts not analysed yet_`, "",
    "| List | Entries |", "|---|---|", ...index, ""].join("\n"));
  return [readme, ...written];
}

function igStatus(): void {
  const db = openDb(IG_DB, IG_SCHEMA_SQL);
  const counts = (sql: string) => db.query<{ k: string; n: number }, []>(sql).all().map((r) => `${r.k} ${r.n}`).join(", ") || "none";
  console.log(`saved posts     ${counts("SELECT status AS k, COUNT(*) AS n FROM media GROUP BY status")}`);
  console.log(`entries         ${counts("SELECT category AS k, COUNT(*) AS n FROM entries GROUP BY category ORDER BY 2 DESC")}`);
  console.log(`models          ${counts("SELECT model AS k, COUNT(*) AS n FROM analysis GROUP BY model ORDER BY 2 DESC")}`);
  const spend = db.query<{ s: number }, []>("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM analysis").get()!.s;
  console.log(`OpenRouter spend $${spend.toFixed(4)}`);
  for (const row of db.query<{ code: string; error: string }, []>("SELECT code, error FROM media WHERE status = 'error' LIMIT 5").all()) {
    console.log(`error ${row.code}: ${row.error.slice(0, 200)}`);
  }
}

// ── X: bookmarks ───────────────────────────────────────────────────────────────────────────────────

const X_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const X_CHUNKS = "https://abs.twimg.com/responsive-web/client-web";
const CAUGHT_UP_AFTER = 50; // this many stored bookmarks in a row means an incremental sync has caught up
const X_MAX_IMAGES = 4;

// X's GraphQL tweet objects, reduced to the fields read here.
interface XUrl { url: string; expanded_url?: string }
interface XUser { core?: { name?: string; screen_name?: string }; legacy?: { name?: string; screen_name?: string; description?: string } }
interface Tweet {
  rest_id: string;
  sortIndex: string; // added from the timeline entry
  core?: { user_results?: { result?: XUser } };
  legacy: {
    full_text: string;
    created_at: string;
    entities?: { urls?: XUrl[]; media?: { url: string }[] };
    extended_entities?: { media?: { type: string; media_url_https?: string }[] };
  };
  note_tweet?: { note_tweet_results?: { result?: { text: string; entity_set?: { urls?: XUrl[] } } } };
  card?: { legacy?: { binding_values?: { key: string; value: { string_value?: string; image_value?: { url?: string } } }[] } };
  article?: { article_results?: { result?: { title?: string; preview_text?: string } } };
  quoted_status_result?: { result?: TweetResult };
}
/** A timeline result: a post, a post wrapped with visibility info, or a tombstone. */
type TweetResult = Partial<Tweet> & { tweet?: Tweet };
interface XEntry { entryId: string; sortIndex?: string; content?: { value?: string; itemContent?: { value?: string; tweet_results?: { result?: TweetResult } } } }
interface XPage {
  data?: { bookmark_timeline_v2?: { timeline?: { instructions?: { type: string; entries?: XEntry[]; entry?: XEntry }[] } } };
  errors?: { message?: string }[];
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  return diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The `x-client-transaction-id` header x.com's web client signs requests with, derived from the
 * homepage's verification key and loading animation. Ported from gallery-dl (after
 * iSarabjitDhiman/XClientTransaction).
 */
class XTransaction {
  private constructor(private key: Buffer, private animationKey: string) {}

  static async create(homepage: string): Promise<XTransaction> {
    const at = homepage.indexOf('name="twitter-site-verification"');
    const tag = homepage.slice(homepage.lastIndexOf("<", at), homepage.indexOf(">", at));
    const key = tag.match(/content="([^"]+)"/)?.[1];
    if (at < 0 || !key) throw new Fatal("x.com homepage has no twitter-site-verification key; the web client changed");
    let indices: number[] = [];
    for (const url of chunkUrls(homepage, "ondemand.s")) {
      const js = await fetch(url).then((r) => (r.ok ? r.text() : ""));
      indices = [...js.matchAll(/\(\w\[(\d\d?)\],\s*16\)/g)].map((m) => Number(m[1]));
      if (indices.length) break;
    }
    if (!indices.length) throw new Fatal("couldn't find x.com's transaction key indices; the web client changed");
    const frames = homepage.split('id="loading-x-anim-').slice(1).map((s) => s.slice(0, s.indexOf("</svg>")));
    const keyBytes = Buffer.from(key, "base64");
    const frame = frames[keyBytes[5]! % 4];
    if (!frame) throw new Fatal("x.com homepage has no loading animation frames; the web client changed");
    const d = frame.slice(frame.indexOf('</path><path d="') + 16);
    const rows = d.slice(0, d.indexOf('"')).slice(9).split("C").map((p) => p.split(/[^\d]+/).filter(Boolean).map(Number));
    let frameTime = 1;
    for (const i of indices.slice(1)) frameTime *= keyBytes[i]! % 16;
    frameTime = (frameTime / 10 - Math.floor(frameTime / 10) < 0.5 ? Math.floor(frameTime / 10) : Math.ceil(frameTime / 10)) * 10;
    return new XTransaction(keyBytes, XTransaction.animate(rows[keyBytes[indices[0]!]! % 16]!, frameTime / 4096));
  }

  static animate(row: number[], t: number): string {
    const round2 = (x: number) => Number(x.toFixed(2));
    const scale = (v: number, lo: number, hi: number, floor: boolean) => {
      const r = (v * (hi - lo)) / 255 + lo;
      return floor ? Math.floor(r) : round2(r);
    };
    const curve = row.slice(7).map((v, i) => scale(v, i % 2 ? -1 : 0, 1, false));
    const bezier = (a: number, b: number, m: number) => 3 * a * (1 - m) ** 2 * m + 3 * b * (1 - m) * m * m + m ** 3;
    let c: number;
    if (t <= 0) {
      c = (curve[0]! > 0 ? curve[1]! / curve[0]! : curve[1] === 0 && curve[2]! > 0 ? curve[3]! / curve[2]! : 0) * t;
    } else if (t >= 1) {
      c = 1 + (curve[2]! < 1 ? (curve[3]! - 1) / (curve[2]! - 1) : curve[2] === 1 && curve[0]! < 1 ? (curve[1]! - 1) / (curve[0]! - 1) : 0) * (t - 1);
    } else {
      let lo = 0, hi = 1, mid = 0;
      c = NaN;
      while (lo < hi) {
        mid = (lo + hi) / 2;
        const estimate = bezier(curve[0]!, curve[2]!, mid);
        if (Math.abs(t - estimate) < 0.00001) {
          c = bezier(curve[1]!, curve[3]!, mid);
          break;
        }
        if (estimate < t) lo = mid;
        else hi = mid;
      }
      if (Number.isNaN(c)) c = bezier(curve[1]!, curve[3]!, mid);
    }
    const color = [0, 1, 2].map((i) => Math.min(255, Math.max(0, row[i]! * (1 - c) + row[i + 3]! * c)));
    const radians = (scale(row[6]!, 60, 360, true) * c * Math.PI) / 180;
    const matrix = [Math.cos(radians), -Math.sin(radians), Math.sin(radians), Math.cos(radians)];
    const hex = (x: number) => {
      const whole = Math.trunc(x);
      let fraction = x - whole;
      if (!fraction) return whole.toString(16);
      let out = ".";
      while (fraction > 0) {
        fraction *= 16;
        const digit = Math.trunc(fraction);
        fraction -= digit;
        out += digit.toString(16);
      }
      return whole.toString(16) + out;
    };
    return [...color.map((x) => roundHalfEven(x).toString(16)), ...matrix.map((x) => hex(Math.abs(round2(x)))), "00"]
      .join("").replace(/[.-]/g, "");
  }

  id(method: string, path: string): string {
    const nowf = Date.now() / 1000;
    const now = Math.floor(nowf) - 1682924400;
    const time = [now & 0xff, (now >> 8) & 0xff, (now >> 16) & 0xff, (now >> 24) & 0xff];
    const hash = createHash("sha256").update(`${method}!${path}!${now}obfiowerehiring${this.animationKey}`).digest().subarray(0, 16);
    const xor = (Math.floor(Math.random() * 16) << 4) + Math.floor((nowf - Math.floor(nowf)) * 16);
    return Buffer.from([0, ...this.key, ...time, ...hash, 3].map((b) => b ^ xor)).toString("base64").replace(/=+$/, "");
  }
}

/** URLs of a named webpack chunk, from the id -> name and id -> hash maps in x.com's homepage. */
function chunkUrls(homepage: string, name: string): string[] {
  const at = homepage.indexOf(`"${name}"`);
  const id = at < 0 ? undefined : homepage.slice(Math.max(0, at - 24), at).match(/(\w+):$/)?.[1];
  if (!id) return [];
  return [...homepage.matchAll(new RegExp(`[{,]${id}:"([0-9a-f]+)"`, "g"))].map((m) => `${X_CHUNKS}/${name}.${m[1]}a.js`);
}

/** Narrows a timeline result to a post; tombstones and deleted posts have no `legacy`. */
function isTweet(result: TweetResult | undefined): result is Tweet {
  return Boolean(result?.legacy);
}
/** The post in a timeline result (`TweetWithVisibilityResults` wraps it), or null. */
function xUnwrap(result: TweetResult | undefined): Tweet | null {
  const inner = result?.tweet ?? result;
  return isTweet(inner) ? inner : null;
}

/**
 * x.com's private GraphQL Bookmarks timeline, called like the web client: the operation's query id and
 * feature flags are read from x.com's own JavaScript, so they follow X's changes without updates here.
 */
class XClient {
  private headers: Record<string, string>;
  private endpoint = "";
  private features = "";
  private transaction?: XTransaction;
  private resumeAt = 0;

  constructor(private session: Session) {
    const c = session.cookies;
    if (!c.auth_token) throw new Fatal(`no x.com login in ${session.source}; log into x.com there`);
    c.ct0 ??= randomBytes(16).toString("hex");
    this.headers = {
      "User-Agent": session.userAgent,
      Accept: "*/*",
      Referer: "https://x.com/",
      "content-type": "application/json",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      "x-twitter-active-user": "yes",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      authorization: `Bearer ${X_BEARER}`,
    };
  }

  async init(): Promise<void> {
    const res = await fetch("https://x.com/home", {
      headers: { "User-Agent": this.session.userAgent, Cookie: cookieHeader(this.session.cookies) },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Fatal(`x.com sent ${this.session.source} to ${res.headers.get("location")}: log into x.com there again`);
    }
    if (!res.ok) throw new HttpError(res.status, await res.text(), res.headers, "x.com");
    const homepage = await res.text();
    const names = [...new Set([...homepage.matchAll(/\d+:"([^"]*Bookmarks[^"]*)"/g)].map((m) => m[1]!))];
    for (const url of names.flatMap((name) => chunkUrls(homepage, name))) {
      const js = await fetch(url).then((r) => (r.ok ? r.text() : ""));
      const op = js.match(/queryId:"([^"]+)",operationName:"Bookmarks",operationType:"\w+",metadata:\{featureSwitches:\[([^\]]*)\]/);
      if (!op) continue;
      // Every feature the operation declares, set the way the homepage's own config sets it.
      const featureNames: string[] = JSON.parse(`[${op[2]}]`);
      this.features = JSON.stringify(Object.fromEntries(featureNames.map((name) =>
        [name, homepage.match(new RegExp(`"${name}":\\{"value":(true|false)`))?.[1] === "true"])));
      this.endpoint = `/i/api/graphql/${op[1]}/Bookmarks`;
      break;
    }
    if (!this.endpoint) throw new Fatal("couldn't find the Bookmarks operation in x.com's scripts; the web client changed");
    this.transaction = await XTransaction.create(homepage);
  }

  private async page(cursor: string | undefined): Promise<XPage> {
    if (!this.transaction) throw new Error("XClient.init() first");
    const variables = { count: 50, includePromotedContent: false, ...(cursor && { cursor }) };
    const url = `https://x.com${this.endpoint}?${new URLSearchParams({ variables: JSON.stringify(variables), features: this.features })}`;
    for (let attempt = 1; ; attempt++) {
      const wait = this.resumeAt - Date.now() / 1000;
      if (wait > 0) {
        log(`  X rate limit: waiting until ${clock(wait)}`);
        await sleep(wait + 1);
      }
      const res = await fetch(url, {
        headers: {
          ...this.headers,
          "x-csrf-token": this.session.cookies.ct0 ?? "",
          "x-client-transaction-id": this.transaction.id("GET", this.endpoint),
          Cookie: cookieHeader(this.session.cookies),
        },
        signal: AbortSignal.timeout(30_000),
      });
      for (const cookie of res.headers.getSetCookie()) {
        const ct0 = cookie.match(/^ct0=([^;]+)/)?.[1];
        if (ct0) this.session.cookies.ct0 = ct0;
      }
      const remaining = Number(res.headers.get("x-rate-limit-remaining") ?? 10);
      if (remaining <= 1 || res.status === 429) this.resumeAt = Number(res.headers.get("x-rate-limit-reset")) || Date.now() / 1000 + 60;
      if (res.status === 429) continue;
      const text = await res.text();
      let data: XPage;
      try {
        data = JSON.parse(text);
      } catch {
        throw new HttpError(res.status, text, res.headers, "X");
      }
      const errors = (data.errors ?? []).map((e) => e.message).join("; ");
      if (errors.includes("Could not authenticate you") || res.status === 401) {
        throw new Fatal(`X rejected the session from ${this.session.source} (${errors || res.status}); log into x.com again`);
      }
      if (res.ok && data.data) return data;
      if (attempt >= 3) throw new HttpError(res.status, errors || text, res.headers, "X Bookmarks");
      await sleep(5 * attempt);
    }
  }

  /** Bookmarked posts as raw GraphQL tweet objects (with `sortIndex`), most recently bookmarked first. */
  async *bookmarks(): AsyncGenerator<Tweet> {
    let cursor: string | undefined;
    let emptyPages = 0;
    for (let degraded = 0; ;) {
      const instructions = (await this.page(cursor)).data?.bookmark_timeline_v2?.timeline?.instructions;
      if (!instructions) throw new Error("X Bookmarks returned no timeline");
      const entries = instructions.flatMap((i) => i.type === "TimelineAddEntries" ? i.entries ?? []
        : i.type === "TimelineReplaceEntry" && i.entry ? [i.entry] : []);
      const tweets: Tweet[] = [];
      let next: string | undefined;
      for (const entry of entries) {
        if (entry.entryId.startsWith("cursor-bottom-")) next = entry.content?.value ?? entry.content?.itemContent?.value;
        if (!entry.entryId.startsWith("tweet-")) continue;
        const tweet = xUnwrap(entry.content?.itemContent?.tweet_results?.result);
        if (!tweet) continue; // deleted or withheld
        tweet.sortIndex = entry.sortIndex ?? "0";
        tweets.push(tweet);
      }
      // X sometimes sends posts without their author; asking again fixes it.
      if (tweets.some((t) => !t.core?.user_results?.result) && degraded++ < 3) continue;
      degraded = 0;
      yield* tweets.filter((t) => t.core?.user_results?.result);
      emptyPages = tweets.length ? 0 : emptyPages + 1;
      if (!next || next === cursor || emptyPages >= 3) return;
      cursor = next;
      await sleep(1.5 + Math.random() * 1.5);
    }
  }
}

function xUsername(t: Tweet): string | undefined {
  const user = t.core?.user_results?.result;
  return user?.core?.screen_name ?? user?.legacy?.screen_name;
}
function xAuthor(t: Tweet): { name: string; handle: string; bio: string } {
  const user = t.core?.user_results?.result;
  return { name: user?.core?.name || user?.legacy?.name || "", handle: xUsername(t) ?? "", bio: user?.legacy?.description?.trim() ?? "" };
}
/** Expanded URLs in the post (long posts keep theirs in `note_tweet`), in order, deduplicated. */
function xLinks(t: Tweet): string[] {
  const urls = [...(t.legacy.entities?.urls ?? []), ...(t.note_tweet?.note_tweet_results?.result?.entity_set?.urls ?? [])];
  return [...new Set(urls.map((u) => u.expanded_url || u.url))];
}
function xCard(t: Tweet): { title: string; description: string; domain: string; image: string | null } | null {
  const values = Object.fromEntries((t.card?.legacy?.binding_values ?? []).map((b) => [b.key, b.value]));
  if (!Object.keys(values).length) return null;
  const text = (key: string) => values[key]?.string_value || "";
  const imageKey = ["summary_photo_image_large", "thumbnail_image_large", "photo_image_full_size_large", "player_image_large"]
    .find((k) => k in values);
  return { title: text("title"), description: text("description"), domain: text("domain") || text("vanity_url"),
    image: imageKey ? values[imageKey]?.image_value?.url ?? null : null };
}
function xArticle(t: Tweet): { title: string; preview: string } | null {
  const result = t.article?.article_results?.result;
  return result ? { title: result.title || "", preview: result.preview_text || "" } : null;
}
/** [type, image url] for attached photos, videos and GIFs; videos give their poster frame. */
function xMedia(t: Tweet): [type: string, url: string][] {
  return (t.legacy.extended_entities?.media ?? []).flatMap((m): [string, string][] => (m.media_url_https ? [[m.type, m.media_url_https]] : []));
}
/** pbs.twimg.com media at a named size (small ≈ 680 px, large ≈ 2048 px); card images as they are. */
function xImageVariant(url: string, size: string): string {
  const u = new URL(url);
  if (u.hostname !== "pbs.twimg.com" || u.pathname.includes("/card_img/")) return url;
  u.search = `?format=jpg&name=${size}`;
  return u.toString();
}
function htmlUnescape(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : named[e.toLowerCase()] ?? whole);
}
/** Full text (long posts come from `note_tweet`) with t.co links expanded and media links dropped. */
function xText(t: Tweet): string {
  const note = t.note_tweet?.note_tweet_results?.result;
  let body = note ? note.text : htmlUnescape(t.legacy.full_text);
  const urls = (note ? note.entity_set?.urls : t.legacy.entities?.urls) ?? [];
  for (const m of t.legacy.entities?.media ?? []) body = body.replaceAll(m.url, "");
  for (const u of urls) body = body.replaceAll(u.url, u.expanded_url || u.url);
  return body.trim();
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed Oct 10 20:19:24 +0000 2018" -> unix seconds */
function xCreatedAt(t: Tweet): number {
  const [, month = "", day, time = "", zone = "+0000", year] = t.legacy.created_at.split(" ");
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  const offset = (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  return Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), h, m, s) / 1000 - offset * 60;
}
/** The bookmark timeline's sortIndex carries the bookmark time in ms in its upper bits. */
const xBookmarkedAt = (sortIndex: bigint) => Number((sortIndex >> 20n) / 1000n);

const X_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bookmarks (
    tweet_id       TEXT PRIMARY KEY,
    sort_index     INTEGER NOT NULL,  -- bookmark timeline order; higher = bookmarked more recently
    bookmarked_at  INTEGER NOT NULL,  -- unix seconds, decoded from sort_index
    created_at     INTEGER NOT NULL,  -- when the tweet was posted, unix seconds
    username       TEXT,
    text           TEXT NOT NULL,     -- full text, t.co links expanded
    url            TEXT NOT NULL,
    raw_json       TEXT NOT NULL,     -- full GraphQL tweet object, refreshed on every sync that sees it
    first_seen     INTEGER NOT NULL,
    last_seen      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_order ON bookmarks(sort_index);

CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis (
    tweet_id     TEXT PRIMARY KEY REFERENCES bookmarks(tweet_id) ON DELETE CASCADE,
    status       TEXT NOT NULL,     -- ok | error
    error        TEXT,
    model        TEXT,
    analyzed_at  INTEGER NOT NULL,
    intent       TEXT,              -- why it was saved, an X_INTENTS key
    also         TEXT,              -- JSON array of secondary intents
    topic        TEXT,              -- an X_TOPICS key
    title        TEXT,
    note         TEXT,              -- what it is and what is worth coming back for
    link         TEXT,              -- the thing itself (product, repo, article), '' if none
    cost_usd     REAL
);
CREATE INDEX IF NOT EXISTS analysis_intent ON analysis(intent, topic);

CREATE VIEW IF NOT EXISTS bookmarks_v AS
    SELECT b.tweet_id, b.sort_index, b.bookmarked_at, b.username, b.url, b.text,
           a.intent, a.also, a.topic, a.title, a.note, a.link
    FROM bookmarks b JOIN analysis a ON a.tweet_id = b.tweet_id AND a.status = 'ok';
`;

/** Inserts a bookmark or refreshes it (counts change; re-bookmarking moves it up); true if already known. */
function xUpsert(db: Database, t: Tweet, now: number): boolean {
  const order = BigInt(t.sortIndex);
  const url = `https://x.com/${xUsername(t) || "i"}/status/${t.rest_id}`;
  const row: SQLQueryBindings[] = [order, xBookmarkedAt(order), xUsername(t) ?? null, xText(t), url, JSON.stringify(t), now, t.rest_id];
  if (db.query<{ found: number }, [string]>("SELECT 1 AS found FROM bookmarks WHERE tweet_id = ?").get(t.rest_id)) {
    db.run("UPDATE bookmarks SET sort_index = ?, bookmarked_at = ?, username = ?, text = ?, url = ?, raw_json = ?, last_seen = ?"
      + " WHERE tweet_id = ?", row);
    return true;
  }
  db.run("INSERT INTO bookmarks (sort_index, bookmarked_at, username, text, url, raw_json, last_seen, tweet_id, created_at, first_seen)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [...row, xCreatedAt(t), now]);
  return false;
}

const LAST_WALK_SQL = "SELECT value FROM meta WHERE key = 'last_complete_walk'";

async function xSync(o: CommonOptions): Promise<void> {
  const db = openDb(X_DB, X_SCHEMA_SQL);
  const session = browserSession("x.com", o);
  const client = new XClient(session);
  await client.init();
  // Until one walk has reached the end, every sync walks everything: an interrupted first sync would
  // otherwise stop at the bookmarks it already has and never reach the older ones.
  const full = o.full || !db.query<{ value: string }, []>(LAST_WALK_SQL).get();
  log(`syncing X bookmarks from ${session.source} (${full ? "full walk" : "new only"})`);
  const now = nowSeconds();
  let seen = 0, fresh = 0, knownStreak = 0, reachedEnd = true;
  for await (const tweet of client.bookmarks()) {
    const known = xUpsert(db, tweet, now);
    seen++;
    if (!known) fresh++;
    knownStreak = known ? knownStreak + 1 : 0;
    if (seen % 100 === 0) log(`  ${seen} seen, ${fresh} new`);
    if (!full && knownStreak >= CAUGHT_UP_AFTER) {
      reachedEnd = false;
      break;
    }
  }
  if (reachedEnd) {
    db.run("INSERT INTO meta (key, value) VALUES ('last_complete_walk', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [String(now)]);
  }
  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bookmarks").get()!.n;
  log(`sync done: ${fresh} new of ${seen} seen, ${total} stored`);
}

const X_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "also", "topic", "title", "note", "link"],
  properties: {
    intent: { type: "string", enum: Object.keys(X_INTENTS) },
    also: { type: "array", items: { type: "string", enum: Object.keys(X_INTENTS) } },
    topic: { type: "string", enum: Object.keys(X_TOPICS) },
    title: { type: "string" },
    note: { type: "string" },
    link: { type: "string" },
  },
};

/** The bookmark as prompt text, the images worth attaching, and the links the model may pick from. */
function xContext(t: Tweet): { metadata: string; images: [label: string, url: string][]; links: string[] } {
  const who = xAuthor(t);
  const lines = [`Author: ${who.name} (@${who.handle})${who.bio ? `: ${who.bio}` : ""}`,
    `Posted ${localDay(xCreatedAt(t))}, bookmarked ${localDay(xBookmarkedAt(BigInt(t.sortIndex)))}`,
    "Post:", xText(t) || "(no text)"];
  const links = xLinks(t);
  const images: [label: string, url: string][] = xMedia(t).map(([kind, url]) => [`post ${kind}`, url]);
  const card = xCard(t);
  if (card) {
    lines.push(`Link preview: ${card.title}${card.description ? `: ${card.description}` : ""}${card.domain ? ` (${card.domain})` : ""}`);
    if (card.image) images.push(["link preview image", card.image]);
  }
  const article = xArticle(t);
  if (article) lines.push(`X article: ${article.title}: ${article.preview}`);
  const quote = xUnwrap(t.quoted_status_result?.result);
  if (quote) {
    const q = xAuthor(quote);
    lines.push(`Quoted post by ${q.name} (@${q.handle}):`, xText(quote) || "(no text)");
    links.push(...xLinks(quote).filter((u) => !links.includes(u)));
    images.push(...xMedia(quote).map(([kind, url]): [string, string] => [`quoted post ${kind}`, url]));
    const qcard = xCard(quote);
    if (qcard?.title) lines.push(`Quoted post's link preview: ${qcard.title}${qcard.domain ? ` (${qcard.domain})` : ""}`);
  }
  if (links.length) lines.push("Links:", ...links.map((u) => `- ${u}`));
  const attached = images.slice(0, X_MAX_IMAGES);
  if (attached.length) lines.push(`Attached images: ${attached.map(([label], i) => `[${i + 1}] ${label.replaceAll("_", " ")}`).join(", ")}`);
  return { metadata: lines.join("\n"), images: attached, links };
}

/** What the note should name, for the default intents that are in use. */
const X_NOTE_HINTS: Record<string, string> = {
  design: 'for design, the visual element itself (e.g. "dithered gradient texture on pricing cards")',
  product: "for a product, what it does",
  read: "for reading, the subject or claim",
  learn: "for learn, the technique",
  idea: "for an idea, the idea itself",
};

function xPrompt(metadata: string): string {
  const intents = Object.entries(X_INTENTS).map(([key, [, desc]]) => `- ${key}: ${desc}`).join("\n");
  const topics = Object.entries(X_TOPICS).map(([key, label]) => `- ${key}: ${label}`).join("\n");
  const hints = Object.keys(X_INTENTS).flatMap((key) => X_NOTE_HINTS[key] ?? []).join("; ");
  const alsoExample = ["product", "design", "read", "idea"].every((key) => X_INTENTS[key])
    ? ", e.g. a beautifully crafted app launch is\n  product + also design; a paper with one memorable insight is read + also idea" : "";
  return `You sort a person's X (Twitter) bookmarks by why they saved them: one of the intents below.
${ABOUT ? `\nAbout the person, in their words (use it to judge why they saved a post):\n${ABOUT}\n\n` : ""}Work out the most likely reason from the post, its links, link preview, quoted post and the attached
images (video posts are shown as their poster frame).

Intents:
${intents}

Topics:
${topics}

Return JSON:
- intent: the main reason, one intent key.
- also: other intent keys that clearly apply too (at most 2)${alsoExample}. [] if none.
- topic: one topic key.
- title: the thing's name when it has one (product, repo, article or paper title, talk), taken from
  the post, links, preview or images; otherwise a short description, at most 8 words. Never invent a
  name.
- note: one sentence, at most 25 words: what it is and what specifically is worth coming back for.${hints ? `
  ${hints[0]!.toUpperCase()}${hints.slice(1)}.` : ""} Concrete and plain, no hype words.
- link: the URL of the thing itself (product site, repo, article, paper, video), copied exactly from
  the Links below; "" if none fits.

Guidance:
${X_INTENTS.design ? "- Posts that are mostly images or video of visual work with little text usually mean design.\n" : ""}- When the bookmarked post quotes another, judge them together: "this is so good" quoting a launch
  means the launched thing.
- Write in English even when the post is not.

Bookmark:
${metadata}`;
}

interface XResult { intent: string; also: string[]; topic: string; title: string; note: string; link: string }

/** Validates a model answer; `link` must be one of the bookmark's own links. */
function xResult(json: unknown, links: string[]): XResult {
  const r = fields(json);
  const intent = r.intent;
  if (!has(X_INTENTS, intent)) throw new Error(`unknown intent ${JSON.stringify(intent)}`);
  if (!has(X_TOPICS, r.topic)) throw new Error(`unknown topic ${JSON.stringify(r.topic)}`);
  const also = [...new Set(Array.isArray(r.also) ? r.also : [])].filter((i) => has(X_INTENTS, i) && i !== intent).slice(0, 2);
  const [title = "", note = "", link = ""] = [r.title, r.note, r.link].map((v) => squash(typeof v === "string" ? v : ""));
  if (!title) throw new Error("model returned no title");
  return { intent, also, topic: r.topic, title, note, link: links.includes(link) ? link : "" };
}

async function xImage(url: string): Promise<Media | null> {
  const res = await fetch(xImageVariant(url, "small"), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(60_000) });
  if ([403, 404, 410].includes(res.status)) return null; // deleted media: judge from the text alone
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const mime = sniffImage(data);
  return mime ? { kind: "image", mime, data } : null;
}

async function xAnalyze(model: Model, tweet: Tweet): Promise<{ result: XResult; cost: number | null }> {
  const { metadata, images, links } = xContext(tweet);
  const media = (await Promise.all(images.map(([, url]) => xImage(url)))).filter((m) => m !== null);
  return askModel(model, { name: "bookmark", prompt: xPrompt(metadata), schema: X_SCHEMA, media, timeoutMs: 180_000 },
    (json) => xResult(json, links));
}

async function xProcess(o: CommonOptions): Promise<void> {
  const db = openDb(X_DB, X_SCHEMA_SQL);
  const wanted = ["a.tweet_id IS NULL", ...(o.retryErrors ? ["a.status = 'error'"] : []), ...(o.redo ? ["a.status = 'ok'"] : [])];
  const rows = db.query<{ tweet_id: string; raw_json: string }, [number]>(
    `SELECT b.tweet_id, b.raw_json FROM bookmarks b LEFT JOIN analysis a USING (tweet_id) WHERE ${wanted.join(" OR ")}`
      + " ORDER BY b.sort_index DESC LIMIT ?").all(o.limit || -1);
  if (!rows.length) return log("nothing to process");
  const model = chooseModel(o);
  const workers = o.workers ?? (model.provider === "openrouter" ? 12 : 4);
  log(`processing ${rows.length} bookmarks with ${model.provider} ${model.model} (${workers} workers)`);
  let done = 0, failed = 0, spent = 0;
  let stop: Fatal | undefined;
  await pool(rows, workers, async ({ tweet_id, raw_json }) => {
    try {
      const { result: r, cost } = await xAnalyze(model, JSON.parse(raw_json));
      db.run("INSERT OR REPLACE INTO analysis (tweet_id, status, error, model, analyzed_at, intent, also, topic, title, note, link, cost_usd)"
        + " VALUES (?, 'ok', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [tweet_id, model.id, nowSeconds(), r.intent, JSON.stringify(r.also), r.topic, r.title, r.note, r.link, cost]);
      spent += cost ?? 0;
      done++;
    } catch (err) {
      if (err instanceof Fatal) {
        stop ??= err; // usage limit, login or model problem: the same for every item
        return;
      }
      done++;
      failed++;
      // A failed --redo keeps the earlier good result.
      db.run("INSERT INTO analysis (tweet_id, status, error, analyzed_at) VALUES (?, 'error', ?, ?) ON CONFLICT (tweet_id)"
        + " DO UPDATE SET status = 'error', error = excluded.error, analyzed_at = excluded.analyzed_at WHERE analysis.status != 'ok'",
      [tweet_id, errorText(err).slice(0, 1000), nowSeconds()]);
      log(`  [${done}/${rows.length}] x ${tweet_id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
    if (done % 50 === 0 || done === rows.length) log(`  [${done}/${rows.length}]${model.provider === "openrouter" ? ` $${spent.toFixed(3)} so far` : ""}`);
  }, () => stop !== undefined);
  finishBatch(done, failed, model, spent, stop);
}

interface XRow {
  tweet_id: string; bookmarked_at: number; username: string | null; url: string; text: string; intent: string;
  also: string | null; topic: string; title: string; note: string | null; link: string | null;
}

const xHost = (url: string) => (URL.canParse(url) ? new URL(url).hostname.replace(/^www\./, "") : "") || "link";
const mdEscape = (text: string) => text.replace(/([\\`*_[\]<>])/g, "\\$1");

function xViewerItem(row: XRow & { raw_json: string }) {
  const tweet: Tweet = JSON.parse(row.raw_json);
  const quote = xUnwrap(tweet.quoted_status_result?.result);
  const items = (t: Tweet) => xMedia(t).map(([kind, url]) => ({
    thumb: xImageVariant(url, "small"), video: kind !== "photo", full: kind === "photo" ? xImageVariant(url, "large") : null }));
  const card = xCard(tweet);
  const own = items(tweet);
  const media = own.length ? own : card?.image ? [{ thumb: card.image, video: false, full: null }] : quote ? items(quote) : [];
  return {
    id: row.tweet_id, url: row.url, user: row.username, name: xAuthor(tweet).name, date: localDay(row.bookmarked_at),
    intent: row.intent, also: JSON.parse(row.also || "[]"), topic: row.topic, title: row.title, note: row.note,
    link: row.link, linkHost: row.link ? xHost(row.link) : "", text: row.text, media,
    quoted: quote ? { user: xUsername(quote) ?? "", text: xText(quote) } : null,
  };
}

function xExport(): string[] {
  const db = openDb(X_DB, X_SCHEMA_SQL);
  mkdirSync(X_OUT, { recursive: true });
  const intentsOf = (row: XRow): string[] => [row.intent, ...JSON.parse(row.also || "[]")];
  const byIntent = new Map<string, XRow[]>();
  for (const row of db.query<XRow, []>("SELECT * FROM bookmarks_v ORDER BY sort_index DESC").all()) {
    for (const intent of intentsOf(row)) byIntent.set(intent, [...(byIntent.get(intent) ?? []), row]);
  }
  const line = (row: XRow, intent: string) => {
    let text = `- **${mdEscape(row.title)}**`;
    if (row.note) text += `: ${mdEscape(row.note)}`;
    if (row.link) text += ` · [${xHost(row.link)}](${row.link})`;
    text += ` · [@${row.username}, ${localDay(row.bookmarked_at)}](${row.url})`;
    const others = intentsOf(row).filter((i) => i !== intent).map((i) => X_INTENTS[i]?.[0] ?? i);
    return others.length ? `${text} · _also: ${others.join(", ")}_` : text;
  };
  // Rows (newest first) under one heading per topic, biggest topic first.
  const grouped = (rows: XRow[], intent: string, heading: string) => {
    const topics = new Map<string, XRow[]>();
    for (const row of rows) topics.set(row.topic, [...(topics.get(row.topic) ?? []), row]);
    return [...topics.entries()].sort((a, b) => b[1].length - a[1].length).flatMap(([topic, group]) =>
      [`${heading} ${X_TOPICS[topic] ?? topic} (${group.length})`, "", ...group.map((r) => line(r, intent)), ""]);
  };

  const written: string[] = [];
  const index: string[] = [];
  for (const [key, [title, description]] of Object.entries(X_INTENTS)) {
    const path = join(X_OUT, `${key}.md`);
    const rows = byIntent.get(key);
    if (!rows) {
      rmSync(path, { force: true });
      continue;
    }
    const main = rows.filter((r) => r.intent === key);
    const also = rows.filter((r) => r.intent !== key);
    const lines = [`# ${title}`, "", `_${main.length} bookmarks mainly saved for this, ${also.length} more that also fit · ${description}_`, "",
      "Grouped by topic, newest bookmark first. Bookmarks saved mainly for another reason are under “Also fits here” at the end.", "",
      ...grouped(main, key, "##")];
    if (also.length) lines.push(`## Also fits here (${also.length})`, "", ...grouped(also, key, "###"));
    writeFileSync(path, lines.join("\n"));
    written.push(path);
    index.push(`| [${title}](${key}.md) | ${main.length} | ${also.length} |`);
  }

  const data = {
    generated: clock(),
    intents: Object.fromEntries(Object.entries(X_INTENTS).map(([key, [title]]) => [key, title])),
    topics: X_TOPICS,
    items: db.query<XRow & { raw_json: string }, []>(
      "SELECT v.*, b.raw_json FROM bookmarks_v v JOIN bookmarks b USING (tweet_id) ORDER BY v.sort_index DESC").all().map(xViewerItem),
  };
  // Inside <script>, "<", ">" and "&" are escaped so no post text can close the tag.
  const blob = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
  const viewer = join(X_OUT, "bookmarks.html");
  writeFileSync(viewer, VIEWER_HTML.replace("__BOOKMARKS_DATA__", () => blob));

  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bookmarks").get()!.n;
  const sorted = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM bookmarks_v").get()!.n;
  const readme = join(X_OUT, "README.md");
  writeFileSync(readme, ["# X bookmarks by why they were saved", "", `_Generated ${clock()} · ${sorted} of ${total} bookmarks sorted_`, "",
    "Browse, search and tick them off in [bookmarks.html](bookmarks.html).", "",
    "| List | Mainly | Also |", "|---|---|---|", ...index, ""].join("\n"));
  return [readme, viewer, ...written];
}

function xStatus(): void {
  const db = openDb(X_DB, X_SCHEMA_SQL);
  const b = db.query<{ n: number; lo: number | null; hi: number | null }, []>(
    "SELECT COUNT(*) AS n, MIN(bookmarked_at) AS lo, MAX(bookmarked_at) AS hi FROM bookmarks").get()!;
  const day = (ts: number | null | undefined) => (ts ? localDay(ts) : "-");
  console.log(`bookmarks      ${b.n}  (bookmarked ${day(b.lo)} .. ${day(b.hi)})`);
  const walk = db.query<{ value: string }, []>(LAST_WALK_SQL).get();
  console.log(`last full walk ${walk ? day(Number(walk.value)) : "never"}`);
  const counts = Object.fromEntries(db.query<{ status: string; n: number }, []>("SELECT status, COUNT(*) AS n FROM analysis GROUP BY status")
    .all().map((r) => [r.status, r.n]));
  const spend = db.query<{ s: number }, []>("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM analysis").get()!.s;
  const ok = counts.ok ?? 0, bad = counts.error ?? 0;
  console.log(`analysed       ${ok} ok, ${bad} failed, ${b.n - ok - bad} pending  ($${spend.toFixed(3)} OpenRouter spend)`);
  for (const r of db.query<{ intent: string; n: number }, []>("SELECT intent, COUNT(*) AS n FROM analysis WHERE status = 'ok' GROUP BY intent ORDER BY 2 DESC").all()) {
    console.log(`  ${(X_INTENTS[r.intent]?.[0] ?? r.intent).padEnd(20)} ${r.n}`);
  }
  for (const r of db.query<{ model: string; n: number }, []>("SELECT model, COUNT(*) AS n FROM analysis WHERE status = 'ok' GROUP BY model ORDER BY 2 DESC").all()) {
    console.log(`  model ${r.model}: ${r.n}`);
  }
  for (const r of db.query<{ tweet_id: string; error: string }, []>("SELECT tweet_id, error FROM analysis WHERE status = 'error' LIMIT 5").all()) {
    console.log(`error ${r.tweet_id}: ${r.error.slice(0, 200)}`);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────

const USAGE = `unrot: the reels and posts you saved and never went back to, sorted into lists you'll use.

Subscriptions: the login of Claude Code, Codex CLI, oh-my-pi or pi on this machine is reused (read-only),
as is CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`). Without one of those:
  bun unrot.ts login <claude|codex>     log in with Claude Pro/Max or ChatGPT (browser OAuth)
  bun unrot.ts logout <claude|codex>    forget that login
  bun unrot.ts models <claude|codex>    models your account can use, and which login is used
  bun unrot.ts lists                    the lists in use, as JSON (copy into lists.json to change them)

  bun unrot.ts ig <command> [options]   Instagram saved posts
  bun unrot.ts x <command> [options]    X bookmarks

Commands (ig and x):
  run              sync, then process, then export
  sync             fetch new saves (ig: 15-30 s between pages; x: stops once caught up)
                     --full              walk everything (ig: also refreshes expired media URLs)
                     --max-pages N       ig only: stop after N pages of 50
  process          one model call per unsorted item
                     --limit N  --workers N  --retry-errors  --redo
                     --keep-media        ig only: keep downloaded media (default: deleted after analysis)
  export           rewrite the lists (ig: Markdown; x: Markdown + bookmarks.html)
  status           counts, models, spend, recent errors
  cookies-export FILE   write the site's cookies as cookies.txt, to run elsewhere with --cookies

Browser session (sync):
  --browser NAME   firefox (default when installed), chrome, chromium, brave, edge, vivaldi, arc, dia
  --profile DIR    browser profile (default: the one the browser opens)
  --cookies FILE   a Netscape cookies.txt instead of a browser

Model (process):
  --provider P     claude | codex | openrouter (default: openrouter if OPENROUTER_API_KEY is set,
                   else claude, else codex, whichever has a login)
  --model ID       defaults: claude ${DEFAULT_MODELS.claude}, codex ${DEFAULT_MODELS.codex}, openrouter ${DEFAULT_MODELS.openrouter}

Data lives in ${HOME} (UNROT_HOME). Tune sorting with two files there:
  about.md     who you are and why you save things, in your words; every prompt includes it
  lists.json   your own lists (see \`bun unrot.ts lists\`); then run \`process --redo\`
Settings can go in its .env: OPENROUTER_API_KEY, UNROT_PROVIDER, UNROT_MODEL, UNROT_BROWSER`;

async function main(argv: string[]): Promise<void> {
  const { values: v, positionals: [group, command, arg] } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      full: { type: "boolean" }, "max-pages": { type: "string" }, "min-delay": { type: "string" }, "max-delay": { type: "string" },
      limit: { type: "string" }, workers: { type: "string" }, "retry-errors": { type: "boolean" }, redo: { type: "boolean" },
      "keep-media": { type: "boolean" }, provider: { type: "string" }, model: { type: "string" },
      browser: { type: "string" }, profile: { type: "string" }, cookies: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  const number = (name: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Fatal(`--${name} needs a number, got "${value}"`);
    return n;
  };
  const o: CommonOptions = {
    full: v.full, maxPages: number("max-pages", v["max-pages"]), minDelay: number("min-delay", v["min-delay"]),
    maxDelay: number("max-delay", v["max-delay"]), limit: number("limit", v.limit), workers: number("workers", v.workers),
    retryErrors: v["retry-errors"], redo: v.redo, keepMedia: v["keep-media"], provider: v.provider, model: v.model,
    browser: v.browser, profile: v.profile, cookies: v.cookies,
  };
  if (o.workers === 0) throw new Fatal("--workers must be at least 1");
  if (v.help || !group || group === "help") return console.log(USAGE);

  if (group === "login") return login(command);
  if (group === "logout") {
    if (command !== "claude" && command !== "codex") throw new Fatal("usage: bun unrot.ts logout <claude|codex>");
    const auth = readAuth();
    delete auth[command];
    writeAuth(auth);
    return console.log(`logged out of ${command}`);
  }
  if (group === "models") return listModels(command);
  if (group === "lists") {
    const instagram = { lists: IG_LISTS, groupByLocation: Object.keys(IG_GROUP_BY_LOCATION) };
    return console.log(JSON.stringify({ instagram, x: { intents: X_INTENTS, topics: X_TOPICS } }, null, 2));
  }

  const source = group === "ig" || group === "instagram" ? "ig" : group === "x" || group === "twitter" ? "x" : undefined;
  if (!source) throw new Fatal(`unknown command "${group}"; see \`bun unrot.ts help\``);
  const sync = source === "ig" ? igSync : xSync;
  const processItems = source === "ig" ? igProcess : xProcess;
  const exportLists = () => {
    for (const path of source === "ig" ? igExport() : xExport()) console.log(path);
  };
  switch (command) {
    case "sync": return sync(o);
    case "process": return processItems(o);
    case "export": return exportLists();
    case "run":
      await sync(o);
      await processItems(o);
      return exportLists();
    case "status": return source === "ig" ? igStatus() : xStatus();
    case "cookies-export": {
      if (!arg) throw new Fatal(`usage: bun unrot.ts ${source} cookies-export FILE`);
      const domain = source === "ig" ? "instagram.com" : "x.com";
      const session = browserSession(domain, o);
      if (!session.cookies[source === "ig" ? "sessionid" : "auth_token"]) throw new Fatal(`no ${domain} login in ${session.source}`);
      writeNetscapeCookies(session.cookies, domain, arg);
      return console.log(`wrote ${arg} (mode 600) from ${session.source}; elsewhere run: bun unrot.ts ${source} sync --cookies ${arg}`);
    }
    default:
      throw new Fatal(`unknown ${source} command "${command ?? ""}"; see \`bun unrot.ts help\``);
  }
}

// ── X bookmarks viewer (written by `x export`; data replaces __BOOKMARKS_DATA__) ─────────────────────

const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X bookmarks</title>
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --soft: #f5f5f4;
          --accent: #2563eb; --ok: #15803d; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c0a09; --fg: #e7e5e4; --muted: #a8a29e; --line: #292524; --card: #1c1917; --soft: #292524;
            --accent: #60a5fa; --ok: #4ade80; }
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; color: inherit; cursor: pointer; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line);
           padding: 12px 20px 10px; }
  .top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: var(--muted); }
  .tabs, .controls, .topics { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
  .tab { border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 5px 11px; }
  .tab .n { color: var(--muted); margin-left: 4px; }
  .tab[aria-pressed="true"] { background: var(--fg); border-color: var(--fg); color: var(--bg); }
  .tab[aria-pressed="true"] .n { color: inherit; opacity: .7; }
  .controls { gap: 14px; }
  input[type="search"] { flex: 1 1 260px; max-width: 420px; padding: 6px 10px; border: 1px solid var(--line);
                         border-radius: 8px; background: var(--card); color: var(--fg); font: inherit; }
  label { display: flex; gap: 5px; align-items: center; color: var(--muted); cursor: pointer; }
  select, .plain { border: 1px solid var(--line); background: var(--card); color: var(--fg); font: inherit;
                   border-radius: 8px; padding: 4px 9px; }
  .chip { border: 1px solid var(--line); background: var(--soft); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { padding: 16px 20px 80px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; align-items: start; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
          display: flex; flex-direction: column; }
  .card.is-done { opacity: .5; }
  .media { position: relative; display: block; aspect-ratio: 16 / 10; overflow: hidden; background: var(--soft); }
  .media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .badge { position: absolute; right: 8px; bottom: 8px; background: rgba(0, 0, 0, .65); color: #fff;
           border-radius: 6px; padding: 1px 7px; font-size: 12px; }
  .body { padding: 12px 14px; display: flex; flex-direction: column; gap: 7px; }
  h3 { margin: 0; font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
  .note { margin: 0; overflow-wrap: anywhere; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
  .tag { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--soft); }
  .tag.main { color: var(--fg); }
  details { font-size: 13px; }
  summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  .text, blockquote { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
  blockquote { padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
  .actions { display: flex; justify-content: flex-end; }
  .done { border: 1px solid var(--line); background: none; border-radius: 8px; padding: 3px 10px; font-size: 12px; }
  .card.is-done .done { color: var(--ok); border-color: var(--ok); }
  .empty { color: var(--muted); text-align: center; padding: 60px 0; }
  .toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 3; display: flex; gap: 14px;
           background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 8px; }
  .toast button { background: none; border: 0; text-decoration: underline; padding: 0; }
</style>

<header>
  <div class="top">
    <h1>X bookmarks</h1>
    <span class="muted" id="progress"></span>
    <span class="muted" id="generated"></span>
  </div>
  <nav class="tabs" id="tabs"></nav>
  <div class="controls">
    <input type="search" id="q" placeholder="Search titles, notes, post text, @authors   ( / )" autocomplete="off">
    <label><input type="checkbox" id="also" checked> Include secondary reasons</label>
    <label><input type="checkbox" id="hide-done"> Hide done</label>
    <select id="sort" aria-label="Order">
      <option value="new">Newest bookmark first</option>
      <option value="old">Oldest bookmark first</option>
    </select>
    <button type="button" class="plain" id="mark-shown"></button>
  </div>
  <div class="topics" id="topics"></div>
</header>
<main>
  <div class="grid" id="grid"></div>
  <p class="empty" id="empty" hidden>Nothing matches.</p>
</main>
<div class="toast" id="toast" hidden></div>

<script id="data" type="application/json">__BOOKMARKS_DATA__</script>
<script>
"use strict";
const D = JSON.parse(document.getElementById("data").textContent);
const DONE_KEY = "xbm:done", HIDE_KEY = "xbm:hide-done";
const done = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
const state = { tab: "all", topic: "", q: "", also: true, hideDone: localStorage.getItem(HIDE_KEY) === "1", oldest: false };
const $ = (id) => document.getElementById(id);
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

// Builds elements with textContent only: post text never becomes markup.
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
const extLink = (url, text) => {
  const href = safeUrl(url);
  return href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text }) : el("span", { text });
};

function buildCard(it) {
  const card = el("article", { class: "card" });
  const cover = it.media[0];
  if (cover && safeUrl(cover.thumb)) {
    const media = el("a", { class: "media", href: safeUrl(cover.full) || safeUrl(it.url), target: "_blank",
                            rel: "noopener noreferrer" });
    media.append(el("img", { src: cover.thumb, loading: "lazy", alt: "", onerror: () => media.remove() }));
    const badge = [cover.video ? "▶ video" : "", it.media.length > 1 ? "+" + (it.media.length - 1) : ""]
      .filter(Boolean).join("  ");
    if (badge) media.append(el("span", { class: "badge", text: badge }));
    card.append(media);
  }
  const body = el("div", { class: "body" }, el("h3", { text: it.title }),
                  it.note ? el("p", { class: "note", text: it.note }) : null);
  const links = el("div", { class: "row" });
  if (it.link) links.append(extLink(it.link, it.linkHost + " ↗"));
  links.append(extLink(it.url, "@" + it.user + " · " + it.date));
  body.append(links, el("div", { class: "row" },
    el("span", { class: "tag main", text: D.intents[it.intent] }),
    ...it.also.map((a) => el("span", { class: "tag", text: "also " + D.intents[a] })),
    el("span", { class: "tag", text: D.topics[it.topic] })));
  if (it.text || it.quoted) {
    const details = el("details", {}, el("summary", { text: "Post text" }));
    if (it.text) details.append(el("p", { class: "text", text: it.text }));
    if (it.quoted) details.append(el("blockquote", { text: "@" + it.quoted.user + ": " + it.quoted.text }));
    body.append(details);
  }
  const button = el("button", { type: "button", class: "done", onclick: () => toggleDone(it.id) });
  body.append(el("div", { class: "actions" }, button));
  card.append(body);
  card.doneButton = button;
  return card;
}

const cards = new Map();
for (const it of D.items) {
  it.hay = [it.title, it.note, it.text, it.user, it.name, it.link, it.quoted && it.quoted.user,
            it.quoted && it.quoted.text].filter(Boolean).join("\n").toLowerCase();
  cards.set(it.id, buildCard(it));
}

function paintDone(id) {
  const card = cards.get(id), isDone = done.has(id);
  card.classList.toggle("is-done", isDone);
  card.doneButton.textContent = isDone ? "✓ Done" : "Mark done";
}

function setDone(ids, value) {
  for (const id of ids) value ? done.add(id) : done.delete(id);
  localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  ids.forEach(paintDone);
  apply();
}

function toggleDone(id) {
  const value = !done.has(id);
  setDone([id], value);
  if (value) toast("Marked done", () => setDone([id], false));
}

let toastTimer;
function toast(message, undo) {
  const t = $("toast");
  t.replaceChildren(el("span", { text: message }),
                    el("button", { type: "button", text: "Undo", onclick: () => { undo(); t.hidden = true; } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function shows(it, tab, ignoreTopic) {
  if (tab !== "all" && it.intent !== tab && !(state.also && it.also.includes(tab))) return false;
  if (state.hideDone && done.has(it.id)) return false;
  if (!ignoreTopic && state.topic && it.topic !== state.topic) return false;
  return !state.q || it.hay.includes(state.q);
}

const tabs = ["all", ...Object.keys(D.intents)].map((key) => {
  const button = el("button", { type: "button", class: "tab", onclick: () => setTab(key) },
                    key === "all" ? "All" : D.intents[key], el("span", { class: "n" }));
  button.dataset.tab = key;
  $("tabs").append(button);
  return button;
});

let shown = [];
function apply() {
  shown = D.items.filter((it) => shows(it, state.tab, false));
  const visible = new Set(shown.map((it) => it.id));
  for (const [id, card] of cards) card.hidden = !visible.has(id);
  $("empty").hidden = shown.length > 0;

  for (const button of tabs) {
    const key = button.dataset.tab;
    button.setAttribute("aria-pressed", String(key === state.tab));
    button.querySelector(".n").textContent = D.items.filter((it) => shows(it, key, true)).length;
  }

  const counts = {};
  for (const it of D.items) if (shows(it, state.tab, true)) counts[it.topic] = (counts[it.topic] || 0) + 1;
  if (state.topic && !(state.topic in counts)) counts[state.topic] = 0;  // keep the active filter visible
  const chip = (key, label) => el("button", { type: "button", class: "chip", "aria-pressed": String(state.topic === key),
                                              text: label, onclick: () => { state.topic = key; apply(); } });
  $("topics").replaceChildren(chip("", "All topics"),
    ...Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((t) => chip(t, D.topics[t] + " " + counts[t])));

  const total = D.items.length, finished = D.items.filter((it) => done.has(it.id)).length;
  $("progress").textContent = finished + " of " + total + " done";
  const open = shown.filter((it) => !done.has(it.id)).length;
  $("mark-shown").textContent = "Mark " + open + " shown as done";
  $("mark-shown").disabled = open === 0;
}

function setTab(key) {
  state.tab = key;
  state.topic = "";
  history.replaceState(null, "", key === "all" ? location.pathname : "#" + key);
  apply();
  window.scrollTo(0, 0);
}

function order() {
  const items = state.oldest ? [...D.items].reverse() : D.items;
  $("grid").replaceChildren(...items.map((it) => cards.get(it.id)));
}

let searchTimer;
$("q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); apply(); }, 120);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $("q").focus();
  }
});
$("also").addEventListener("change", (e) => { state.also = e.target.checked; apply(); });
$("hide-done").checked = state.hideDone;
$("hide-done").addEventListener("change", (e) => {
  state.hideDone = e.target.checked;
  localStorage.setItem(HIDE_KEY, state.hideDone ? "1" : "0");
  apply();
});
$("sort").addEventListener("change", (e) => { state.oldest = e.target.value === "old"; order(); });
$("mark-shown").addEventListener("click", () => {
  const ids = shown.filter((it) => !done.has(it.id)).map((it) => it.id);
  if (!ids.length || !confirm("Mark " + ids.length + " bookmarks as done?")) return;
  setDone(ids, true);
  toast("Marked " + ids.length + " done", () => setDone(ids, false));
});

$("generated").textContent = "generated " + D.generated;
const tabFromHash = () => (location.hash.slice(1) in D.intents ? location.hash.slice(1) : "all");
window.addEventListener("hashchange", () => { if (tabFromHash() !== state.tab) setTab(tabFromHash()); });
state.tab = tabFromHash();
D.items.forEach((it) => paintDone(it.id));
order();
apply();
</script>
</html>
`;

process.on("SIGINT", () => {
  log("interrupted; everything finished so far is saved");
  process.exit(130);
});
main(Bun.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof Fatal || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      log(`error: ${err.message}`);
    } else {
      log(err instanceof Error ? err.stack ?? err.message : String(err));
    }
    process.exit(1);
  },
);
