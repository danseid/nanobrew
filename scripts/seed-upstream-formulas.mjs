#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ANALYTICS_URL = "https://formulae.brew.sh/api/analytics/install-on-request/30d.json";
const FORMULA_URL = "https://formulae.brew.sh/api/formula.json";
const GITHUB_API = "https://api.github.com";
const DEFAULT_REGISTRY = "registry/upstream.json";
const DEFAULT_EMBEDDED_REGISTRY = "src/upstream/registry_default.json";
const JSON_FETCH_TIMEOUT_MS = 15_000;
const ARCHIVE_FETCH_TIMEOUT_MS = 25_000;
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;

const PLATFORM_MATCHERS = {
  "macos-arm64": [
    /(?:aarch64|arm64).*apple-darwin/i,
    /macos.*(?:arm64|aarch64)/i,
    /darwin.*(?:arm64|aarch64)/i,
  ],
  "macos-x86_64": [
    /x86_64.*apple-darwin/i,
    /macos.*(?:amd64|x86_64|x64)/i,
    /darwin.*(?:amd64|x86_64|x64)/i,
  ],
  "linux-x86_64": [
    /x86_64.*linux.*(?:musl|gnu)?/i,
    /linux.*(?:amd64|x86_64|x64)/i,
  ],
  "linux-aarch64": [
    /(?:aarch64|arm64).*linux.*(?:musl|gnu)?/i,
    /linux.*(?:aarch64|arm64)/i,
  ],
};

const BOTTLE_PLATFORM_TAGS = {
  "macos-arm64": ["arm64_tahoe", "arm64_sequoia", "arm64_sonoma", "arm64_ventura", "arm64_monterey", "all"],
  "macos-x86_64": ["tahoe", "sequoia", "sonoma", "ventura", "monterey", "big_sur", "all"],
  "linux-x86_64": ["x86_64_linux", "all"],
  "linux-aarch64": ["aarch64_linux", "arm64_linux", "all"],
};

const BINARY_NAME_OVERRIDES = new Map([
  ["ripgrep", ["rg"]],
  ["uv", ["uv", "uvx"]],
]);

function parseArgs(argv) {
  const opts = {
    limit: 5,
    scan: 250,
    write: false,
    replace: false,
    registry: DEFAULT_REGISTRY,
    embeddedRegistry: DEFAULT_EMBEDDED_REGISTRY,
    analyticsFile: null,
    formulaFile: null,
    includeExisting: false,
    includeDependencies: false,
    tokens: [],
    selfTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit") {
      opts.limit = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg.startsWith("--limit=")) {
      opts.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    } else if (arg === "--scan") {
      opts.scan = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg.startsWith("--scan=")) {
      opts.scan = Number.parseInt(arg.slice("--scan=".length), 10);
    } else if (arg === "--write") {
      opts.write = true;
    } else if (arg === "--replace") {
      opts.replace = true;
    } else if (arg === "--include-existing") {
      opts.includeExisting = true;
    } else if (arg === "--include-dependencies") {
      opts.includeDependencies = true;
    } else if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg === "--tokens") {
      opts.tokens.push(...splitList(argv[++i] ?? ""));
    } else if (arg.startsWith("--tokens=")) {
      opts.tokens.push(...splitList(arg.slice("--tokens=".length)));
    } else if (arg === "--registry") {
      opts.registry = argv[++i] ?? "";
    } else if (arg.startsWith("--registry=")) {
      opts.registry = arg.slice("--registry=".length);
    } else if (arg === "--embedded-registry") {
      opts.embeddedRegistry = argv[++i] ?? "";
    } else if (arg.startsWith("--embedded-registry=")) {
      opts.embeddedRegistry = arg.slice("--embedded-registry=".length);
    } else if (arg === "--analytics-file") {
      opts.analyticsFile = argv[++i] ?? "";
    } else if (arg.startsWith("--analytics-file=")) {
      opts.analyticsFile = arg.slice("--analytics-file=".length);
    } else if (arg === "--formula-file") {
      opts.formulaFile = argv[++i] ?? "";
    } else if (arg.startsWith("--formula-file=")) {
      opts.formulaFile = arg.slice("--formula-file=".length);
    } else if (arg === "-h" || arg === "--help") {
      usage(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      usage(1);
    }
  }

  if (!Number.isInteger(opts.limit) || opts.limit < 1) die("--limit must be a positive integer");
  if (!Number.isInteger(opts.scan) || opts.scan < opts.limit) die("--scan must be an integer >= --limit");
  if (!opts.registry) die("--registry must not be empty");
  if (!opts.embeddedRegistry) die("--embedded-registry must not be empty");
  return opts;
}

