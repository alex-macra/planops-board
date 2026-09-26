export interface LockPackageEntry {
  readonly name?: string;
  readonly version?: string;
  readonly hasInstallScript?: boolean;
  readonly os?: string | readonly string[];
}

export interface PackageLockFile {
  readonly packages?: Readonly<Record<string, LockPackageEntry>>;
}

export interface InstalledInstallScript {
  readonly name: string;
  readonly version: string;
  readonly lockVersions: readonly string[];
  readonly differsFromLock: boolean;
}

export interface InstallScriptReview {
  readonly entries: readonly InstalledInstallScript[];
  readonly outside: readonly string[];
}

const NODE_MODULES = "node_modules/";

export function packageNameFromLocation(location: string): string | undefined {
  const index = location.lastIndexOf(NODE_MODULES);
  if (index === -1) return undefined;
  const name = location.slice(index + NODE_MODULES.length);
  return name === "" ? undefined : name;
}

export function supportsPlatform(os: LockPackageEntry["os"], platform: string): boolean {
  if (os === undefined) return true;
  const list = typeof os === "string" ? [os] : os;
  if (list.length === 0 || (list.length === 1 && list[0] === "any")) return true;
  let negated = 0;
  let matched = false;
  for (const entry of list) {
    if (entry.startsWith("!")) {
      negated += 1;
      if (entry.slice(1) === platform) return false;
    } else if (entry === platform) {
      matched = true;
    }
  }
  return matched || negated === list.length;
}

function installScriptPackages(lock: PackageLockFile): Array<{ name: string; entry: LockPackageEntry }> {
  const found: Array<{ name: string; entry: LockPackageEntry }> = [];
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!entry.hasInstallScript) continue;
    const locationName = packageNameFromLocation(location);
    if (locationName !== undefined) found.push({ name: entry.name ?? locationName, entry });
  }
  return found;
}

export function lockInstallScriptNames(lock: PackageLockFile, platform: string): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const { name, entry } of installScriptPackages(lock)) {
    if (!supportsPlatform(entry.os, platform)) continue;
    const versions = names.get(name) ?? [];
    if (entry.version !== undefined && !versions.includes(entry.version)) versions.push(entry.version);
    names.set(name, versions);
  }
  for (const versions of names.values()) versions.sort();
  return new Map([...names].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

export function reviewInstalledInstallScripts(
  lock: PackageLockFile,
  installedLock: PackageLockFile,
  platform: string,
): InstallScriptReview {
  const allowed = lockInstallScriptNames(lock, platform);
  const entries = installScriptPackages(installedLock)
    .map(({ name, entry }): InstalledInstallScript => {
      const version = entry.version ?? "unknown";
      const lockVersions = allowed.get(name) ?? [];
      return { name, version, lockVersions, differsFromLock: !lockVersions.includes(version) };
    })
    .sort((left, right) => {
      const a = `${left.name}@${left.version}`;
      const b = `${right.name}@${right.version}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const outside = [
    ...new Set(entries.filter((entry) => !allowed.has(entry.name)).map((entry) => `${entry.name}@${entry.version}`)),
  ];
  return { entries, outside };
}
