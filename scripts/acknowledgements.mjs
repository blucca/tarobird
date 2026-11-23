#!/usr/bin/env node
/**
 * Generate and verify third-party acknowledgements from a single list
 * (`third-party/acknowledgements.json`) plus bundled npm runtime dependencies.
 *
 * Usage:
 *   node scripts/acknowledgements.mjs generate [--root <dir>]
 *   node scripts/acknowledgements.mjs check    [--root <dir>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_CATEGORIES = new Set(["asset", "vendored", "npm", "android", "ios"]);
const REQUIRED_FIELDS = ["id", "name", "category", "repository", "version", "license", "licenseFile", "usage", "location"];
const TABLE_START = "<!-- acknowledgements:table:start -->";
const TABLE_END = "<!-- acknowledgements:table:end -->";
const LICENSE_FILENAMES = [
  "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE-MIT", "LICENSE-MIT.txt", "LICENSE-APACHE",
  "LICENCE", "LICENCE.md", "LICENCE.txt", "COPYING", "COPYING.txt", "license", "license.md", "license.txt",
];
const NOTICE_FILENAMES = ["NOTICE", "NOTICE.md", "NOTICE.txt", "notice.txt"];

function normalizeRepoUrl(repo) {
  if (!repo) return "";
  const raw = typeof repo === "string" ? repo : typeof repo === "object" && typeof repo.url === "string" ? repo.url : "";
  if (!raw) return "";
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function readSafeRepoFile(rootDir, relativePath, fieldLabel) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`Missing ${fieldLabel}`);
  }
  const resolved = path.resolve(rootDir, relativePath);
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (resolved !== rootDir && !resolved.startsWith(rootPrefix)) {
    throw new Error(`Path escapes repository root for ${fieldLabel}: ${relativePath}`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`Missing file for ${fieldLabel}: ${relativePath}`);
  }
  const text = readFileSync(resolved, "utf8").trim();
  if (!text) {
    throw new Error(`Empty license/notice text for ${fieldLabel}: ${relativePath}`);
  }
  return text;
}

function findPackageFile(pkgDir, candidates) {
  if (!existsSync(pkgDir)) return undefined;
  let files;
  try { files = readdirSync(pkgDir); } catch { return undefined; }
  const lowerMap = new Map(files.map((name) => [name.toLowerCase(), name]));
  for (const candidate of candidates) {
    const match = lowerMap.get(candidate.toLowerCase());
    if (match) {
      const full = path.join(pkgDir, match);
      try {
        const text = readFileSync(full, "utf8").trim();
        if (text) return { file: match, text };
      } catch { /* ignore unreadable */ }
    }
  }
  return undefined;
}

