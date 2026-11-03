/** POSIX-style path helpers for the project filesystem (root is "/"). */

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function dirname(path: string): string {
  const p = normalize(path);
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalize(path);
  return p.slice(p.lastIndexOf("/") + 1);
}

export function join(...parts: string[]): string {
  return normalize(parts.join("/"));
}

/** True when `child` is `parent` itself or lives below it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalize(parent);
  const c = normalize(child);
  return p === "/" || c === p || c.startsWith(p + "/");
}

export function validateName(name: string): string | null {
  if (!name || name === "." || name === "..") return "Invalid name";
  if (name.includes("/") || name.includes("\0")) return "Names cannot contain / or NUL";
  if (name.length > 255) return "Name too long";
  return null;
}