function usage(code) {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: scripts/seed-upstream-formulas.mjs [options]

Seed popular formula records into the verified upstream registry.

Options:
  --limit N                  Records to generate (default: 5)
  --scan N                   Popular formula rows to inspect (default: 250)
  --write                    Update registry files; otherwise print candidates
  --replace                  Replace existing formula records for generated tokens
  --include-existing         Include already-seeded records in printed output
  --include-dependencies     Also seed Homebrew bottle records for dependency closure
  --self-test                Run offline helper checks and exit
  --tokens a,b               Seed these tokens instead of scanning analytics rank
  --registry PATH            Registry to update (default: ${DEFAULT_REGISTRY})
  --embedded-registry PATH   Embedded fallback to update (default: ${DEFAULT_EMBEDDED_REGISTRY})
  --analytics-file PATH      Read analytics JSON from disk instead of fetching
  --formula-file PATH        Read formula JSON from disk instead of fetching
  -h, --help                 Show this help

Set GITHUB_TOKEN to raise GitHub API limits.
`);
  process.exit(code);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    runSelfTest();
    return;
  }

  const [registry, analytics, formulae] = await Promise.all([
    readJson(opts.registry),
    loadJson(ANALYTICS_URL, opts.analyticsFile),
    loadJson(FORMULA_URL, opts.formulaFile),
  ]);

  const formulaByName = new Map(formulae.map((formula) => [formula.name, formula]));
  const analyticsByFormula = new Map((analytics.items ?? []).map((item) => [item.formula, item]));
  const existing = new Set((registry.records ?? []).map((record) => `${record.kind}:${record.token}`));
  const candidates = [];
  const skipped = [];

  const seedItems = opts.tokens.length > 0
    ? opts.tokens.map((token) => ({
      formula: token,
      ...(analyticsByFormula.get(token) ?? {}),
    }))
    : (analytics.items ?? []).slice(0, opts.scan);

  for (const item of seedItems) {
    if (candidates.length >= opts.limit) break;
    const token = item.formula;
    if (!token) continue;
    if (!opts.replace && !opts.includeExisting && existing.has(`formula:${token}`)) {
      skipped.push({ token, reason: "already seeded" });
      continue;
    }

    const formula = formulaByName.get(token);
    if (!formula) {
      skipped.push({ token, reason: "formula metadata missing" });
      continue;
    }

    const releaseSeeded = await trySeedReleaseRecord(formula, item);
    if (releaseSeeded.ok) {
      candidates.push(releaseSeeded.record);
      continue;
    }

    const bottleSeeded = seedBottleRecordFromFormula(formula, item);
    if (bottleSeeded.ok) {
      candidates.push(bottleSeeded.record);
      continue;
    }

    skipped.push({ token, reason: `${releaseSeeded.reason}; ${bottleSeeded.reason}` });
  }

  if (opts.includeDependencies) {
    seedDependencyClosure({
      registry,
      formulaByName,
      analyticsByFormula,
      candidates,
      skipped,
      replace: opts.replace,
    });
  }

  if (!opts.write) {
    process.stdout.write(JSON.stringify({ records: candidates, skipped: skipped.slice(0, 40) }, null, 2));
    process.stdout.write("\n");
    return;
  }

  const next = {
    schema_version: registry.schema_version ?? 1,
    records: mergeRecords(registry.records ?? [], candidates, opts.replace),
  };
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  await writeFile(opts.registry, rendered);
  await writeFile(opts.embeddedRegistry, rendered);
  console.error(`seeded ${candidates.length} formula record(s): ${candidates.map((record) => record.token).join(", ")}`);
}

async function trySeedReleaseRecord(formula, analyticsItem = null) {
  const runtimeDependencies = stringArray(formula.dependencies);
  if (runtimeDependencies.length > 0) {
    return { ok: false, reason: "runtime dependencies present" };
  }

  const repo = githubRepoForFormula(formula);
  if (!repo) return { ok: false, reason: "no GitHub upstream repo" };

  const release = await fetchLatestRelease(repo);
  if (!release.ok) return release;

  return seedRecordFromRelease(formula, analyticsItem, repo, release.data);
}

function seedDependencyClosure({ registry, formulaByName, analyticsByFormula, candidates, skipped, replace }) {
  const recordsByToken = new Map();
  for (const record of registry.records ?? []) {
    if (record.kind !== "formula") continue;
    if (!replace || !candidates.some((candidate) => candidate.token === record.token)) {
      recordsByToken.set(record.token, record);
    }
  }
  for (const record of candidates) {
    if (record.kind === "formula") recordsByToken.set(record.token, record);
  }

  const queue = [];
  const queued = new Set();
  for (const record of recordsByToken.values()) {
    for (const dep of record.dependencies ?? []) {
      if (!recordsByToken.has(dep) && !queued.has(dep)) {
        queue.push(dep);
        queued.add(dep);
      }
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const token = queue[cursor];
    if (recordsByToken.has(token)) continue;
    const formula = formulaByName.get(token);
    if (!formula) {
      skipped.push({ token, reason: "dependency formula metadata missing" });
      continue;
    }

    const seeded = seedBottleRecordFromFormula(formula, analyticsByFormula.get(token));
    if (!seeded.ok) {
      skipped.push({ token, reason: `dependency ${seeded.reason}` });
      continue;
    }

    candidates.push(seeded.record);
    recordsByToken.set(token, seeded.record);
    for (const dep of seeded.record.dependencies ?? []) {
      if (!recordsByToken.has(dep) && !queued.has(dep)) {
        queue.push(dep);
        queued.add(dep);
      }
    }
  }
}

function seedBottleRecordFromFormula(formula, analyticsItem = null) {
  const version = formula?.versions?.stable ?? "";
  const bottle = formula?.bottle?.stable;
  const files = bottle?.files;
  if (!version) return { ok: false, reason: "stable version missing" };
  if (!files || typeof files !== "object") return { ok: false, reason: "bottle metadata missing" };

  const resolvedAssets = {};
  for (const [platform, tags] of Object.entries(BOTTLE_PLATFORM_TAGS)) {
    const bottleFile = bottleFileForPlatform(files, tags);
    if (!bottleFile) continue;
    resolvedAssets[platform] = {
      url: bottleFile.url,
      sha256: bottleFile.sha256,
    };
    const minimumMacosMajor = minimumMacosMajorForTag(bottleFile.tag);
    if (minimumMacosMajor !== null) resolvedAssets[platform].minimum_macos_major = minimumMacosMajor;
  }

  if (!resolvedAssets["macos-arm64"]) {
    return { ok: false, reason: "no macos-arm64 bottle with sha256" };
  }

  return {
    ok: true,
    record: {
      token: formula.name,
      name: formula.full_name ?? formula.name,
      kind: "formula",
      homepage: formula.homepage ?? "",
      desc: formula.desc ?? "",
      revision: numberOrZero(formula.revision),
      rebuild: numberOrZero(bottle.rebuild),
      dependencies: stringArray(formula.dependencies),
      build_dependencies: stringArray(formula.build_dependencies),
      upstream: {
        type: "homebrew_bottle",
        verified: true,
      },
      analytics: {
        install_on_request_30d_rank: Number.parseInt(String(analyticsItem?.number ?? ""), 10) || undefined,
        install_on_request_30d_count: analyticsItem?.count ?? "",
      },
      resolved: {
        version,
        assets: resolvedAssets,
      },
      verification: {
        sha256: "required",
      },
    },
  };
}

function bottleFileForPlatform(files, tags) {
  for (const tag of tags) {
    const file = files[tag];
    if (typeof file?.url === "string" && file.url.length > 0 && isSha256(file.sha256)) {
      return {
        url: file.url,
        sha256: file.sha256.toLowerCase(),
        tag,
      };
    }
  }
  return null;
}

const MACOS_TAG_MAJOR = {
  big_sur: 11,
  monterey: 12,
  ventura: 13,
  sonoma: 14,
  sequoia: 15,
  tahoe: 26,
  golden_gate: 27,
};

// The client rejects a pin when the running macOS is older than this.
function minimumMacosMajorForTag(tag) {
  return MACOS_TAG_MAJOR[tag.replace(/^arm64_/, "")] ?? null;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadJson(url, file) {
  if (file) return readJson(file);
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json",
      "user-agent": "nanobrew-upstream-formula-seeder",
    },
  }, JSON_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`fetch failed for ${url}: HTTP ${response.status}`);
  return response.json();
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "nanobrew-upstream-formula-seeder",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchLatestRelease(repo) {
  const response = await fetchWithTimeout(`${GITHUB_API}/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
  }, JSON_FETCH_TIMEOUT_MS).catch((err) => ({ ok: false, status: 0, statusText: err?.message ?? "fetch failed" }));
  if (!response.ok) return { ok: false, reason: `latest release fetch failed: HTTP ${response.status}` };
  const data = await response.json();
  if (!Array.isArray(data.assets) || data.assets.length === 0) return { ok: false, reason: "latest release has no assets" };
  return { ok: true, data };
}

