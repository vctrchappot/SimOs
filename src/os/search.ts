import { createIgnore } from "./vfs/ignore";
import type { MemoryFS } from "./vfs/memory-fs";

export interface SearchOptions {
  caseSensitive?: boolean;
  /** Treat the query as a JavaScript regular expression. */
  regex?: boolean;
  maxResults?: number;
  /** Text of the project's ignore file; ignored paths are not searched. */
  ignore?: string;
  /** Files larger than this are skipped. */
  maxFileBytes?: number;
}

export interface SearchMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the match start. */
  column: number;
  length: number;
  /** The matching line, trimmed to a readable length around the match. */
  preview: string;
  /** Index of the match inside `preview` (for highlighting). */
  previewAt: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when `maxResults` cut the search short. */
  truncated: boolean;
  /** Set when a regex query is invalid. */
  error?: string;
}

const decoder = new TextDecoder();

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Shortens a long line to a window around the match; returns the text and where the match sits in it. */
function windowAround(line: string, at: number, width = 160): { text: string; matchAt: number } {
  if (line.length <= width) return { text: line, matchAt: at };
  const start = Math.max(0, Math.min(at - 40, line.length - width));
  const prefix = start > 0 ? "…" : "";
  return { text: prefix + line.slice(start, start + width), matchAt: at - start + prefix.length };
}

/** Plain-text or regex search over every text file of the project, in path order. */
export function searchProject(fs: MemoryFS, query: string, options: SearchOptions = {}): SearchResult {
  const { caseSensitive = false, regex = false, maxResults = 500, ignore = "", maxFileBytes = 1024 * 1024 } = options;
  if (!query) return { matches: [], truncated: false };

  let re: RegExp;
  try {
    const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(source, caseSensitive ? "g" : "gi");
  } catch (e) {
    return { matches: [], truncated: false, error: e instanceof Error ? e.message : String(e) };
  }

  const skip = createIgnore(ignore);
  const matches: SearchMatch[] = [];
  for (const entry of fs.list()) {
    if (entry.kind !== "file" || entry.size > maxFileBytes || skip(entry.path)) continue;
    const bytes = fs.readFile(entry.path);
    if (isBinary(bytes)) continue;
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i]))) {
        if (m[0] === "") {
          re.lastIndex++; // an empty regex match must not loop forever
          continue;
        }
        const raw = lines[i].replace(/\r$/, "");
        const { text, matchAt } = windowAround(raw, m.index);
        matches.push({ path: entry.path, line: i + 1, column: m.index + 1, length: m[0].length, preview: text, previewAt: matchAt });
        if (matches.length >= maxResults) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}