function collectNpmDependencies(rootDir, manifestEntries) {
  const manualIds = new Set(manifestEntries.map((entry) => entry.id));
  const manualNames = new Set(manifestEntries.map((entry) => entry.name.toLowerCase()));
  const sources = [
    { pkgJson: path.join(rootDir, "client", "package.json"), nodeModules: path.join(rootDir, "client", "node_modules"), location: "client/package.json", usage: "Bundled client App runtime dependency" },
    { pkgJson: path.join(rootDir, "package.json"), nodeModules: path.join(rootDir, "node_modules"), location: "package.json", usage: "Bundled Host / CLI runtime dependency" },
  ];

  const byPkgName = new Map();
  for (const source of sources) {
    if (!existsSync(source.pkgJson)) continue;
    const pkg = JSON.parse(readFileSync(source.pkgJson, "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {}).sort();
    for (const depName of deps) {
      // Skip packages already represented explicitly in third-party/acknowledgements.json (e.g. xlsx).
      if (depName === "xlsx" && manualIds.has("sheetjs-xlsx")) continue;
      if (manualNames.has(depName.toLowerCase())) continue;

      const existing = byPkgName.get(depName);
      if (existing) {
        if (!existing.locations.includes(source.location)) existing.locations.push(source.location);
        continue;
      }

      const pkgDir = path.join(source.nodeModules, ...depName.split("/"));
      const pkgMetaPath = path.join(pkgDir, "package.json");
      if (!existsSync(pkgMetaPath)) {
        throw new Error(`Cannot inspect installed npm package "${depName}" at ${pkgMetaPath}`);
      }
      const meta = JSON.parse(readFileSync(pkgMetaPath, "utf8"));
      const licenseDecl = typeof meta.license === "string"
        ? meta.license
        : typeof meta.license?.type === "string"
          ? meta.license.type
          : Array.isArray(meta.licenses)
            ? meta.licenses.map((item) => item?.type).filter(Boolean).join(" OR ")
            : "";

      const foundLicense = findPackageFile(pkgDir, LICENSE_FILENAMES);
      let licenseText = foundLicense?.text ?? "";
      if (!licenseText) {
        // Check README.md for embedded license section if no standalone LICENSE file was shipped.
        const readme = findPackageFile(pkgDir, ["README.md", "readme.md"]);
        if (readme && /license/i.test(readme.text)) {
          const match = readme.text.match(/##?\s*licen[cs]e[\s\S]*$/i);
          if (match) licenseText = match[0].trim();
        }
      }
      if (!licenseText && licenseDecl) {
        const author = typeof meta.author === "string" ? meta.author : meta.author?.name ?? depName;
        licenseText = `${depName} ${meta.version ?? ""}\nLicense: ${licenseDecl}\nAuthor: ${author}\nSource: ${normalizeRepoUrl(meta.repository) || meta.homepage || `https://www.npmjs.com/package/${depName}`}`;
      }
      if (!licenseText) {
        throw new Error(`Bundled npm package "${depName}" has no license text or SPDX license declaration.`);
      }

      const notice = findPackageFile(pkgDir, NOTICE_FILENAMES);
      byPkgName.set(depName, {
        id: `npm:${depName}`,
        name: depName,
        category: "npm",
        repository: normalizeRepoUrl(meta.repository) || meta.homepage || `https://www.npmjs.com/package/${depName}`,
        version: String(meta.version ?? pkg.dependencies[depName] ?? ""),
        license: licenseDecl || "See license text",
        usage: (typeof meta.description === "string" && meta.description.trim()) ? meta.description.trim() : source.usage,
        locations: [source.location],
        licenseText,
        ...(notice ? { noticeText: notice.text } : {}),
      });
    }
  }

  return [...byPkgName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ locations, ...item }) => ({ ...item, location: locations.join(", ") }));
}

export function buildAcknowledgements(rootDir) {
  const manifestPath = path.join(rootDir, "third-party", "acknowledgements.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Invalid third-party/acknowledgements.json: expected { version: 1, entries: [...] }");
  }

  const seenIds = new Set();
  const curated = manifest.entries.map((entry, idx) => {
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        throw new Error(`Entry #${idx} (${entry.id ?? entry.name ?? "unknown"}) is missing required field "${field}".`);
      }
    }
    if (!VALID_CATEGORIES.has(entry.category)) {
      throw new Error(`Entry "${entry.id}" has invalid category "${entry.category}".`);
    }
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate entry id "${entry.id}" in third-party/acknowledgements.json.`);
    }
    seenIds.add(entry.id);

    const licenseText = readSafeRepoFile(rootDir, entry.licenseFile, `${entry.id}.licenseFile`);
    const noticeText = entry.noticeFile ? readSafeRepoFile(rootDir, entry.noticeFile, `${entry.id}.noticeFile`) : undefined;

    return {
      id: entry.id.trim(),
      name: entry.name.trim(),
      category: entry.category,
      repository: entry.repository.trim(),
      version: entry.version.trim(),
      license: entry.license.trim(),
      usage: entry.usage.trim(),
      location: entry.location.trim(),
      licenseText,
      ...(noticeText ? { noticeText } : {}),
    };
  });

  const npmDeps = collectNpmDependencies(rootDir, manifest.entries);
  const entries = [...curated, ...npmDeps];
  return { version: 1, entries, curatedCount: curated.length, npmCount: npmDeps.length };
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderLicensingTable(curatedEntries) {
  const rows = [
    "| Component | Version / commit | License | Location & usage |",
    "| --- | --- | --- | --- |",
    ...curatedEntries.map((entry) => {
      const link = entry.repository ? `[${escapeCell(entry.name)}](${entry.repository})` : escapeCell(entry.name);
      return `| ${link} | \`${escapeCell(entry.version)}\` | ${escapeCell(entry.license)} | \`${escapeCell(entry.location)}\` — ${escapeCell(entry.usage)} |`;
    }),
    "| Bundled npm runtime dependencies | Pinned in `package-lock.json` & `client/package-lock.json` | Various (MIT, Apache-2.0, ISC, BSD, etc.) | Generated into `client/src/generated/acknowledgements.json` and viewable in Settings → About → Acknowledgements |",
  ];
  return `${TABLE_START}\n${rows.join("\n")}\n${TABLE_END}`;
}

export function updateLicensingMarkdown(currentText, curatedEntries) {
  const start = currentText.indexOf(TABLE_START);
  const end = currentText.indexOf(TABLE_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`LICENSING.md must contain ${TABLE_START} and ${TABLE_END} markers.`);
  }
  const table = renderLicensingTable(curatedEntries);
  return `${currentText.slice(0, start)}${table}${currentText.slice(end + TABLE_END.length)}`;
}

export function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== "generate" && command !== "check") {
    console.error("Usage: node scripts/acknowledgements.mjs <generate|check> [--root <dir>]");
    return 2;
  }
  const rootIdx = argv.indexOf("--root");
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rootDir = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : defaultRoot;

  const built = buildAcknowledgements(rootDir);
  const curatedEntries = built.entries.slice(0, built.curatedCount);
  const outJsonPath = path.join(rootDir, "client", "src", "generated", "acknowledgements.json");
  const licensingPath = path.join(rootDir, "LICENSING.md");

  const payload = JSON.stringify({ version: built.version, entries: built.entries }, null, 2) + "\n";
  const currentLicensing = readFileSync(licensingPath, "utf8");
  const nextLicensing = updateLicensingMarkdown(currentLicensing, curatedEntries);

  if (command === "generate") {
    const jsonOnly = argv.includes("--json-only");
    mkdirSync(path.dirname(outJsonPath), { recursive: true });
    writeFileSync(outJsonPath, payload, "utf8");
    if (!jsonOnly) {
      writeFileSync(licensingPath, nextLicensing, "utf8");
    }
    console.log(`Generated acknowledgements (${built.curatedCount} curated + ${built.npmCount} npm = ${built.entries.length} entries).`);
    return 0;
  }

  // check mode: verify all manifest license texts, npm package license texts, and LICENSING.md sync.
  if (currentLicensing !== nextLicensing) {
    throw new Error(`LICENSING.md acknowledgements table is out of date. Run "npm run acknowledgements:generate".`);
  }
  console.log(`Acknowledgements verified (${built.entries.length} entries, all license texts present).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
