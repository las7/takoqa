/**
 * Tier/auth matrix sweep. Runs the crawl once per auth variant and diffs the
 * findings: a finding present in only SOME variants is access/tier-dependent (a
 * gate or auth wall working as designed), while one present in EVERY variant is
 * a universal defect. This auto-separates "fails everywhere" (real bug) from
 * "fails only when logged out / non-OP" (expected gate) — the noise that
 * dominated the single-tier loop run.
 *
 * classifyAcrossVariants is pure (the diff); runMatrix is the live orchestration.
 */

import { readFileSync } from "node:fs";

import { baselineFingerprint } from "./findings.js";
import { buildExplorePlan } from "./explore.js";
import { runProfile, type EngineOptions } from "./engine.js";
import { normalizeRoute } from "./progress.js";
import type { LoadedProfile } from "./profile.js";
import type { ResolvedRouteSource } from "./routeSource.js";
import type { Auth, ExpectedAccess, Finding, Variant } from "./types.js";

/**
 * Whether a variant carries NO live session — the signal that splits a disallowed
 * reach into missing_authn (no session) vs broken_authz (a real session that just
 * isn't permitted). Strategy "none" is unauthenticated by definition. A
 * "storageState" variant is authenticated ONLY if its state file actually carries
 * something (cookies or origins): an empty/unpopulated state ({cookies:[],
 * origins:[]}) is functionally logged-out, so a reach with it is missing_authn,
 * not a mislabeled broken_authz. An unreadable/malformed state is treated as
 * authenticated (the variant declared a session; if the file is truly broken the
 * crawl fails on session.start anyway). loginForm is unimplemented (start throws).
 *
 * Caveat: this catches an EMPTY state, not an EXPIRED-but-present one — detecting
 * a stale session would require observing the server's auth challenge, which the
 * differential cannot see. Either way both kinds are critical and block.
 */
function variantCarriesNoSession(auth: Auth): boolean {
  if (auth.strategy === "none") return true;
  if (auth.strategy === "storageState") {
    try {
      const state = JSON.parse(readFileSync(auth.path, "utf8"));
      const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
      const origins = Array.isArray(state?.origins) ? state.origins : [];
      return cookies.length === 0 && origins.length === 0;
    } catch {
      return false; // declared a session; an unreadable file fails the crawl instead
    }
  }
  return false;
}

export interface VariantFindings {
  variant: string;
  findings: Finding[];
}

export interface MatrixEntry {
  fingerprint: string;
  /** A representative finding (first seen). */
  finding: Finding;
  /** Variant names this finding appeared in. */
  variants: string[];
  /** True only if it appeared in EVERY variant (and there are >1) — universal. */
  universal: boolean;
}

/**
 * Diff findings across variants by cross-run fingerprint. Pure. A finding in all
 * variants is `universal` (a real candidate); one in a strict subset is
 * access/tier-dependent (likely a gate).
 */
export function classifyAcrossVariants(
  perVariant: VariantFindings[],
): MatrixEntry[] {
  const total = perVariant.length;
  const byFp = new Map<string, { finding: Finding; variants: Set<string> }>();
  for (const { variant, findings } of perVariant) {
    for (const f of findings) {
      const fp = baselineFingerprint(f);
      const e = byFp.get(fp) ?? { finding: f, variants: new Set<string>() };
      e.variants.add(variant);
      byFp.set(fp, e);
    }
  }
  return [...byFp.entries()].map(([fingerprint, e]) => ({
    fingerprint,
    finding: e.finding,
    variants: [...e.variants].sort(),
    universal: total > 1 && e.variants.size === total,
  }));
}

/** The routes a single variant actually reached during its crawl. */
export interface VariantReach {
  variant: string;
  reachedRoutes: string[];
  /**
   * True when this variant carries NO live session (strategy "none", or a
   * storageState with no cookies/origins — see variantCarriesNoSession). It
   * splits a disallowed reach into two distinct defects: an UNAUTHENTICATED reach
   * is `missing_authn` (the route served content with no auth challenge at all),
   * while an authenticated-but-under-privileged reach is `broken_authz` (IDOR /
   * broken access control — the caller had a session, just not permission).
   * Absent ⇒ authenticated ⇒ broken_authz (back-compatible: existing callers that
   * omit this keep their broken_authz semantics unchanged).
   */
  unauthenticated?: boolean;
}

/**
 * The authz differential. Pure. For each (route, variant) where the variant
 * REACHED a route whose expectedAccess entry exists and does NOT list that
 * variant, emit a critical finding. The KIND depends on whether the variant was
 * authenticated: an UNAUTHENTICATED reach is `missing_authn` (no auth challenge
 * at all), an authenticated-but-under-privileged reach is `broken_authz` (IDOR).
 *
 * An UNDECLARED route asserts nothing — silence is not a finding, and there is
 * no default-deny (a route absent from the map is simply not under assertion).
 */
