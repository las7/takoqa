# takoqa

**A swarm of browser agents that breaks your web app before your users do.**

_Plain-language missions in, real bugs out._

takoqa drives a real Chromium browser against your running app, perceives each
page the way a person does, and decides its next action with an LLM — clicking,
typing, uploading, and exploring toward a goal you describe in plain language.
Along the way it watches for broken behavior and reports what it finds, with
screenshots, a video, and a step-by-step replay.

The engine knows nothing about any specific product. Everything app-specific
lives in a single profile file, so pointing takoqa at a new app is just writing
a new `profiles/*.yaml`.

## How it works

Each step runs a four-beat loop:

1. **Observe** — tag every visible interactive element with a ref number, plus a
   screenshot and the page text.
2. **Decide** — the LLM is given that list (and the screenshot) and picks one
   human action, addressing elements by ref — never by CSS selector.
3. **Act** — Playwright performs the action; the target is highlighted on-page
   first so the recording shows exactly what was clicked.
4. **Check** — captured console errors, uncaught exceptions, and HTTP responses
   run through the oracles. A finding is raised when something looks broken.

At the end of each mission an LLM judge decides whether the user's goal was
actually met and flags UX/quality issues even when the flow technically worked.

## What it catches

- **Functional bugs** — JS exceptions, 5xx responses, console errors, crash text.
- **Exploratory/edge cases** — give it a goal and no script; it wanders.
- **UX/quality** — the judge flags confusing or degraded flows.
- **Regressions** — every run is saved (JSON, screenshots, video, trace) for
  run-to-run comparison.

## Self-improvement

takoqa gets smarter the more it runs, without anyone editing the profile:

- **Known-bugs baseline** (`--baseline`) classifies each finding `new` / `known`
  / `muted` so a repeat run reports only what changed.
- **Learned store** — during `--loop` the harness distills durable app facts from
  what it saw (routes that turned out to be gated, controls that never did
  anything, what each page actually offers, missions already tried) into a
  per-profile JSON sidecar. The next run merges the confident subset into the
  app map it hands the acting agent, so it stops re-discovering the same things.
  Facts need ≥2 sightings to count and decay if not re-seen, so a one-off flake
  never ossifies. Learnings inform the _agent_ only — never the judge.
- **`--mute "<kind|title>" --as "<reason>"`** marks a finding a known non-bug. It
  is dropped from the report and the CI gate, and the reason is fed to the LLM
  judge as a "do not flag" exclusion next run — so a triaged non-bug stops coming
  back. (The reason is the _only_ feedback signal allowed to reach the judge.)

The baseline (`baseline/`), recipes (`recipes/`), and learned store (`learned/`)
are plain, human-inspectable JSON — delete an entry to forget it.

## Quick start

```bash
npm install
npx playwright install chromium

# Copy the template and point it at your app:
cp profiles/example.yaml profiles/myapp.local.yaml   # *.local.yaml is gitignored

ANTHROPIC_API_KEY=sk-... npx tsx src/run.ts \
  --profile profiles/myapp.local.yaml --tag smoke
```

Outputs land in `runs/<profile>-<timestamp>/`:

- `index.html` — self-contained replay: step timeline, screenshots, embedded
  video, and findings. Open it in any browser.
- `findings.txt` / `run.json` — human- and machine-readable results.
- `missions/<id>/video.webm` and `trace.zip` — per-mission recordings
  (`npx playwright show-trace <path>` for the time-travel viewer).

### Useful flags

| Flag               | Effect                                              |
| ------------------ | --------------------------------------------------- |
| `--headed`         | Watch the browser live                              |
| `--tag <t>`        | Run only missions with this tag                     |
| `--base-url <url>` | Override the profile's baseUrl (local/staging/prod) |
| `--no-record`      | Skip video/trace for fast headless runs             |
| `--mock`           | Run the loop with a scripted client (no API key)    |

## Writing a profile

A profile declares **intent and failure conditions**, not clicks. See
[`profiles/example.yaml`](profiles/example.yaml) for a documented template:
`baseUrl`, an `auth` strategy, `personas` (who's driving), `invariants` (what
counts as a bug), and `missions` (goals + success criteria the LLM judge uses).

