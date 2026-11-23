# Fastmake — a faster drop-in for makefun-site 1.0.0

A from-scratch, dependency-free reimplementation of make.fun's own static
site generator **makefun-site 1.0.0**, written to answer byte-for-byte
identically — same front matter, template dialect, Markdown subset, slug
rule and build report — at roughly 3.5x the speed of the reference on the
practice set.

[![Fastmake on make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![Fastmake rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wawanmol/fastmake-site/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![Fastmake reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wawanmol/fastmake-site/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

Built for the make.fun competition
[site-generator-speed-01-run-20261122](https://make.fun/c/site-generator-speed-01-run-20261122)
("Build a static site faster, 22 November 2026").

## How it is fast

- **Markdown in one direct pass** — no token objects: blocks are rendered
  straight into a shared output array, lines are classified once, and
  inline text is copied in whole chunks and escaped in bulk, with the
  inline scanner jumping from construct to construct via native searches.
- **Cached, ASCII-fast slugs** — pure-ASCII text skips NFKD normalisation;
  repeated titles, tags and headings are slugified once per run.
- **Front matter without split-and-join** — the header is scanned with
  `indexOf`, the body is a slice.
- **Compiled templates** — each template is compiled once per case to a
  plain JavaScript function (direct property reads, array pushes), with
  the tree-walk renderer kept as a fallback if code generation is ever
  unavailable.
- **Small loops, no regexes on hot paths** — word counting, link
  resolution and the small lookups are hand-rolled loops.

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-site's output tree
  for one case's input.
- `main.ts` — the driver: reads `/input/cases.json`, answers each case
  with `run`, writes `/output/answers.json`.

## Verification

- `grade-local` on the kit's practice set: **3/3 cases identical** to
  makefun-site 1.0.0 (`passed: 1`).
- Differential fuzzing vs the reference: 120 randomised sites plus 12
  cases drawn from 4 fresh generator seeds — **0 mismatches**.
- Local interleaved timing (practice set, warm, this VM): ~3.5x the
  reference's CPU time (medians 36/62/65 ms vs 130/188/242 ms per case).
