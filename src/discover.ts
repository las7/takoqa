/**
 * Auto-derive routes from a Next.js app-router directory, so a profile's
 * knowledge/crawl route list can stay in sync with the app instead of being
 * hand-maintained. Finds every page file and converts its folder path to a
 * route: route groups "(x)", slots "@x", and private "_x" folders are dropped;
 * dynamic "[x]" segments are kept.
 */

import { readdirSync } from "node:fs";
import { sep } from "node:path";

const PAGE_FILE = /(^|\/)page\.(tsx|ts|jsx|js)$/;

export function discoverRoutes(appDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(appDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  const routes = new Set<string>();
  for (const entry of entries) {
    const rel = entry.split(sep).join("/");
    if (!PAGE_FILE.test(rel)) continue;
    const dir = rel.replace(PAGE_FILE, "");
    const segs = dir.split("/").filter((s) => s !== "");
    // Private folders ("_x"), parallel-route slots ("@x"), and intercepting
    // routes ("(.)x"/"(..)x"/"(...)x" — overlay routes, not navigable
    // destinations) opt out of normal routing — skip the entry entirely.
    if (
      segs.some(
        (s) => s.startsWith("_") || s.startsWith("@") || /^\(\.+\)/.test(s),
      )
    ) {
      continue;
    }
    // Route groups "(x)" don't appear in the URL — drop just those segments.
    const urlSegs = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    routes.add(`/${urlSegs.join("/")}`);
  }
  return [...routes].sort();
}

/** Render discovered routes as a YAML `knowledge.routes` block. */
export function renderRoutesYaml(routes: string[]): string {
  const lines = ["knowledge:", "  routes:"];
  for (const r of routes) lines.push(`    - path: ${r}`);
  return `${lines.join("\n")}\n`;
}
