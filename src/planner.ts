/**
 * The exploration loop's "planner" — the creative engine.
 *
 * The actor (agent.ts `decide`) picks the next CLICK; the judge grades a
 * finished mission; the planner picks the next MISSIONS to attempt. It's
 * prompted as a curious, adversarial tester, grounded in the real app map and
 * what's already been explored, under explicit novelty pressure so it doesn't
 * repeat itself. Pure: builds a prompt + parses/validates the model's reply.
 */

import { z } from "zod";
import type { Persona } from "./types.js";

/** Levers that shape what the proposer optimizes for (all on by default). */
export interface Levers {
  /** Target unvisited routes + unexercised interaction types. */
  coverageGaps: boolean;
  /** Include failure/abuse/edge-case scenarios. */
  adversarial: boolean;
  /** Propose missions that dig deeper into existing findings. */
  deepenOnFindings: boolean;
  /** Vary the persona attempting each mission. */
  personaDiversity: boolean;
  /**
   * Craft BOUNDED active security probes (reflected-marker injection, id
   * tampering). OFF by default — explore/loop must not attack unless --security
   * is passed; enabling it is an explicit, approved opt-in.
   */
  attacker: boolean;
}

export const ALL_LEVERS: Levers = {
  coverageGaps: true,
  adversarial: true,
  deepenOnFindings: true,
  personaDiversity: true,
  attacker: false,
};

/**
 * Coarse interaction primitives we can detect from a step's action summary, for
 * the action-space frontier ("you haven't tried uploading or dragging yet").
 * Higher-level adversarial scenarios come from the `adversarial` lever prompt,
 * not from this list.
 */
const TRACKED_ACTIONS: { key: string; re: RegExp }[] = [
  { key: "click", re: /click/i },
  { key: "type", re: /typed/i },
  { key: "upload", re: /upload/i },
  { key: "scroll", re: /scroll/i },
  { key: "drag", re: /drag/i },
  { key: "navigate", re: /navigat|visited/i },
];

/** Which interaction primitives have / haven't been exercised across the run. */
export function actionFrontier(summaries: string[]): {
  seen: string[];
  missing: string[];
} {
  const seen = new Set<string>();
  for (const s of summaries) {
    for (const a of TRACKED_ACTIONS) if (a.re.test(s)) seen.add(a.key);
  }
  return {
    seen: [...seen],
    missing: TRACKED_ACTIONS.map((a) => a.key).filter((k) => !seen.has(k)),
  };
}

export interface ProposeContext {
  appName: string;
  /**
   * Routes that exist (from the merged knowledge block), each optionally
   * enriched with the interactive elements the crawl actually saw on that page
   * (affordances) — so the proposer grounds goals in real controls.
   */
  appMap: {
    path: string;
    description?: string;
    requires?: string;
    affordances?: string[];
  }[];
  /** Normalized routes visited so far this loop. */
  visited: string[];
  /** Known routes not yet visited (dynamic [id] excluded). */
  unvisited: string[];
  /** Mission goals already attempted — novelty pressure. */
  attempted: string[];
  /** Findings so far, for deepen-on-findings. */
  findings: {
    title: string;
    kind: string;
    severity: string;
    status?: string;
  }[];
  /** Interaction primitives not yet exercised (action-space frontier). */
  actionsMissing: string[];
  personas: Persona[];
  levers: Levers;
  /**
   * Personas explicitly flagged `attacker: true`. When the attacker lever is on,
   * probes are attributed to one of these (so an active probe runs as a persona
   * marked adversarial, not a benign user). Optional.
   */
  attackerPersonas?: Persona[];
  /** Things the proposer must never do (mutation guardrail). */
  denylist: string[];
  /** How many missions to propose this round. */
  count: number;
}

