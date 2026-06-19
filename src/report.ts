/**
 * Persists run artifacts: a machine-readable run.json plus a human-readable
 * findings report grouped by severity. Also a per-run directory of screenshots
 * (written by the engine) that the report links to for reproduction.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, RunReport, Severity } from "./types.js";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/**
 * Folds runs of consecutive identical lines into one annotated line, e.g.
 * ["Clicked X", "Clicked X", "Clicked X"] -> ["Clicked X (x3)"]. Only
 * consecutive runs collapse; a line that recurs after something else stays
 * separate (timeline fidelity). Keeps repro lists readable when an agent
 * hammers the same control across many steps.
 */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let prev: string | undefined;
  let count = 0;
  const flush = (): void => {
    if (prev === undefined) return;
    out.push(count > 1 ? `${prev} (x${count})` : prev);
  };
  for (const line of lines) {
    if (line === prev) {
      count++;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return out;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Writes a self-contained index.html that replays each mission: a step-by-step
 * timeline with the annotated screenshot, the action taken, the agent's
 * rationale, findings flagged on that step, plus the embedded video and a link
 * to the Playwright trace. Opens in any browser, no server needed.
 */
export function writeReplayHtml(dir: string, report: RunReport): void {
  const data = JSON.stringify(report);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA Agent replay — ${esc(report.profile)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: Canvas; color: CanvasText; }
  header { padding: 16px 22px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 13px; }
  .wrap { display: grid; grid-template-columns: 260px 1fr; min-height: calc(100vh - 70px); }
  .missions { border-right: 1px solid color-mix(in srgb, CanvasText 15%, transparent); padding: 10px; overflow:auto; }
  .mbtn { display:block; width:100%; text-align:left; padding:10px 12px; margin-bottom:6px; border-radius:8px; border:1px solid color-mix(in srgb, CanvasText 14%, transparent); background:transparent; color:inherit; cursor:pointer; font-size:13px; }
  .mbtn:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
  .mbtn.active { border-color:#3b82f6; background: color-mix(in srgb, #3b82f6 12%, transparent); }
  .badge { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px; font-weight:600; }
  .passed { background:#16a34a22; color:#16a34a; } .failed,.error { background:#dc262622; color:#dc2626; }
  .stuck { background:#d9770622; color:#d97706; }
  .skipped { background:#64748b22; color:#64748b; }
  .main { padding: 18px 22px; overflow:auto; }
  .links a { font-size:13px; margin-right:14px; }
  video { max-width:100%; border-radius:10px; border:1px solid color-mix(in srgb, CanvasText 15%, transparent); margin:12px 0; background:#000; }
  .step { display:grid; grid-template-columns: 320px 1fr; gap:16px; padding:14px 0; border-top:1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  .step img { width:320px; border-radius:8px; border:1px solid color-mix(in srgb, CanvasText 15%, transparent); cursor:zoom-in; }
  .act { font-weight:600; font-size:14px; }
  .rat { color: color-mix(in srgb, CanvasText 62%, transparent); font-size:13px; margin-top:4px; font-style:italic; }
  .url { font-family: ui-monospace, monospace; font-size:11px; color: color-mix(in srgb, CanvasText 55%, transparent); margin-top:6px; word-break:break-all; }
  .find { margin-top:8px; padding:7px 10px; border-radius:7px; font-size:12.5px; background:#dc262615; border:1px solid #dc262640; }
  .find.low { background:#64748b15; border-color:#64748b40; }
  .stepno { font-size:11px; color: color-mix(in srgb, CanvasText 50%, transparent); }
  dialog { border:none; background:transparent; max-width:95vw; } dialog img { width:auto; max-width:95vw; max-height:90vh; }
</style></head>
<body>
<header><h1>QA Agent replay — ${esc(report.profile)}</h1>
<div class="sub">${esc(report.baseUrl)} · ${esc(report.startedAt)}</div></header>
<div class="wrap">
  <div class="missions" id="missions"></div>
  <div class="main" id="main"></div>
</div>
<dialog id="zoom"><img id="zoomimg" src=""></dialog>
<script>
const REPORT = ${data};
const sevRank = { critical:0, high:1, medium:2, low:3 };
function fmtOutcome(o){ return '<span class="badge '+o+'">'+o+'</span>'; }
function renderMissionList(){
  const el = document.getElementById('missions');
  el.innerHTML = REPORT.results.map((r,i)=>
    '<button class="mbtn" data-i="'+i+'">'+fmtOutcome(r.outcome)+' '+r.missionId+
    '<br><span class="stepno">'+r.steps.length+' steps · '+r.findings.length+' findings</span></button>'
  ).join('');
  el.querySelectorAll('.mbtn').forEach(b=>b.onclick=()=>select(+b.dataset.i));
}
function select(i){
  document.querySelectorAll('.mbtn').forEach((b,j)=>b.classList.toggle('active', j===i));
  const r = REPORT.results[i];
  const findingsByStep = {};
  r.findings.forEach(f=>{ if(f.screenshotPath){ (findingsByStep[f.screenshotPath]=findingsByStep[f.screenshotPath]||[]).push(f); }});
  let html = '<h2 style="margin:4px 0 2px">'+r.missionId+' '+fmtOutcome(r.outcome)+'</h2>';
  html += '<div class="sub" style="margin-bottom:8px">'+escapeHtml(r.goal)+'</div>';
  html += '<div class="links">';
  if(r.videoPath) html += '<a href="'+r.videoPath+'" download>⬇ video</a>';
  if(r.tracePath) html += '<a href="'+r.tracePath+'" download>⬇ trace.zip</a> <span class="sub">(npx playwright show-trace '+r.tracePath+')</span>';
  html += '</div>';
  if(r.videoPath) html += '<video src="'+r.videoPath+'" controls></video>';
  r.steps.forEach(s=>{
    const fs = findingsByStep[s.screenshotPath]||[];
    html += '<div class="step"><div><div class="stepno">step '+s.index+'</div>'+
      (s.screenshotPath?'<img loading="lazy" src="'+s.screenshotPath+'" data-full="'+s.screenshotPath+'">':'')+'</div><div>'+
      '<div class="act">'+escapeHtml(s.actionSummary)+'</div>'+
      (s.rationale?'<div class="rat">“'+escapeHtml(s.rationale)+'”</div>':'')+
      '<div class="url">'+escapeHtml(s.url)+'</div>'+
      fs.map(f=>'<div class="find '+f.severity+'"><b>'+f.severity+'</b> · '+escapeHtml(f.title)+'</div>').join('')+
      '</div></div>';
  });
  if(!r.steps.length) html += '<p class="sub">No steps recorded (mission ended immediately).</p>';
  document.getElementById('main').innerHTML = html;
  document.querySelectorAll('.step img').forEach(img=>img.onclick=()=>{
    document.getElementById('zoomimg').src = img.dataset.full; document.getElementById('zoom').showModal();
  });
}
function escapeHtml(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
document.getElementById('zoom').onclick = e=>{ if(e.target.id!=='zoomimg') e.currentTarget.close(); };
renderMissionList(); if(REPORT.results.length) select(0);
</script>
</body></html>`;
  writeFileSync(join(dir, "index.html"), html);
}

export function createRunDir(root: string, profileName: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(root, `${profileName}-${stamp}`);
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  return dir;
}

export function writeRunReport(dir: string, report: RunReport): void {
  writeFileSync(join(dir, "run.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "findings.txt"), renderFindings(report));
}

function allFindings(report: RunReport): Finding[] {
  return report.results.flatMap((r) => r.findings);
}

export function renderFindings(report: RunReport): string {
  const findings = allFindings(report);
  // Muted findings are known non-bugs — kept out of both the severity tally and
  // the detailed sections (they're accounted for on the Baseline line only).
  const bySeverity = new Map<Severity, Finding[]>();
  for (const s of SEVERITY_ORDER) bySeverity.set(s, []);
  for (const f of findings) {
    if (f.status === "muted") continue;
    bySeverity.get(f.severity)!.push(f);
  }

  const lines: string[] = [];
  lines.push(`QA AGENT RUN — ${report.profile}`);
  lines.push(`Base URL:   ${report.baseUrl}`);
  lines.push(`Started:    ${report.startedAt}`);
  lines.push(`Finished:   ${report.finishedAt}`);
  lines.push(``);

  const passed = report.results.filter((r) => r.outcome === "passed").length;
  const skipped = report.results.filter((r) => r.outcome === "skipped").length;
  lines.push(
    `Missions: ${report.results.length} total — ${passed} passed, ${skipped} skipped, ${
      report.results.length - passed - skipped
    } with issues`,
  );
  lines.push(
    `Findings: ${SEVERITY_ORDER.map((s) => `${bySeverity.get(s)!.length} ${s}`).join(", ")}`,
  );
  const cov = report.coverage;
  if (cov) {
    lines.push(
      `Coverage: ${cov.routesVisited.length} route(s) visited${
        cov.routesVisited.length ? ` — ${cov.routesVisited.join(", ")}` : ""
      }`,
    );
    if (cov.unvisitedKnownRoutes.length) {
      lines.push(
        `  Unvisited known routes: ${cov.unvisitedKnownRoutes.join(", ")}`,
      );
    }
  }
  // Known-bugs baseline tally (only when --baseline classified the findings).
  if (findings.some((f) => f.status)) {
    const n = findings.filter((f) => f.status === "new").length;
    const k = findings.filter((f) => f.status === "known").length;
    const m = findings.filter((f) => f.status === "muted").length;
    lines.push(
      `Baseline: ${n} new, ${k} known${m ? `, ${m} muted (suppressed below)` : ""}`,
    );
  }
  lines.push(``);
  lines.push("=".repeat(72));

  for (const sev of SEVERITY_ORDER) {
    const group = bySeverity.get(sev)!;
    if (!group.length) continue;
    lines.push(``);
    lines.push(`### ${sev.toUpperCase()} (${group.length})`);
    for (const f of group) {
      lines.push(``);
      lines.push(
        `• ${f.status === "new" ? "NEW " : ""}[${f.kind}] ${f.title}` +
          (f.status === "known" ? " (known)" : "") +
          (f.occurrences && f.occurrences > 1
            ? ` (fired ${f.occurrences} times)`
            : ""),
      );
      lines.push(`  Mission: ${f.missionId}  Persona: ${f.persona}`);
      lines.push(`  URL: ${f.url}`);
      lines.push(`  ${f.detail}`);
      const repro = collapseRepeats(f.repro);
      if (repro.length) {
        lines.push(`  Repro:`);
        repro.forEach((step, i) => lines.push(`    ${i + 1}. ${step}`));
      }
      if (f.screenshotPath) lines.push(`  Screenshot: ${f.screenshotPath}`);
      if (f.evidence) lines.push(`  Evidence: ${f.evidence.slice(0, 400)}`);
    }
  }

  if (!findings.length) {
    lines.push(``);
    lines.push("No findings. All missions passed clean. 🎉");
  }

  return lines.join("\n");
}

export function printSummary(report: RunReport): void {
  const findings = allFindings(report);
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  const passed = report.results.filter((r) => r.outcome === "passed").length;
  // eslint-disable-next-line no-console
  console.log(
    `\n${report.profile}: ${passed}/${report.results.length} missions passed | findings: ${SEVERITY_ORDER.map(
      (s) => `${counts[s] ?? 0} ${s}`,
    ).join(", ")}${
      report.coverage
        ? ` | coverage: ${report.coverage.routesVisited.length} route(s)`
        : ""
    }`,
  );
}