export function checkExpectedAccess(
  perVariantReach: VariantReach[],
  expectedAccess: ExpectedAccess,
): Finding[] {
  const findings: Finding[] = [];
  // Normalize the CONFIG keys too, so a human-authored `/admin/` (trailing
  // slash) or `/users/123` (concrete id) still matches the normalized reached
  // route. Last-writer-wins if two raw keys normalize to the same route.
  const allowByRoute = new Map<string, string[]>();
  for (const [key, allowed] of Object.entries(expectedAccess)) {
    allowByRoute.set(normalizeRoute(key), allowed);
  }
  for (const { variant, reachedRoutes, unauthenticated } of perVariantReach) {
    for (const route of reachedRoutes) {
      const key = normalizeRoute(route);
      const allowed = allowByRoute.get(key);
      if (!allowed) continue; // undeclared route → no assertion
      if (allowed.includes(variant)) continue; // allowed → fine
      const kind = unauthenticated ? "missing_authn" : "broken_authz";
      const detail = unauthenticated
        ? `Unauthenticated variant "${variant}" reached "${key}", which is restricted to ` +
          `[${allowed.join(", ")}]. The route served content with NO authentication challenge — ` +
          `a missing-authentication defect (a protected route reachable while logged out).`
        : `Variant "${variant}" reached "${key}", which is restricted to [${allowed.join(", ")}]. ` +
          `This is a broken-access-control / IDOR candidate — the route served content to an ` +
          `authenticated variant that should not be able to reach it.`;
      findings.push({
        kind,
        severity: "critical",
        missionId: "matrix",
        persona: variant,
        title: `${unauthenticated ? "Missing authn" : "Broken authz"}: variant "${variant}" reached gated route ${key}`,
        detail,
        repro: [`As "${variant}", opened ${key}`],
        url: route,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return findings;
}

export interface MatrixResult {
  perVariant: VariantFindings[];
  entries: MatrixEntry[];
}

/** Run the crawl once per variant (auth overridden) and diff the findings. */
export async function runMatrix(
  loaded: LoadedProfile,
  source: ResolvedRouteSource,
  variants: Variant[],
  opts: EngineOptions,
): Promise<MatrixResult> {
  const perVariant: VariantFindings[] = [];
  const perVariantReach: VariantReach[] = [];
  for (const v of variants) {
    const plan = buildExplorePlan(
      { ...loaded, profile: { ...loaded.profile, auth: v.auth } },
      source,
    );
    const crawl = plan.loaded.profile.missions.find((m) => m.mode === "crawl");
    if (!crawl) continue;
    // Unique mission id per variant so screenshots don't clobber each other in
    // the shared run dir; record:false — the crawl is deterministic, no need for
    // per-variant video/trace (and it'd overwrite too).
    const slug =
      v.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "v";
    const variantCrawl = { ...crawl, id: `${crawl.id}-${slug}` };
    const report = await runProfile(
      {
        ...plan.loaded,
        profile: { ...plan.loaded.profile, missions: [variantCrawl] },
      },
      { ...opts, auth: v.auth, onlyTag: undefined, record: false },
    );
    const findings = report.results.flatMap((r) => r.findings);
    perVariant.push({ variant: v.name, findings });
    perVariantReach.push({
      variant: v.name,
      reachedRoutes: reachedRoutes(report.results.flatMap((r) => r.steps)),
      // A session-less variant's disallowed reach is missing_authn, not broken_authz
      // (keyed on the actual session payload, not just the strategy label).
      unauthenticated: variantCarriesNoSession(v.auth),
    });
  }

  // Authz differential: a variant that REACHED a route its expectedAccess entry
  // does not allow is a broken_authz candidate. Fold these into the entries as
  // variant-scoped (universal:false) so run.ts prints + blocks on them.
  const authzEntries: MatrixEntry[] = loaded.profile.expectedAccess
    ? checkExpectedAccess(perVariantReach, loaded.profile.expectedAccess).map(
        (f) => ({
          fingerprint: baselineFingerprint(f),
          finding: f,
          variants: [f.persona],
          universal: false,
        }),
      )
    : [];

  return {
    perVariant,
    entries: [...classifyAcrossVariants(perVariant), ...authzEntries],
  };
}

/**
 * The routes a variant actually REACHED in its crawl, judged by the LANDED
 * DOCUMENT's GET status — the sound signal. A step's route counts as reached iff
 * its status is a 2xx (or undefined, the conservative default when no GET was
 * captured); a 3xx/4xx/5xx document means the route gated / redirected / errored,
 * so it was NOT reached and never triggers a false broken_authz.
 *
 * Note a route that REDIRECTED away is already excluded: the step's url is the
 * LANDED url (where the redirect put us), so the gated path never appears as a
 * step at all — and the landing page it bounced to is asserted on its own merits.
 *
 * (The old implementation excluded routes only via route_gated / 401-403
 * http_error findings, neither of which the crawl ever emits — route_gated isn't
 * produced in crawl mode and a 4xx is below the default 500 http-error threshold
 * — so a correctly-gated 403/redirect route was flagged as a critical broken
 * authz. This status-based test is the fix.)
 */
export function reachedRoutes(
  steps: { url: string; status?: number }[],
): string[] {
  const reached = new Set<string>();
  for (const s of steps) {
    const ok = s.status === undefined || (s.status >= 200 && s.status < 300);
    if (ok) reached.add(normalizeRoute(s.url));
  }
  return [...reached];
}