export function buildProposePrompt(ctx: ProposeContext): string {
  const L = ctx.levers;
  const lines: string[] = [];
  lines.push(
    `You are the planner for an autonomous QA exploration of "${ctx.appName}". ` +
      `Invent the NEXT batch of ${ctx.count} test missions a curious user would try — ` +
      `each a concrete objective on a real screen. Do NOT repeat what's already been done.`,
  );
  lines.push("");
  lines.push(
    "APP MAP (routes that exist; 'offers' = controls actually seen on the page):",
  );
  for (const r of ctx.appMap) {
    lines.push(
      `- ${r.path}` +
        (r.description ? ` — ${r.description}` : "") +
        (r.requires ? ` (requires ${r.requires})` : "") +
        (r.affordances && r.affordances.length
          ? `\n    offers: ${r.affordances.join(", ")}`
          : ""),
    );
  }
  lines.push(
    "GROUND every goal in what a page actually OFFERS above — do not assume a feature " +
      "(node canvas, editable table, etc.) that isn't listed. If a page's offerings are " +
      "unknown, make the goal to explore/observe it, not to use an imagined control. " +
      "Prefer concrete goals with an observable outcome over vague 'catalogue everything'.",
  );
  lines.push("");

  if (ctx.attempted.length) {
    lines.push(
      "ALREADY ATTEMPTED (do NOT repeat — go somewhere or do something new):",
    );
    for (const g of ctx.attempted) lines.push(`- ${g}`);
    lines.push("");
  }

  if (L.coverageGaps) {
    lines.push("COVERAGE GAPS — prefer these:");
    lines.push(
      `- Routes not yet visited: ${ctx.unvisited.length ? ctx.unvisited.join(", ") : "(none — all visited)"}`,
    );
    lines.push(
      `- Interaction types not yet exercised: ${ctx.actionsMissing.length ? ctx.actionsMissing.join(", ") : "(all common types used)"}`,
    );
    lines.push("");
  }

  if (L.deepenOnFindings && ctx.findings.length) {
    lines.push(
      "FINDINGS SO FAR — propose at least one mission that DIGS DEEPER into one of these " +
        "(its failure path, a related edge case, or whether it reproduces elsewhere):",
    );
    for (const f of ctx.findings.slice(0, 8)) {
      lines.push(
        `- [${f.kind}/${f.severity}${f.status ? `/${f.status}` : ""}] ${f.title}`,
      );
    }
    lines.push("");
  }

  if (L.adversarial) {
    lines.push(
      "ADVERSARIAL — include at least one edge/abuse scenario: malformed / empty / huge input, " +
        "submitting empty required fields, rapid repeated toggles, cancelling mid-flow, " +
        "using something after deleting it, the back button mid-flow, special characters, very long text.",
    );
    lines.push("");
  }

  if (L.attacker) {
    const attackerNames = (ctx.attackerPersonas ?? []).map((p) => p.name);
    lines.push(
      "SECURITY PROBES — include at least one BOUNDED active-probe mission:",
    );
    lines.push(
      "- Reflection: inject a UNIQUE marker payload containing HTML/template metacharacters " +
        "(e.g. angle brackets, quotes, ${} or {{}}) into a free-text field, submit it, and check whether " +
        "it is reflected back UN-ESCAPED on the resulting page (an XSS / template-injection surface).",
    );
    lines.push(
      "- Tampering: change an id in the URL path or query string to a value belonging to another tenant, " +
        "tier, or user, and observe whether content you should not be able to reach is served (IDOR / " +
        "missing access control).",
    );
    if (attackerNames.length) {
      lines.push(
        `- Attribute each probe to an attacker persona: ${attackerNames.join(", ")}.`,
      );
    }
    lines.push(
      "GUARDRAILS (mandatory): probes are REFLECTION/OBSERVATION ONLY — never destructive, never use real " +
        "or third-party PII, never exfiltrate data, and obey the denylist below. If a probe would mutate or " +
        "delete data you did not create, do NOT propose it.",
    );
    lines.push("");
  }

  if (L.personaDiversity && ctx.personas.length) {
    lines.push(
      `PERSONAS — vary which one attempts each mission (use a name): ${ctx.personas
        .map((p) => p.name)
        .join(", ")}.`,
    );
    lines.push("");
  }

  lines.push(
    "SAFETY: this runs against a live app. Prefer creating your own test data to manipulate. " +
      "Avoid irreversibly destroying data you did not create." +
      (ctx.denylist.length ? ` Never do: ${ctx.denylist.join("; ")}.` : ""),
  );
  lines.push("");
  lines.push(
    `Return ONLY a JSON array of ${ctx.count} mission objects, no prose. Each object: ` +
      `{"goal": string, "startPath": string (a route from the app map), ` +
      `"persona": string (one of the persona names), "hints": string[] (optional, 1-3 concrete steps)}.`,
  );
  return lines.join("\n");
}

export const ProposedMissionSchema = z.object({
  goal: z.string().min(1),
  startPath: z.string().default("/"),
  persona: z.string().optional(),
  hints: z.array(z.string()).default([]),
});
export type ProposedMission = z.infer<typeof ProposedMissionSchema>;

/** Pull the first JSON array out of a model reply (tolerating prose / code fences). */
function extractJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

/**
 * Parse + validate the planner's reply into missions: drops malformed entries,
 * clamps an unknown persona to "unassigned" (engine falls back to the first
 * persona), and caps the count.
 */
export function parseProposedMissions(
  raw: string,
  opts: { personas: string[]; max: number },
): ProposedMission[] {
  const json = extractJsonArray(raw);
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ProposedMission[] = [];
  for (const item of arr) {
    const parsed = ProposedMissionSchema.safeParse(item);
    if (!parsed.success) continue;
    const m = parsed.data;
    if (m.persona && !opts.personas.includes(m.persona)) m.persona = undefined;
    out.push(m);
    if (out.length >= opts.max) break;
  }
  return out;
}
