/**
 * Explore-mode orchestration — the systematized exploration phase.
 *
 * Turns a profile + a resolved route source into a "full sweep" profile, so
 * exploration is one repeatable command instead of a hand-driven sequence:
 *
 *   1. DISCOVER  — routes come from a pluggable RouteSource (next/static/sitemap,
 *      resolved by routeSource.ts), so the crawl and coverage stay in sync with
 *      the app instead of a stale, hand-pasted list.
 *   2. CRAWL     — a deterministic crawl mission is synthesized over the static
 *      routes (load-time oracle sweep, no LLM). Any hand-authored crawl mission
 *      is dropped: explore owns the route sweep.
 *   3. EXERCISE  — the profile's agent missions run unchanged, after the crawl.
 *   4. CLASSIFY  — the caller runs with the baseline on (new/known/muted), so
 *      the combined report is already triaged.
 *
 * This module is a pure profile transform (no engine/browser/LLM): the engine
 * runs the resulting profile exactly as it runs any other.
 */

import { MissionSchema, KnowledgeSchema } from "./types.js";
import type { LoadedProfile } from "./profile.js";
import type { ResolvedRouteSource } from "./routeSource.js";

export interface ExplorePlan {
  /** The synthesized "full sweep" profile, ready for runProfile. */
  loaded: LoadedProfile;
  /** Every route discovered from the app tree. */
  discovered: string[];
  /** The static subset actually crawled (dynamic "[id]" routes are dropped). */
  crawled: string[];
}

/** The id of the crawl mission explore synthesizes (stable, for reports/tests). */
export const EXPLORE_CRAWL_ID = "explore-crawl";

export function buildExplorePlan(
  loaded: LoadedProfile,
  source: ResolvedRouteSource,
): ExplorePlan {
  const discovered = source.routes;
  // Crawl navigates each route literally, so a dynamic "[id]" segment isn't a
  // reachable URL — sweep only the static routes.
  const crawled = discovered.filter((r) => !r.includes("["));

  // Synthesize one crawl mission over the discovered static routes. MissionSchema
  // fills the remaining defaults (startPath, maxSteps, etc.).
  const crawlMission = MissionSchema.parse({
    id: EXPLORE_CRAWL_ID,
    goal: "Load every discovered route and run the invariant oracles on it.",
    mode: "crawl",
    routes: crawled,
    tags: ["explore"],
  });

  // Drop any hand-authored crawl mission — explore owns crawling — and keep the
  // agent missions, crawl first (fast broad net before the slow agent missions).
  const agentMissions = loaded.profile.missions.filter(
    (m) => m.mode !== "crawl",
  );

  // Merge discovered routes into the knowledge block (union by path) so coverage
  // and the agent frontier reflect the live app tree. Existing entries (with
  // their descriptions/requires) win; newly discovered paths are added bare.
  const existingRoutes = loaded.profile.knowledge?.routes ?? [];
  const known = new Set(existingRoutes.map((r) => r.path));
  const knowledge = KnowledgeSchema.parse({
    ...(loaded.profile.knowledge ?? {}),
    routes: [
      ...existingRoutes,
      ...discovered.filter((p) => !known.has(p)).map((path) => ({ path })),
    ],
  });

  return {
    discovered,
    crawled,
    loaded: {
      ...loaded,
      profile: {
        ...loaded.profile,
        missions: [crawlMission, ...agentMissions],
        knowledge,
      },
    },
  };
}
