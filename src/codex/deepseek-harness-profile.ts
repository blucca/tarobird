import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** The DSH profile every Bot boots (`dsh web`, `dsh --profile web --dump-config`). */
export const DEEPSEEK_HARNESS_PROFILE = "web";

export interface PrepareDeepSeekHarnessPrivateProfileOptions {
  sharedHome: string;
  privateHome: string;
  onDiagnostic?: (message: string) => void;
}

export interface PreparedDeepSeekHarnessPrivateProfile {
  profileDir: string;
  patchPath: string;
}

// dsh rewrites the profile root on every boot and keeps its write locks and
// atomic-write temp files beside their targets. They belong to the process
// using this directory, so they are neither mirrored nor removed.
const DSH_OWNED_ENTRY = /^cordis\.yml$|\.lock(?:\.takeover-[0-9a-f]+)?$|\.tmp$/;
// The dsh 0.1.5 link backend's projection, which current dsh deletes on start.
const LEGACY_LINK_PROJECTION_DIR = ".dsh-module-fallback";
const PACKAGE_DIRECTORY = "node_modules";

/**
 * Give one Bot a private copy of the shared DSH profile.
 *
 * dsh saves every model and reasoning choice (`session/selectModel` stores the
 * default for new sessions in the background) and every settings edit into
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A linked `profiles`
 * directory let one Bot rewrite the default of every other Bot and of the
 * user's own `dsh web`, even when the value equalled a home-patch pin.
 *
 * The private profile is refreshed one-way from the shared one on every Host
 * start. Regular files (including `cordis.patch.yml`) become private copies;
 * `node_modules` becomes a private directory whose package entries link to the
 * shared packages (dsh loads them as linked roots, so declared peers keep the
 * installation's copies); other directories link to the shared ones. dsh-owned
 * boot, lock and temp files stay private. Nothing under the shared home is
 * written. An old `profiles` link or junction is migrated by removing only the
 * link itself, and no recursive removal is ever applied to a link.
 */
export async function prepareDeepSeekHarnessPrivateProfile(
  options: PrepareDeepSeekHarnessPrivateProfileOptions,
): Promise<PreparedDeepSeekHarnessPrivateProfile> {
  const sharedProfiles = path.join(path.resolve(options.sharedHome), "profiles");
  await stat(sharedProfiles).then((info) => {
    if (!info.isDirectory()) throw new Error(`DeepSeek Harness shared dir is missing: ${sharedProfiles}`);
  }, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`DeepSeek Harness shared dir is missing: ${sharedProfiles}`);
    throw error;
  });

  const privateProfiles = path.join(path.resolve(options.privateHome), "profiles");
  const profileDir = path.join(privateProfiles, DEEPSEEK_HARNESS_PROFILE);
  await ensurePrivateDirectory(privateProfiles);
  await ensurePrivateDirectory(profileDir);

  const sharedProfile = path.join(sharedProfiles, DEEPSEEK_HARNESS_PROFILE);
  const mirrored = new Set<string>();
  // A shared home without this profile leaves the private one for dsh to
  // initialize; the next start adopts the shared profile once it exists.
  for (const name of await readDirectoryNames(sharedProfile)) {
    if (DSH_OWNED_ENTRY.test(name) || name === LEGACY_LINK_PROJECTION_DIR) continue;
    const source = path.join(sharedProfile, name);
    const target = path.join(profileDir, name);
    const info = await stat(source).catch(() => undefined);
    if (info?.isDirectory()) {
      mirrored.add(name);
      if (name === PACKAGE_DIRECTORY) {
        await mirrorPackageDirectory(source, target, options.onDiagnostic);
      } else {
        await ensureDirectoryLink(source, target, options.onDiagnostic);
      }
    } else if (info?.isFile()) {
      mirrored.add(name);
      await copyPrivateFile(source, target, options.onDiagnostic);
    }
  }
  for (const name of await readDirectoryNames(profileDir)) {
    if (mirrored.has(name) || DSH_OWNED_ENTRY.test(name)) continue;
    await removeStaleProfileEntry(path.join(profileDir, name), options.onDiagnostic);
  }

  return { profileDir, patchPath: path.join(profileDir, "cordis.patch.yml") };
}