async function seedRecordFromRelease(formula, analyticsItem, repo, release) {
  const tag = release.tag_name ?? "";
  const version = versionFromTag(tag);
  const assets = {};
  const resolvedAssets = {};

  for (const [platform, matchers] of Object.entries(PLATFORM_MATCHERS)) {
    const asset = selectPlatformAsset(release.assets, platform, matchers);
    if (!asset) continue;
    const sha256 = sha256FromDigest(asset.digest);
    if (!sha256) continue;
    assets[platform] = {
      pattern: patternFromAsset(asset.name, tag, version),
    };
    resolvedAssets[platform] = {
      url: asset.browser_download_url,
      sha256,
    };
  }

  if (!resolvedAssets["macos-arm64"]) {
    return { ok: false, reason: "no macos-arm64 release asset with sha256 digest" };
  }

  const binaryPaths = await inferBinaryPaths(resolvedAssets["macos-arm64"].url, formula.name);
  if (binaryPaths.length === 0) {
    return { ok: false, reason: "could not infer binary path from macos-arm64 asset" };
  }

  return {
    ok: true,
    record: {
      token: formula.name,
      name: formula.full_name ?? formula.name,
      kind: "formula",
      homepage: formula.homepage ?? "",
      desc: formula.desc ?? "",
      upstream: {
        type: "github_release",
        repo,
        verified: true,
      },
      analytics: {
        install_on_request_30d_rank: Number.parseInt(String(analyticsItem.number ?? ""), 10) || undefined,
        install_on_request_30d_count: analyticsItem.count ?? "",
      },
      assets,
      artifacts: binaryPaths.map((path) => ({ type: "binary", path })),
      resolved: {
        tag,
        version,
        assets: resolvedAssets,
      },
      verification: {
        sha256: "asset_digest",
      },
    },
  };
}

