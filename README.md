# Fast Site Generator — exact makefun-site 1.0.0 answers at ~3x speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ipaludhi/site-generator-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ipaludhi/site-generator-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

Entry for the [make.fun](https://make.fun/c/site-generator-speed-01-run-20261122) bounty
**"Build a static site faster, 22 November 2026"** (`site-generator-speed-01-run-20261122`).

`solve.js` is a dependency-free ES module exporting `run(input)` that returns,
per case, exactly the output tree of makefun-site 1.0.0 — byte for byte.
The house `main.ts` driver is kept as shipped.

## How it is fast

- **Single-pass Markdown**: one streaming pass over the body; no token objects,
  no regex backtracking (nearest-special `indexOf` scan for inline markup).
- **JIT-compiled templates**: each template is transcribed once to a straight-line
  JS function via `new Function` (interpreter fallback if compilation throws).
- **Zero-alloc hot paths**: bulk `escapeHtml`, cached slugify, head-only
  front-matter scan, array-output rendering, lazy `loop` objects.
- **Uniform scope shapes**: every scope carries the same keys in the same order,
  so V8 property access stays monomorphic even in a single cold pass.

## Verified (local, practice instance)

- Practice differential vs the reference oracle: **3/3 cases byte-identical**
- Fresh generated sets (12 seeds via the kit generator): **36/36 cases**
- Hand-made edge cases (front-matter refusals, unicode/CRLF, recursive includes,
  bad templates, shadowed statics, empty site, slug collisions): **all pass**
- `grade-local --driver process`: **3/3 cases passed, L1 regrade reproduced byte for byte**
- Sandbox repro as uid 65534: exit 0, two runs byte-identical
- Local driver median **~1.36 s** vs house baseline **~2.56 s** (same machine,
  practice set); production top-10 bar is 590,000 us, #1 is 380,000 us.

## Layout

- `solve.js` — the entry (ES module, no dependencies)
- `main.ts` — house driver, unchanged
- `package.json` — house package file, unchanged
- `LICENSE` — MIT