/** Packages link individually; `@scope` directories stay private like the root. */
async function mirrorPackageDirectory(
  source: string,
  target: string,
  onDiagnostic?: (message: string) => void,
): Promise<void> {
  await ensurePrivateDirectory(target);
  const mirrored = new Set<string>();
  for (const name of await readDirectoryNames(source)) {
    const entrySource = path.join(source, name);
    if (!(await stat(entrySource).catch(() => undefined))?.isDirectory()) continue;
    mirrored.add(name);
    const entryTarget = path.join(target, name);
    if (!name.startsWith("@")) {
      await ensureDirectoryLink(entrySource, entryTarget, onDiagnostic);
      continue;
    }
    await ensurePrivateDirectory(entryTarget);
    const scoped = new Set<string>();
    for (const child of await readDirectoryNames(entrySource)) {
      const childSource = path.join(entrySource, child);
      if (!(await stat(childSource).catch(() => undefined))?.isDirectory()) continue;
      scoped.add(child);
      await ensureDirectoryLink(childSource, path.join(entryTarget, child), onDiagnostic);
    }
    for (const child of await readDirectoryNames(entryTarget)) {
      if (!scoped.has(child)) await removeLinkEntry(path.join(entryTarget, child), onDiagnostic);
    }
  }
  for (const name of await readDirectoryNames(target)) {
    if (!mirrored.has(name)) await removePackageEntry(path.join(target, name), onDiagnostic);
  }
}

async function ensurePrivateDirectory(target: string): Promise<void> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isDirectory()) {
    await chmod(target, 0o700).catch(() => {});
    return;
  }
  if (info?.isSymbolicLink()) {
    // An existing Bot's `profiles` link (a junction on Windows): remove the
    // link only, never anything it points to.
    await removeLink(target);
  } else if (info) {
    await unlink(target);
  }
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o700).catch(() => {});
}

async function ensureDirectoryLink(
  source: string,
  target: string,
  onDiagnostic?: (message: string) => void,
): Promise<void> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    if (path.resolve(path.dirname(target), await readlink(target)) === source) return;
    await removeLink(target);
  } else if (info?.isDirectory()) {
    onDiagnostic?.(
      `DeepSeek Harness kept an unexpected private directory instead of linking the shared one: ${target}`,
    );
    return;
  } else if (info) {
    await unlink(target);
  }
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function copyPrivateFile(
  source: string,
  target: string,
  onDiagnostic?: (message: string) => void,
): Promise<void> {
  const contents = await readFile(source);
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isDirectory()) {
    onDiagnostic?.(`DeepSeek Harness kept an unexpected private directory instead of copying a shared file: ${target}`);
    return;
  }
  if (info?.isSymbolicLink()) {
    await removeLink(target);
  } else if (info?.isFile() && contents.equals(await readFile(target))) {
    await chmod(target, 0o600).catch(() => {});
    return;
  }
  await writePrivateFileAtomically(target, contents);
}

/** A mirrored profile entry the shared profile no longer has. */
async function removeStaleProfileEntry(target: string, onDiagnostic?: (message: string) => void): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    await removeLink(target);
  } else if (info.isFile()) {
    await unlink(target);
  } else if (info.isDirectory() && path.basename(target) === PACKAGE_DIRECTORY) {
    for (const name of await readDirectoryNames(target)) {
      await removePackageEntry(path.join(target, name), onDiagnostic);
    }
    await removeEmptyDirectory(target, onDiagnostic);
  } else {
    onDiagnostic?.(`DeepSeek Harness kept an unexpected private profile entry: ${target}`);
  }
}

async function removePackageEntry(target: string, onDiagnostic?: (message: string) => void): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    await removeLink(target);
    return;
  }
  if (info.isDirectory() && path.basename(target).startsWith("@")) {
    for (const child of await readDirectoryNames(target)) {
      await removeLinkEntry(path.join(target, child), onDiagnostic);
    }
    await removeEmptyDirectory(target, onDiagnostic);
    return;
  }
  onDiagnostic?.(`DeepSeek Harness kept an unexpected private package entry: ${target}`);
}

async function removeLinkEntry(target: string, onDiagnostic?: (message: string) => void): Promise<void> {
  if ((await lstat(target)).isSymbolicLink()) {
    await removeLink(target);
  } else {
    onDiagnostic?.(`DeepSeek Harness kept an unexpected private package entry: ${target}`);
  }
}

async function removeEmptyDirectory(target: string, onDiagnostic?: (message: string) => void): Promise<void> {
  await rmdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    onDiagnostic?.(`DeepSeek Harness kept a non-empty private directory: ${target}`);
  });
}

/** Remove a symlink or Windows junction without touching its target. */
async function removeLink(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR")) throw error;
    // A directory junction is removed with rmdir, which never recurses.
    await rmdir(target);
  }
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function writePrivateFileAtomically(filePath: string, contents: Buffer): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