function selectPlatformAsset(assets, platform, matchers) {
  return assets.find((asset) => {
    const name = asset?.name ?? "";
    if (!isInstallArchive(name)) return false;
    if (!sha256FromDigest(asset.digest)) return false;
    if (platform.startsWith("linux-") && /android/i.test(name)) return false;
    return matchers.some((matcher) => matcher.test(name));
  }) ?? null;
}

function isInstallArchive(name) {
  if (/\.(deb|rpm|pkg|msi|sha256|sig|asc|txt)$/i.test(name)) return false;
  return /\.(tar\.gz|tgz|tar\.xz|txz|zip)$/i.test(name);
}

function sha256FromDigest(value) {
  if (typeof value !== "string") return "";
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function patternFromAsset(name, tag, version) {
  let pattern = name;
  if (tag) pattern = pattern.split(tag).join("{tag}");
  if (version && version !== tag) pattern = pattern.split(version).join("{version}");
  return pattern;
}

async function inferBinaryPaths(url, token) {
  const temp = await mkdtemp(join(tmpdir(), "nanobrew-upstream-formula-"));
  try {
    const archivePath = join(temp, archiveNameFromUrl(url));
    const body = await fetchArchiveBuffer(url);
    if (!body) return [];
    await writeFile(archivePath, body);

    const entries = await listArchive(archivePath).catch(() => []);
    if (entries.length === 0) return [];
    const relativeEntries = stripCommonRoot(entries);
    return chooseBinaryPaths(relativeEntries, token);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function fetchArchiveBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "nanobrew-upstream-formula-seeder" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_ARCHIVE_BYTES) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function archiveNameFromUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean).at(-1) || "asset";
  } catch {
    return "asset";
  }
}

