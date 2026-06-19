/**
 * Ground-truth manifest for the scored self-eval: one PlantedCase per planted
 * route on the fixture server (test/fixture-server.ts). Co-located with the
 * fixture so the two cannot drift.
 *
 * PROCEDURE — add a planted route ⇒ add a manifest case:
 *   1. Add the route (+ its bug) to test/fixture-server.ts and document it in
 *      that file's header comment with the finding(s) it should produce.
 *   2. Add a PlantedCase here: { id, route, group, expectedKinds } for a buggy
 *      route, or { ..., clean: true } for a route that must stay quiet.
 *   3. The self-eval (test/selfeval.test.ts) then scores it automatically; a
 *      manifest-parity check fails the build if a kind isn't in the FindingKind
 *      union or a must-catch case never ran.
 */

import type { PlantedCase } from "../src/selfeval.js";

export type { PlantedCase } from "../src/selfeval.js";

export const PLANTED: PlantedCase[] = [
  // --- functional ---
  {
    id: "settings",
    route: "/settings",
    group: "functional",
    expectedKinds: ["page_error", "console_error"],
  },
  {
    id: "api-fail",
    route: "/api-fail",
    group: "functional",
    expectedKinds: ["http_error"],
  },
  {
    id: "clean",
    route: "/clean",
    group: "functional",
    expectedKinds: [],
    clean: true,
  },
  {
    id: "noop",
    route: "/noop",
    group: "functional",
    expectedKinds: ["no_progress"],
  },
  {
    id: "gated",
    route: "/gated",
    group: "functional",
    expectedKinds: ["route_gated"],
  },
  {
    id: "relog",
    route: "/relog",
    group: "functional",
    expectedKinds: ["console_error"],
  },
  {
    id: "toggle",
    route: "/toggle",
    group: "functional",
    expectedKinds: ["no_progress"],
  },
  {
    id: "slowgate",
    route: "/slowgate",
    group: "functional",
    expectedKinds: ["route_gated"],
  },
  {
    id: "loaderror",
    route: "/loaderror",
    group: "functional",
    expectedKinds: ["page_error"],
  },
  {
    // An AGENT mission STARTS on a page that throws during load. The page_error is
    // in the start-page load batch (which agent mode used to discard), so it is
    // caught ONLY if agent mode runs the invariant oracles on that batch. Not a
    // crawl route — the per-case recall over the fn-agent-load-error mission gates
    // the engine behaviour.
    id: "agent-load-error",
    route: "/agent-loaderror",
    group: "functional",
    expectedKinds: ["page_error"],
  },
  {
    // A 200 page whose visible text carries a crash marker (no 5xx) — the body
    // signature must fire on the text. The SOLE signal for body_error_signature.
    id: "body-error",
    route: "/body-error",
    group: "functional",
    expectedKinds: ["body_error_signature"],
  },
  {
    // A page navigation that 404s — a broken route. SOLE signal for dead_link
    // (404 is below the http_error 500 threshold).
    id: "gone",
    route: "/gone",
    group: "functional",
    expectedKinds: ["dead_link"],
  },
  {
    // A 200 page whose <img> src 404s — a broken image asset. The page document
    // is fine (no dead_link) and 404 < 500 (no http_error), so broken_image is the
    // SOLE signal.
    id: "broken-image",
    route: "/broken-image",
    group: "functional",
    expectedKinds: ["broken_image"],
  },
  {
    // A 200 page whose <script> AND stylesheet srcs 404 — broken behaviour/style
    // assets. The page document is fine (no dead_link) and 404 < 500 (no
    // http_error), so broken_asset is the SOLE signal.
    id: "broken-asset",
    route: "/broken-asset",
    group: "functional",
    expectedKinds: ["broken_asset"],
  },
  {
    // A 200 page with a rendered <img> that has no alt attribute (WCAG 1.1.1).
    // The image loads (data URI, no 404) and the page is fine, so accessibility
    // is the SOLE signal.
    id: "missing-alt",
    route: "/a11y-img",
    group: "functional",
    expectedKinds: ["accessibility"],
  },
  {
    // An icon-only <button> with no accessible name (WCAG 4.1.2). Same kind as
    // missing-alt (accessibility) but a distinct RULE, so it needs its own fixture
    // route: the per-case self-eval recall — not the per-kind mutation gate — is
    // what protects this rule from a silent regression.
    id: "unlabeled-control",
    route: "/a11y-button",
    group: "functional",
    expectedKinds: ["accessibility"],
  },
  {
    // A bare unlabeled <input> (WCAG 4.1.2/3.3.2). Same accessibility kind, a
    // distinct RULE → its own fixture route so the per-case recall gates it.
    id: "unlabeled-field",
    route: "/a11y-input",
    group: "functional",
    expectedKinds: ["accessibility"],
  },
  {
    // A <label for> pointing to a missing id (WCAG 1.3.1). Same accessibility kind,
    // a distinct RULE → its own fixture route so the per-case recall gates it.
    id: "orphan-label",
    route: "/a11y-orphan",
    group: "functional",
    expectedKinds: ["accessibility"],
  },
  {
    // Unlabeled controls/field/img that are all non-perceivable (visibility:hidden
    // / opacity:0 / aria-hidden). A CLEAN route: the a11y rules' computed-visibility
    // hidden() gate must exclude every one — zero accessibility findings. Reverting
    // that gate re-flags them as false positives here (precision regresses).
    id: "a11y-hidden",
    route: "/a11y-hidden",
    group: "functional",
    expectedKinds: [],
    clean: true,
  },
  {
    // Two elements share an id — a DOM spec violation. SOLE signal for duplicate_id.
    id: "dup-id",
    route: "/dup-id",
    group: "functional",
    expectedKinds: ["duplicate_id"],
  },
  {
    // A visible button covered by a foreign overlay — clicking it is blocked. The
    // SOLE signal for occluded_control.
    id: "occluded",
    route: "/occluded",
    group: "functional",
    expectedKinds: ["occluded_control"],
  },

  // --- security ---
  {
    id: "sec-clean",
    route: "/sec-clean",
    group: "security",
    expectedKinds: [],
    clean: true,
  },
  {
    id: "sec-headers",
    route: "/sec-headers",
    group: "security",
    expectedKinds: ["insecure_headers"],
  },
  {
    id: "sec-cookie",
    route: "/sec-cookie",
    group: "security",
    expectedKinds: ["insecure_cookie"],
  },
  {
    id: "sec-leak",
    route: "/sec-leak",
    group: "security",
    expectedKinds: ["sensitive_data_exposure"],
  },
  {
    id: "sec-verbose",
    route: "/sec-verbose",
    group: "security",
    expectedKinds: ["verbose_error"],
  },
  {
    // The injection pass types a metacharacter marker then navigates to the
    // reflecting route; the marker is echoed un-escaped. SOLE signal for
    // injection_reflection (the route carries the security headers).
    id: "sec-reflect",
    route: "/sec-reflect",
    group: "security",
    expectedKinds: ["injection_reflection"],
  },
  {
    // The authz-matrix pass: the UNAUTHENTICATED anon variant reaches a route it
    // is not allowed to. SOLE signal for missing_authn.
    id: "authn-gap",
    route: "/authn-gap",
    group: "security",
    expectedKinds: ["missing_authn"],
  },
  {
    // The authz-matrix pass: the authenticated-but-under-privileged viewer
    // variant reaches a route it is not allowed to. SOLE signal for broken_authz.
    id: "authz-gap",
    route: "/authz-gap",
    group: "security",
    expectedKinds: ["broken_authz"],
  },
  {
    // Allowed for every variant — guards against a false authz finding when
    // access is correct. Must produce no security findings.
    id: "authz-clean",
    route: "/authz-clean",
    group: "security",
    expectedKinds: [],
    clean: true,
  },
];

/** The ids of every non-clean (must-be-caught) case. */
export const MUST_CATCH: string[] = PLANTED.filter((c) => !c.clean).map(
  (c) => c.id,
);

/** The ids of the clean routes (must produce no findings of their group). */
export const CLEAN_ROUTES: string[] = PLANTED.filter((c) => c.clean).map(
  (c) => c.id,
);