## Testing takoqa itself

takoqa is verified against a deliberately-buggy fixture app — no real app or API
key needed:

```bash
npm test          # oracle unit tests + engine integration tests
npm run test:unit # fast, browserless oracle tests only
npm run selfeval  # absolute gate: does it catch the planted bugs? (see below)
npm run eval      # comparative gate: did it regress vs the previous state?
npm run metaeval  # meta gate: is every detector exercised AND protected?
```

These are three gates on three different questions. `selfeval` asks _do we catch
the planted bugs_ (absolute recall/precision). `eval` asks _did we get worse than
last time_ (comparative, per-case). `metaeval` asks _would we even notice if a
detector broke_ (coverage + mutation) — the question the other two can't answer.

### Self-eval

`npm run selfeval` is the regression gate on takoqa's own coverage. It runs the
real engine over the planted-bug fixture in two passes (functional + security),
scores the findings against a co-located ground-truth manifest
(`test/fixture-manifest.ts`), and asserts full recall over every must-catch case
with zero false positives on the clean routes. A refactor that stops an oracle
from firing — or starts crying wolf on a clean page — fails this gate and names
the exact case. Adding a planted route to the fixture forces a matching manifest
entry, so coverage can't silently rot.

### Comparative eval

`npm run eval` goes one step further than the absolute self-eval gate: it scores
the harness against the planted-bug fixture **and** diffs that score against the
previous committed record (`eval/eval_ledger.jsonl`) — reporting the delta, not
just the value. A per-case regression (a bug caught before, missed now) fails the
gate even when aggregate recall is unchanged, which the absolute recall gate
can't see. Each record stamps git provenance + a byte-hash of the fixture, so a
stale baseline over a different fixture simply stops being comparable. `npm run
eval -- --record` appends a new record, so every accepted improvement becomes the
prior state the next change is measured against.

### Meta-eval (test the tests)

`npm run metaeval` gates the gate itself. The self-eval proves takoqa catches the
planted bugs, but it can't tell you whether every detector takoqa _ships_ is
actually exercised — a detector with no fixture case, or one always co-caught by
another kind, could quietly stop firing and both gates above would stay green.
The meta-eval answers two questions:

- **Coverage** — is every deterministic detector kind exercised by a fixture
  case? `KIND_CLASS` (in `src/metaeval.ts`) classifies every `FindingKind` as a
  `detector` or an LLM/agent `judgment`; because it's an exhaustive map, adding a
  new kind is a _compile error_ until it's classified, so a detector can't ship
  without a coverage decision.
- **Mutation / ablation** — would the self-eval actually _fail_ if a detector
  broke? For each detector it drops that kind's findings from a passing report and
  re-scores: if a previously-caught case now misses, the detector is `protected`;
  if the case stays caught (some other kind covers it), it's `shadowed` — covered
  on paper but the eval is blind to it breaking.

Like the comparative eval, it records to `eval/eval_ledger.jsonl` (as the
`harness_meta` task) and diffs against the previous state, so a detector going
`protected → unprotected` fails the gate. `npm run metaeval -- --record` appends a
new baseline.

### Pluggable route discovery

Route discovery is pluggable, so takoqa points at any app — not just Next.js.
`--explore`/`--matrix` accept `--app-dir <path>` (read a Next.js app-router
tree), `--routes a,b,c` (an explicit, app-agnostic list), or `--sitemap <url>`
(extract same-origin paths from a sitemap.xml). A profile can pin the same via
`explore.source` (or keep the `explore.appDir` shorthand).

## Docker

```bash
docker build -t takoqa .
docker run --rm --network host -e ANTHROPIC_API_KEY=sk-... \
  -v "$PWD/runs:/app/runs" takoqa --profile profiles/example.yaml --tag smoke
```

See [`docker-compose.example.yml`](docker-compose.example.yml) for wiring takoqa
into an app's compose stack.

## License

MIT — see [LICENSE](LICENSE).
