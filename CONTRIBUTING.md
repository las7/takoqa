# Contributing to takoqa

Thanks for your interest! takoqa is a product-agnostic harness: the engine knows
nothing about any specific app, and everything app-specific lives in a profile.
Keep that separation and most changes are easy to reason about.

## Setup

```bash
npm ci
npx playwright install chromium
cp .env.example .env        # add your ANTHROPIC_API_KEY
set -a && . ./.env && set +a
npm test                    # the full suite should be green
```

Try it against the bundled example profile (point `--base-url` at any app you
control and are authorized to test):

```bash
npx tsx src/run.ts --profile profiles/example.yaml --base-url http://localhost:3000
```

## Quality gates (run before opening a PR)

- `npm test` — the unit/integration suite.
- `npm run selfeval` — proves the detectors are load-bearing: neutering an oracle
  must make this regress.
- `npm run eval -- --record` and `npm run metaeval` — the harness-quality ledger.
- `npm run format` — Prettier.

## Adding an app to test

Don't commit app-specific config. Copy `profiles/example.yaml` to
`profiles/<name>.local.yaml` (the `*.local.yaml` suffix is gitignored) and
describe your app's missions there.

## Adding a detector (oracle)

1. Add the check in `src/oracles.ts` and a fixture in `test/`.
2. Make it load-bearing: neuter the detector and confirm `npm run selfeval`
   regresses.
3. Run the full gate set above and include the results in your PR.

## Scope & safety

- Only run takoqa against apps you own or are explicitly authorized to test.
  The `--security` lever performs active (observation-only, non-destructive)
  probing — never point it at staging/production you don't control.
- Keep the engine product-agnostic. If a change hard-codes anything about a
  specific app, it belongs in a profile instead.

## License

By contributing you agree your contributions are licensed under the project's
[MIT License](./LICENSE).