async function listArchive(path) {
  if (/\.zip$/i.test(path)) {
    const { stdout } = await execFileAsync("unzip", ["-Z1", path], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }
  const { stdout } = await execFileAsync("tar", ["-tf", path], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function stripCommonRoot(entries) {
  const cleaned = entries
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  const roots = new Set(cleaned.map((entry) => entry.split("/")[0]));
  if (roots.size !== 1) return cleaned;
  const [root] = [...roots];
  if (!cleaned.some((entry) => entry.startsWith(`${root}/`))) return cleaned;
  return cleaned
    .filter((entry) => entry !== root)
    .map((entry) => entry.slice(root.length + 1))
    .filter(Boolean);
}

function chooseBinaryPaths(entries, token) {
  const wantedNames = BINARY_NAME_OVERRIDES.get(token) ?? [token];
  const rejected = /(?:^|\/)(?:README|LICENSE|CHANGELOG|COPYING|completions?|autocomplete|doc|docs?|man)(?:$|[./])/i;
  const candidates = entries
    .filter((entry) => !entry.endsWith("/"))
    .filter((entry) => !rejected.test(entry))
    .filter((entry) => !/\.(md|txt|1|5|json|yaml|yml|bash|fish|zsh|ps1|dll|dylib|so|a|h|hpp)$/i.test(entry));

  const selected = [];
  for (const wanted of wantedNames) {
    const exact = candidates.find((entry) => basename(entry) === wanted);
    if (exact) {
      selected.push(exact);
      continue;
    }

    const binExact = candidates.find((entry) => entry.startsWith("bin/") && basename(entry) === wanted);
    if (binExact) selected.push(binExact);
  }
  if (selected.length > 0) return [...new Set(selected)];

  return [];
}

function basename(path) {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function runSelfTest() {
  assert.deepEqual(stripCommonRoot(["starship"]), ["starship"]);
  assert.deepEqual(stripCommonRoot(["tool-1.0/", "tool-1.0/bin/tool"]), ["bin/tool"]);
  assert.deepEqual(chooseBinaryPaths(["starship"], "starship"), ["starship"]);
  assert.deepEqual(chooseBinaryPaths(["bin/uv", "bin/uvx"], "uv"), ["bin/uv", "bin/uvx"]);
  assert.deepEqual(chooseBinaryPaths(["yq_darwin_arm64"], "yq"), []);
  assert.deepEqual(splitList("starship, yq,,uv"), ["starship", "yq", "uv"]);
  process.stdout.write("upstream formula seeder self-test passed\n");
}

function numberOrZero(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.length > 0)
    : [];
}

function githubRepoForFormula(formula) {
  for (const value of [formula?.urls?.stable?.url, formula?.homepage]) {
    const repo = githubRepoFromUrl(value);
    if (repo) return repo;
  }
  return "";
}

function githubRepoFromUrl(value) {
  if (typeof value !== "string") return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.hostname !== "github.com") return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const repo = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
  return `${parts[0]}/${repo}`;
}

function versionFromTag(tag) {
  return /^[vV]\d/.test(tag) ? tag.slice(1) : tag;
}

function mergeRecords(existing, generated, replace) {
  const existingKeys = new Set(existing.map((record) => `${record.kind}:${record.token}`));
  const generatedByKey = new Map(generated.map((record) => [`${record.kind}:${record.token}`, record]));
  const seenGenerated = new Set();
  const merged = existing.map((record) => {
    const key = `${record.kind}:${record.token}`;
    if (replace && generatedByKey.has(key)) {
      seenGenerated.add(key);
      return generatedByKey.get(key);
    }
    return record;
  });
  const additions = generated
    .filter((record) => {
      const key = `${record.kind}:${record.token}`;
      if (seenGenerated.has(key)) return false;
      if (!replace && existingKeys.has(key)) return false;
      return true;
    })
    .sort((a, b) => String(a.token).localeCompare(String(b.token)));
  return [...merged, ...additions];
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
