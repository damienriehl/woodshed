import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const CONTENT_RULES = [
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["capability-token", /\b(?:invite|capability|access)[_-]?token\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i],
  ["private-host", new RegExp(`\\b(?:${"local" + "host"}|(?:[A-Za-z0-9-]+\\.)+(?:${"inter" + "nal"}|${"lo" + "cal"})|[A-Za-z0-9.-]*${"hoote" + "nanny"}[A-Za-z0-9.-]*\\.(?!example\\b)[A-Za-z]{2,})\\b`, "i")],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["phone", /(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]\d{3}[ .-]\d{4}\b/],
  ["postal-address", /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)\b[^\n]*\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i],
];

const FORBIDDEN_ARTIFACT = /(?:^|\/)(?:.*(?:generated|dump|backup|archive).*\.sql|.*\.(?:sqlite3?|db|dump|bak)|.*(?:backup|archive).*\.(?:json|zip|tgz|tar(?:\.gz)?)|release\.(?:zip|tgz|tar(?:\.gz)?))$/i;
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

function normalized(file) {
  return file.split(path.sep).join("/");
}

function isAllowedPlaceholder(value, file, enabled) {
  if (!enabled) return false;
  if (/(?:^|\/)\.env\.example$/.test(normalized(file)) && /https?:\/\/example\.com/i.test(value)) return true;
  return /^[A-Z0-9._%+-]+@example\.(?:com|org|net)$/i.test(value);
}

function inspect(file, buffer, options) {
  const findings = [];
  const displayPath = normalized(file);
  if (FORBIDDEN_ARTIFACT.test(displayPath)) {
    findings.push({ path: displayPath, rule: "forbidden-artifact" });
  }
  if (buffer.includes(0)) return findings;
  const value = buffer.toString("utf8");
  for (const [rule, pattern] of CONTENT_RULES) {
    const matches = value.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
    if ([...matches].some((match) => !isAllowedPlaceholder(match[0], file, options.allowExamplePlaceholders))) {
      findings.push({ path: displayPath, rule });
    }
  }
  return findings;
}

async function filesUnder(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error("symbolic links are not public scan inputs");
    files.push(...await filesUnder(child));
  }
  return files;
}

export async function scanPaths(targets, options = {}) {
  const findings = [];
  const errors = [];
  for (const target of targets) {
    try {
      for (const file of await filesUnder(target)) {
        try {
          findings.push(...inspect(file, await readFile(file), options));
        } catch {
          errors.push({ path: normalized(file), error: "unreadable" });
        }
      }
    } catch {
      errors.push({ path: normalized(target), error: "unreadable" });
    }
  }
  return { findings, errors };
}

export function scanBuffer(label, buffer, options = {}) {
  return inspect(label, buffer, options);
}
