/**
 * Renders the optional app-knowledge block (from Profile.knowledge) into prompt
 * text. Two variants:
 *  - forJudge:false -> full "ABOUT THIS APP" context for the acting agent
 *    (overview + compact route table + glossary + gotchas).
 *  - forJudge:true  -> a leaner judge variant: overview + glossary for grounding,
 *    plus the gotchas reframed as "do NOT flag the following" exclusions.
 * Returns "" when there is nothing to render, so callers can drop it via
 * `.filter(Boolean)` and keep the prompt byte-identical to the no-knowledge case.
 */

import type { Knowledge } from "./types.js";

export function renderKnowledge(
  k: Knowledge,
  { forJudge }: { forJudge: boolean },
): string {
  const lines: string[] = [];

  if (forJudge) {
    if (k.overview.trim()) lines.push(`ABOUT THIS APP: ${k.overview.trim()}`);
    if (k.glossary.length) {
      lines.push(
        `GLOSSARY: ` +
          k.glossary.map((g) => `${g.term} = ${g.meaning}`).join("; "),
      );
    }
    if (k.gotchas.length) {
      lines.push(
        ``,
        `KNOWN BEHAVIORS — do NOT flag the following as defects (they are expected):`,
        ...k.gotchas.map((g) => `- ${g}`),
      );
    }
    return lines.join("\n").trim();
  }

  const hasAny =
    k.overview.trim() ||
    k.routes.length ||
    k.glossary.length ||
    k.gotchas.length;
  if (!hasAny) return "";

  lines.push(`ABOUT THIS APP`);
  if (k.overview.trim()) lines.push(k.overview.trim());

  if (k.routes.length) {
    lines.push(``, `ROUTES:`);
    for (const r of k.routes) {
      const notes: string[] = [];
      if (r.requires) notes.push(`requires: ${r.requires}`);
      if (r.needsWorker) notes.push(`needs a background worker running`);
      const suffix = notes.length ? ` (${notes.join("; ")})` : ``;
      const desc = r.description ? ` — ${r.description}` : ``;
      lines.push(`- ${r.path}${desc}${suffix}`);
    }
  }

  if (k.glossary.length) {
    lines.push(``, `GLOSSARY:`);
    for (const g of k.glossary) lines.push(`- ${g.term}: ${g.meaning}`);
  }

  if (k.gotchas.length) {
    lines.push(``, `GOTCHAS (known quirks, not bugs):`);
    for (const g of k.gotchas) lines.push(`- ${g}`);
  }

  return lines.join("\n");
}
