# omp-scribe
[![npm version](https://img.shields.io/npm/v/omp-scribe.svg)](https://www.npmjs.com/package/omp-scribe)

omp-scribe is a cost-reduction extension for oh-my-pi: it splits expensive-model prose authoring into two phases — a compact blueprint from the expensive model, then Markdown expansion by a cheap model — so the expensive model never emits the full document body itself. See [How does it work](#how-does-it-work) for the blueprint format and mode details.

## Install from npm

```bash
omp install omp-scribe
```

Or visit the [npm package page](https://www.npmjs.com/package/omp-scribe).

## Install & build

Prerequisites: Node.js 16+ (ES2022/ESNext modules) or Bun, and oh-my-pi 18.1.6 or compatible (it provides the `ExtensionAPI` this extension is built against).

```bash
npm install         # devDependencies only: @oh-my-pi/pi-coding-agent, typescript, @types/bun
npm run build       # tsc -p tsconfig.json — compiles src/**/*.ts to dist/**/*.js
npm run typecheck   # type-check src/ + tests/ without emitting
bun test            # unit/integration suite
```

The extension has **zero runtime dependencies** — all oh-my-pi API access arrives through the `ExtensionAPI` parameter injected into the default export, never a direct import, so the nested writer session shares the host's singleton `AgentRegistry` and `local://` resolver state. `dist/index.js` is the entry point oh-my-pi loads (declared in `package.json` as `"omp": { "extensions": ["./dist/index.js"] }`), so build before loading; `npm publish` rebuilds via its `prepublishOnly` hook.

## Run locally

```bash
npm run build
# this invocation only — not installed, not listed in /extensions:
omp --extension /path/to/omp-scribe --plan-yolo -p "Your plan request here"
# register the package so every session loads it (npm spec, local path, or marketplace ref):
npm run link:local   # omp plugin link . — link this checkout instead
```

`--plan-yolo` forces read-only plan mode at start and auto-approves the model's first resolve call; use a plain `--plan=<model>` plus a normal plan-mode prompt if you want to approve manually. `/extensions` ("OMP Extension Packages") lists only installed or linked packages, never `-e`/`--extension` one-offs. Plan-mode detection reads the session branch, so plan mode must be entered *before* the prompt — `omp --plan-yolo -p "..."` only becomes detectable on the second turn.

## Configuration flags

| Flag | Default | Effect |
|---|---|---|
| `--scribe-writer-model=<value>` | `@smol` | Model role/id resolved for the nested session that expands a blueprint (the plan-mode Scribe IR brief or the doc-mode outline) into Markdown. Also settable per project at runtime with `/scribe-model`. |
| `--scribe-brain-model=<value>` | unset | Advisory only. If set and the active model at blueprint-submission time doesn't match, logs a warning; it does not switch models — use `modelRoles.plan` / `--plan` / `PI_PLAN_MODEL` to control the plan-mode model. |

Writer model precedence: non-default `--scribe-writer-model` → per-project override persisted at `.claude/plans/scribe_config.json` (written by `/scribe-model`) → `@smol`. A flag left at its default is indistinguishable from an unset flag, so `--scribe-writer-model=@smol` cannot beat a persisted override — run `/scribe-model reset` instead. The override file is written atomically, and a missing, malformed, or hand-edited file degrades to "no override" rather than failing the session.

## Commands

| Command | Description |
|---|---|
| `/savings` | Cost-savings dashboard: actual dual-model cost vs. a simulated single-brain-model baseline, broken down by plan-mode and doc-mode runs. When the live brain model has no catalog rate, the baseline is estimated from the `@plan`-role reference model's rates instead of collapsing to $0.00, and the affected figures are marked `~$`. |
| `/scribe-doc` | Arm doc-blueprint mode for the next standalone Markdown document write this session. Run again to disarm. |
| `/scribe-model` | Show or change the writer model. No argument opens a picker of authenticated models; `reset` drops the per-project override; a model spec (`provider/id` or `@role`) sets it directly. Argument completions offer `@smol`, `reset`, and the authenticated models. A spec that does not resolve leaves both the config file and the footer untouched. |

## Understanding `/savings` output
Example output (recent-run slugs anonymized; every other figure is real accumulated data from this repository — logged before blueprint-token tracking, so the without-scribe row subtracts no blueprint cost):

```text
╔────────────────────────────────────────────────────────────────╗
║                 SCRIBE COST-SAVINGS DASHBOARD                  ║
╟────────────────────────────────────────────────────────────────╢
║  Total plan-mode runs                                      19  ║
║  Total doc-mode runs                                        0  ║
║  Total actual cost                                   $18.4118  ║
║  Total baseline cost (est.)                           $8.5629  ║
║  Total net savings                                    $0.4341  ║
║  Avg. savings / run                                   $0.0174  ║
║  Baseline via @plan-role estimate                           0  ║
╟────────────────────────────────────────────────────────────────╢
║  Brain tokens input                                   176,556  ║
║  Brain tokens output                                  729,819  ║
║  Writer tokens input                                  111,779  ║
║  Writer tokens output                                 116,125  ║
║  Estimated brain tokens output without scribe         845,944  ║
╟────────────────────────────────────────────────────────────────╢
║  Free/local writer runs                                    16  ║
║  Paid (remote) writer runs                                  1  ║
║  Writer spend (paid runs)                             $0.0404  ║
║  Savings via free writer                              $0.4341  ║
║  Savings via paid writer                              $0.0000  ║
╟────────────────────────────────────────────────────────────────╢
║  Recent runs:                                                  ║
║    2026-09-20  feature-auth-refactor                  $0.0072  ║
║    2026-09-20  bugfix-null-check                      $0.0594  ║
║    2026-09-20  add-retry-logic                        $0.0490  ║
║    2026-09-20  update-error-messages                  $0.0542  ║
║    2026-09-20  optimize-query-cache                   $0.0345  ║
╚────────────────────────────────────────────────────────────────╝
⚠  4 run(s) used a brain model with no known per-token output rate in the catalog (e.g. a local/custom model); their baseline (and net savings) is recorded as $0.00 unless an @plan-role estimate replaced it — real baseline may be higher.
```

The `/savings` command renders an ASCII dashboard summarizing the cumulative data in `.claude/plans/savings_stats.json`. Rows appear in this exact top-to-bottom order (labels below match the literal strings in `formatSavingsDashboard`, `src/stats-store.ts`):

**Run & cost summary**
- `Total plan-mode runs` — count of blueprint expansions run in plan mode (`totalPlanRuns`).
- `Total doc-mode runs` — count of blueprint expansions run in doc mode (`totalDocRuns`).
- `Total actual cost` — cumulative real dollars spent across brain + writer calls for all logged runs (`totalActualCostUsd`).
- `Total baseline cost (est.)` — cumulative simulated cost had a single expensive model authored every document body itself, with no brain/writer split (`totalBaselineCostUsd`).
- `Total net savings` — `totalBaselineCostUsd` minus `totalActualCostUsd`, accumulated across all runs (`totalNetSavingsUsd`). Prefixed with `~` whenever at least one contributing baseline was estimated (see "Baseline via @plan-role estimate" below).
- `Avg. savings / run` — `totalNetSavingsUsd` divided by the total run count, i.e. mean savings per logged run. Carries the same `~` prefix rule as "Total net savings".
- `Baseline via @plan-role estimate` — count of runs whose baseline cost had no catalog rate for the live brain model and was instead priced from the `@plan`-role reference model's rates (`totalEstimatedBaselineRuns`).

**Token counters**
- `Brain tokens input` — cumulative input tokens consumed by the expensive (brain) model across all runs (`totalBrainInputTokens`).
- `Brain tokens output` — cumulative output tokens produced by the brain model (`totalBrainOutputTokens`).
- `Writer tokens input` — cumulative input tokens consumed by the cheap writer model that expands blueprints into Markdown (`totalWriterInputTokens`).
- `Writer tokens output` — cumulative output tokens produced by the writer model (`totalWriterOutputTokens`).
- `Estimated brain tokens output without scribe` — what the brain would have emitted had it authored every document body itself: `totalBrainOutputTokens` + `totalWriterOutputTokens` − `totalIrOutputTokens`, the blueprint JSON the brain emits only because of scribe (estimated at roughly four characters per token). Files predating blueprint-token tracking lack `totalIrOutputTokens` and read as zero, so the estimate then subtracts nothing and is an upper bound.

**Writer-cost breakdown**
- `Free/local writer runs` — count of runs where the writer model was free/local, i.e. `writerCostUsd === 0` for that run (`totalFreeWriterRuns`).
- `Paid (remote) writer runs` — count of runs where the writer model billed a nonzero cost (`totalPaidWriterRuns`).
- `Writer spend (paid runs)` — cumulative real dollars billed by paid writer models alone, excluding brain-model cost (`totalWriterCostUsd`).
- `Savings via free writer` — cumulative net savings attributable to runs that used a free/local writer, where the full brain-vs-baseline gap applies (`totalFreeWriterNetSavingsUsd`).
- `Savings via paid writer` — cumulative net savings attributable to runs that used a paid writer, i.e. a smaller offset since the writer itself still cost money (`totalPaidWriterNetSavingsUsd`).

**Recent runs** (shown only when at least one run has been logged)
- `Recent runs:` — section label.
- Up to five most-recent entries, each rendered as `  <date>  <slug>` on the left (the slug truncated to 25 characters plus `...` past 28 characters) with a savings figure on the right: the run's net savings prefixed with `~` when `baselineIsEstimate` is set, the plain dollar amount when `priced` is true, or the literal string `unpriced` when the run's models fell outside the pricing catalog.

**Footnotes** (each shown only when applicable)
- `⚠  <n> run(s) used a brain model with no known per-token output rate in the catalog...` — appears when `totalUnpricedRuns > 0`; warns that those runs' baseline (and therefore savings) defaulted to $0.00 unless an `@plan`-role estimate replaced it.
- `ℹ  <n> run(s) had no catalog rate for the live brain model...` — appears when `totalEstimatedBaselineRuns > 0`; clarifies that the `~$`-marked figures above are `@plan`-role-derived estimates, not billed amounts.

## How does it work

**Plan mode** runs automatically: the plan model calls `propose_plan_blueprint` with compact JSON metadata plus **Scribe IR** — a `files` table of 3-element `[id, path, reason]` tuples and a `steps` array of 6-element `[fileId, operation, range|null, intent, preserve[], doNot[]]` tuples, structurally validated by `src/scribe-ir.ts` — then writes the literal placeholder `"pending"` (7 bytes) as the plan file's content. The extension substitutes the expanded Markdown into that pending `write` before the native tool executes, so the expensive model never emits the document body itself.

Scribe IR replaced the earlier Tokenized Architectural Diff string DSL (`@path[start-end]{op}deps(...)#intent`), whose single hand-rolled regex needed follow-up fixes for paths containing brackets or parentheses and for single-line range shorthand, and which forced five files to stay in lock-step for any format tweak; Scribe IR rides ordinary JSON tool-call arrays and reports precise per-field errors (duplicate file id, unknown file id, invalid operation, inverted range, empty string) instead of one generic regex mismatch, replaces the free-floating `deps(...)` list with explicit `preserve`/`doNot` arrays per step, and lets steps that share a file reuse one `files`-table entry instead of repeating the path on every line.

**Doc-blueprint mode** (opted in with `/scribe-doc`) applies the same blueprint-and-expand flow to any standalone Markdown document — README, ARCHITECTURE, CHANGELOG entries, ADRs, PR descriptions.

## Learn more

- `AGENTS.md` — repository guidelines, conventions, testing, and the manual QA checklist.
- `ARCHITECTURE.md` — full module-by-module breakdown and data-flow diagram.
- `PATTERNS.md` — async/error-handling/type-safety code patterns used throughout `src/`.
