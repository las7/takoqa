/**
 * Pluggable route discovery, so takoqa points at ANY app — not just Next.js.
 *
 * A RouteSource is resolved to a flat list of route paths that the crawl sweeps.
 * Three adapters:
 *   - `next`    — read routes from a Next.js app-router tree (discover.ts).
 *   - `static`  — an explicit list, used verbatim (the app-agnostic baseline).
 *   - `sitemap` — fetch a sitemap.xml and extract same-origin paths (capped).
 *
 * The sitemap fetch is INJECTED (deps.fetchText) so the adapter is unit-testable
 * with a fixed document and never touches the network in tests.
 */

import { discoverRoutes } from "./discover.js";
import { normalizeRoute } from "./progress.js";
import type { RouteSource } from "./types.js";

export interface ResolvedRouteSource {
  kind: RouteSource["kind"];
  routes: string[];
}

/** Default cap on routes pulled from a sitemap, so a huge sitemap can't explode the crawl. */
const DEFAULT_SITEMAP_CAP = 200;

export interface ResolveDeps {
  /** Fetch a URL's text. Injected so the sitemap adapter is testable without network. */
  fetchText?: (url: string) => Promise<string>;
}

/** Resolve a RouteSource to a flat route list. Pure for next/static; async for sitemap. */
export async function resolveRoutes(
  source: RouteSource,
  deps: ResolveDeps = {},
): Promise<ResolvedRouteSource> {
  switch (source.kind) {
    case "next":
      return { kind: "next", routes: discoverRoutes(source.appDir) };
    case "static":
      // Used verbatim — the app-agnostic baseline does no discovery.
      return { kind: "static", routes: source.routes };
    case "sitemap": {
      const fetchText = deps.fetchText ?? defaultFetchText;
      const xml = await fetchText(source.url);
      return {
        kind: "sitemap",
        routes: extractSitemapRoutes(
          xml,
          source.url,
          source.cap ?? DEFAULT_SITEMAP_CAP,
        ),
      };
    }
  }
}

/** Network fetch used when no fetchText is injected. */
async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  return res.text();
}

/**
 * Extract same-origin route paths from a sitemap's <loc> entries. Off-origin
 * entries are dropped (a sitemap may list other domains); paths are normalized
 * (dynamic ids → "[id]") and de-duplicated, then capped. Pure.
 */
export function extractSitemapRoutes(
  xml: string,
  sitemapUrl: string,
  cap: number,
): string[] {
  let origin: string;
  try {
    origin = new URL(sitemapUrl).origin;
  } catch {
    return [];
  }
  const routes = new Set<string>();
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    const loc = m[1]!;
    let parsed: URL;
    try {
      parsed = new URL(loc, origin);
    } catch {
      continue;
    }
    if (parsed.origin !== origin) continue; // same-origin only
    routes.add(normalizeRoute(parsed.pathname));
    if (routes.size >= cap) break;
  }
  return [...routes].sort();
}

/**
 * Build a RouteSource from a profile's `explore` block plus CLI overrides. CLI
 * flags win; then `explore.source`; then the `explore.appDir` shorthand
 * (`{ kind: "next", appDir }`), so existing profiles are untouched. Returns
 * undefined when nothing declares a source.
 */
export function routeSourceFrom(
  explore: { appDir?: string; source?: RouteSource } | undefined,
  overrides: { appDir?: string; routes?: string[]; sitemap?: string } = {},
): RouteSource | undefined {
  if (overrides.appDir) return { kind: "next", appDir: overrides.appDir };
  if (overrides.routes && overrides.routes.length)
    return { kind: "static", routes: overrides.routes };
  if (overrides.sitemap) return { kind: "sitemap", url: overrides.sitemap };
  if (explore?.source) return explore.source;
  if (explore?.appDir) return { kind: "next", appDir: explore.appDir };
  return undefined;
}
