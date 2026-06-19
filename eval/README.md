# Eval ledger

`eval_ledger.jsonl` is the **committed** baseline for the comparative self-eval —
the durable "previous state" CI diffs each harness change against. Unlike
`runs/`, `baseline/`, `recipes/`, and `learned/` (all gitignored, per-machine),
this file is checked in on purpose: it's the shared regression reference.

`npm run eval` runs the real engine over the planted-bug fixture, scores it, and
compares the result against the last record here over the same dataset hash. A
per-case regression (a bug caught before, missed now) fails the gate even when
aggregate recall is unchanged. `npm run eval -- --record` appends a new record
so each accepted improvement becomes the next baseline.

Two `task` values share this ledger:

- `self_eval` — recall/precision of the harness over the planted-bug fixture.
- `harness_meta` — the meta-eval ("test the tests"): detector **coverage**
  (carried in `metrics.precision`) and **mutation score** (carried in
  `metrics.recall`), with `perCase[<kind>] = isProtected`. A detector going
  protected → unprotected is the per-case regression that fails `npm run metaeval`.
