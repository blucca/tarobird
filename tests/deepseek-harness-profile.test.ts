import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareDeepSeekHarnessHome } from "../src/codex/deepseek-harness-host.js";
import { prepareDeepSeekHarnessPrivateProfile } from "../src/codex/deepseek-harness-profile.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const fsCalls = vi.hoisted(() => ({
  symlinkTypes: [] as Array<string | undefined>,
  unlinkEpermFor: new Set<string>(),
  rmdir: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (target: string, file: string, type?: string) => {
      fsCalls.symlinkTypes.push(type);
      return await actual.symlink(target, file, type as never);
    },
    // Synthetic Windows: a directory junction refuses unlink and is removed by rmdir.
    unlink: async (file: string) => {
      if (fsCalls.unlinkEpermFor.has(file)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: "EPERM" });
      }
      return await actual.unlink(file);
    },
    rmdir: async (file: string) => {
      fsCalls.rmdir.push(file);
      if (fsCalls.unlinkEpermFor.delete(file)) return await actual.unlink(file);
      return await actual.rmdir(file);
    },
  };
});

vi.mock("../src/codex/deepseek-office-fonts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex/deepseek-office-fonts.js")>(),
  readDeepSeekOfficeConfig: vi.fn(async () => "[]"),
}));

const roots: string[] = [];

