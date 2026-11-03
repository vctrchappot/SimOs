import { normalize } from "./path";

/** Project file that lists what the editor/OS sync should leave alone (a small subset of .gitignore). */
export const IGNORE_FILE = "/.simosignore";

/** Always ignored: huge or machine-managed trees that would only slow the sync down. */
export const DEFAULT_IGNORES = ["node_modules/", ".git/"];

/** `isDir` tells whether `path` itself is a directory (needed for `dir/` rules). */
export type IgnoreMatcher = (path: string, isDir?: boolean) => boolean;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

/**
 * Builds a matcher from ignore-file text. Supported lines:
 *   name        any file or directory called `name`, at any depth
 *   dir/        directories called `dir` (and everything inside)
 *   *.o         glob on the name (`*` and `?`, no `**`)
 *   /path       anchored at the project root
 *   # comment   and blank lines are skipped
 * A matched directory ignores everything below it. There is no negation (`!`).
 */
export function createIgnore(text = "", defaults: string[] = DEFAULT_IGNORES): IgnoreMatcher {
  const rules = [...defaults, ...text.split("\n")]
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((line) => {
      const anchored = line.startsWith("/");
      const dirOnly = line.endsWith("/");
      const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");
      return { anchored, dirOnly, hasSlash: pattern.includes("/"), re: globToRegExp(pattern), pattern };
    });

  return (path, isDir = false) => {
    const parts = normalize(path).split("/").filter(Boolean);
    // Test every ancestor and the path itself; a matching ancestor is a matching directory.
    for (let i = 1; i <= parts.length; i++) {
      const isLast = i === parts.length;
      const prefix = parts.slice(0, i).join("/");
      for (const r of rules) {
        if (r.dirOnly && isLast && !isDir) continue;
        const target = r.anchored || r.hasSlash ? prefix : parts[i - 1];
        if (r.re.test(target)) return true;
      }
    }
    return false;
  };
}