afterEach(async () => {
  fsCalls.symlinkTypes.length = 0;
  fsCalls.unlinkEpermFor.clear();
  fsCalls.rmdir.length = 0;
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const SHARED_PATCH = [
  "- id: agent-default-model",
  "  config:",
  "    provider: native-provider",
  "    model: native-model",
  "",
].join("\n");

interface Fixture {
  root: string;
  sharedHome: string;
  sharedProfile: string;
  stateDir: string;
  privateProfile: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-"));
  roots.push(root);
  const sharedHome = path.join(root, "shared");
  const sharedProfile = path.join(sharedHome, "profiles", "web");
  const stateDir = path.join(root, "bot");
  await mkdir(path.join(sharedProfile, "node_modules", "plugin-a"), { recursive: true });
  await mkdir(path.join(sharedProfile, "node_modules", "@scope", "plugin-b"), { recursive: true });
  await mkdir(path.join(sharedProfile, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(sharedProfile, "extra-dir"), { recursive: true });
  await mkdir(path.join(sharedHome, "profiles", "other"), { recursive: true });
  await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });
  await writeFile(path.join(sharedProfile, "cordis.patch.yml"), SHARED_PATCH, { mode: 0o600 });
  await writeFile(path.join(sharedProfile, "package.json"), '{"name":"dsh-profile-web"}\n');
  await writeFile(path.join(sharedProfile, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  await writeFile(path.join(sharedProfile, "cordis.yml"), "[]\n");
  await writeFile(path.join(sharedProfile, "package.json.lock"), "123\n");
  await writeFile(path.join(sharedProfile, "cordis.patch.yml.abc123.tmp"), "partial\n");
  await writeFile(path.join(sharedProfile, "node_modules", ".modules.yaml"), "hoisted\n");
  await writeFile(path.join(sharedProfile, "node_modules", "plugin-a", "index.js"), "export {};\n");
  await writeFile(path.join(sharedProfile, "node_modules", "@scope", "plugin-b", "index.js"), "export {};\n");
  await writeFile(path.join(sharedHome, "profiles", "other", "cordis.patch.yml"), "[]\n");
  return { root, sharedHome, sharedProfile, stateDir, privateProfile: path.join(stateDir, "dsh-home", "profiles", "web") };
}

/** Every entry under a tree, without following links, with content identity for files. */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const key = path.relative(root, full);
      if (info.isSymbolicLink()) out[key] = `link:${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[key] = "dir";
        await walk(full);
      } else {
        const digest = createHash("sha256").update(await readFile(full)).digest("hex");
        out[key] = `file:${digest}:${info.ino}:${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return out;
}

/** dsh's writeFileAtomic: a sibling temp file renamed over the target. */
async function dshSaveDefault(patchPath: string, contents: string): Promise<void> {
  const temp = `${patchPath}.${randomUUID().slice(0, 12)}.tmp`;
  await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
  await rename(temp, patchPath);
}

describe("DeepSeek Harness private profile", () => {
  it("copies profile files, links shared packages, and never writes the shared home", async () => {
    const f = await fixture();
    const before = await tree(f.sharedHome);

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect(await tree(f.sharedHome)).toEqual(before);
    const privateProfiles = path.join(prepared.home, "profiles");
    expect((await lstat(privateProfiles)).isDirectory()).toBe(true);
    expect((await lstat(f.privateProfile)).isDirectory()).toBe(true);
    expect((await readdir(privateProfiles)).sort()).toEqual(["web"]);

    for (const name of ["cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]) {
      const target = path.join(f.privateProfile, name);
      const info = await lstat(target);
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
      expect(await readFile(target, "utf8")).toBe(await readFile(path.join(f.sharedProfile, name), "utf8"));
    }
    // dsh-owned boot, lock and temp files are not mirrored.
    for (const name of ["cordis.yml", "package.json.lock", "cordis.patch.yml.abc123.tmp"]) {
      await expect(lstat(path.join(f.privateProfile, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const modules = path.join(f.privateProfile, "node_modules");
    expect((await lstat(modules)).isDirectory()).toBe(true);
    expect((await lstat(modules)).isSymbolicLink()).toBe(false);
    expect((await readdir(modules)).sort()).toEqual([".bin", "@scope", "plugin-a"]);
    expect(await readlink(path.join(modules, "plugin-a"))).toBe(path.join(f.sharedProfile, "node_modules", "plugin-a"));
    expect(await readlink(path.join(modules, ".bin"))).toBe(path.join(f.sharedProfile, "node_modules", ".bin"));
    expect((await lstat(path.join(modules, "@scope"))).isDirectory()).toBe(true);
    expect(await readlink(path.join(modules, "@scope", "plugin-b")))
      .toBe(path.join(f.sharedProfile, "node_modules", "@scope", "plugin-b"));
    expect(await readlink(path.join(f.privateProfile, "extra-dir"))).toBe(path.join(f.sharedProfile, "extra-dir"));
    expect(await readFile(path.join(modules, "plugin-a", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("keeps a Bot's saved default private and refreshes it one-way on the next start", async () => {
    const f = await fixture();
    const prepared = await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const privatePatch = path.join(f.privateProfile, "cordis.patch.yml");
    const sharedPatch = path.join(f.sharedProfile, "cordis.patch.yml");
    const sharedBefore = await tree(f.sharedHome);

    await dshSaveDefault(privatePatch, SHARED_PATCH.replace("native-model", "bot-model"));

    expect(await tree(f.sharedHome)).toEqual(sharedBefore);
    expect(await readFile(sharedPatch, "utf8")).toBe(SHARED_PATCH);
    expect(await readFile(privatePatch, "utf8")).toContain("bot-model");

    // The user changes the native default; the Bot adopts it at its next start.
    const nativeChange = SHARED_PATCH.replace("native-model", "native-model-2");
    await writeFile(sharedPatch, nativeChange);
    const sharedAfterNative = await tree(f.sharedHome);
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect(await readFile(privatePatch, "utf8")).toBe(nativeChange);
    expect(await tree(f.sharedHome)).toEqual(sharedAfterNative);
    expect(prepared.home).toBe(path.join(f.stateDir, "dsh-home"));
  });

  it("migrates an existing Bot's profiles link without touching the shared profile", async () => {
    const f = await fixture();
    const privateHome = path.join(f.stateDir, "dsh-home");
    await mkdir(privateHome, { recursive: true });
    await symlink(path.join(f.sharedHome, "profiles"), path.join(privateHome, "profiles"), "dir");
    const before = await tree(f.sharedHome);

    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await lstat(path.join(privateHome, "profiles"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(f.privateProfile, "cordis.patch.yml"), "utf8")).toBe(SHARED_PATCH);

    // A second start keeps the same private layout and copies.
    const privateLayout = await tree(path.join(privateHome, "profiles"));
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    expect(await tree(path.join(privateHome, "profiles"))).toEqual(privateLayout);
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("migrates a Windows profiles junction by removing only the link (synthetic platform)", async () => {
    const f = await fixture();
    const privateHome = path.join(f.stateDir, "dsh-home");
    const oldLink = path.join(privateHome, "profiles");
    await mkdir(privateHome, { recursive: true });
    await symlink(path.join(f.sharedHome, "profiles"), oldLink, "dir");
    const before = await tree(f.sharedHome);
    fsCalls.unlinkEpermFor.add(oldLink);
    fsCalls.symlinkTypes.length = 0;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    expect(fsCalls.rmdir).toEqual([oldLink]);
    expect(fsCalls.symlinkTypes.length).toBeGreaterThan(0);
    expect(new Set(fsCalls.symlinkTypes)).toEqual(new Set(["junction"]));
    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await lstat(oldLink)).isDirectory()).toBe(true);
    expect((await lstat(oldLink)).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(f.privateProfile, "package.json"))).isFile()).toBe(true);
  });

  it("drops entries the shared profile no longer has and keeps unexpected private data", async () => {
    const f = await fixture();
    await writeFile(path.join(f.sharedProfile, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const modules = path.join(f.privateProfile, "node_modules");
    await mkdir(path.join(modules, "local-only"), { recursive: true });
    await writeFile(path.join(modules, "local-only", "keep.txt"), "private\n");
    await writeFile(path.join(f.privateProfile, "cordis.yml"), "[]\n");

    await rm(path.join(f.sharedProfile, "node_modules", "plugin-a"), { recursive: true });
    await rm(path.join(f.sharedProfile, "node_modules", "@scope"), { recursive: true });
    await rm(path.join(f.sharedProfile, "pnpm-lock.yaml"));
    await rm(path.join(f.sharedProfile, "extra-dir"), { recursive: true });
    const before = await tree(f.sharedHome);
    const diagnostics: string[] = [];
    await prepareDeepSeekHarnessHome({
      sharedHome: f.sharedHome,
      stateDir: f.stateDir,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await readdir(modules)).sort()).toEqual([".bin", "local-only"]);
    expect(await readFile(path.join(modules, "local-only", "keep.txt"), "utf8")).toBe("private\n");
    expect(diagnostics.some((line) => line.includes(path.join(modules, "local-only")))).toBe(true);
    for (const name of ["pnpm-lock.yaml", "extra-dir"]) {
      await expect(lstat(path.join(f.privateProfile, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // dsh's own boot file is left alone.
    expect(await readFile(path.join(f.privateProfile, "cordis.yml"), "utf8")).toBe("[]\n");
  });

  it("leaves a missing shared web profile for dsh to initialize privately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-empty-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot") });

    expect(await readdir(path.join(prepared.home, "profiles", "web"))).toEqual([]);
    expect(await readdir(path.join(sharedHome, "profiles"))).toEqual([]);
  });

  it("still requires the shared profiles directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-missing-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    await mkdir(sharedHome, { recursive: true });
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });

    await expect(prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot") }))
      .rejects.toThrow(`DeepSeek Harness shared dir is missing: ${path.join(sharedHome, "profiles")}`);
  });

  it("replaces a private file link instead of writing through it", async () => {
    const f = await fixture();
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const privatePackage = path.join(f.privateProfile, "package.json");
    await rm(privatePackage);
    await symlink(path.join(f.sharedProfile, "package.json"), privatePackage, "file");
    await chmod(path.join(f.sharedProfile, "package.json"), 0o644);
    const before = await tree(f.sharedHome);

    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect((await lstat(privatePackage)).isSymbolicLink()).toBe(false);
    expect(await readFile(privatePackage, "utf8")).toBe('{"name":"dsh-profile-web"}\n');
    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await stat(path.join(f.sharedProfile, "package.json"))).mode & 0o777).toBe(0o644);
  });
});
