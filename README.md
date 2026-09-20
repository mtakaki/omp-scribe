# omp-scribe
[![npm version](https://img.shields.io/npm/v/omp-scribe.svg)](https://www.npmjs.com/package/omp-scribe)

Cost-reduction extension for oh-my-pi. It splits expensive-model prose authoring into two phases — a compact blueprint from the expensive model, then Markdown expansion by a cheap model — and substitutes the expanded text into the pending `write` before the native tool executes, so the expensive model never emits the document body. **Plan mode** runs automatically: the plan model calls `propose_plan_blueprint` with compact JSON metadata plus **Scribe IR** — a `files` table of 3-element `[id, path, reason]` tuples and a `steps` array of 6-element `[fileId, operation, range|null, intent, preserve[], doNot[]]` tuples, structurally validated by `src/scribe-ir.ts` — then writes the literal placeholder `"pending"` (7 bytes) as the plan file's content. Scribe IR replaced the earlier Tokenized Architectural Diff string DSL (`@path[start-end]{op}deps(...)#intent`), whose single hand-rolled regex needed follow-up fixes for paths containing brackets or parentheses and for single-line range shorthand, and which forced five files to stay in lock-step for any format tweak; Scribe IR rides ordinary JSON tool-call arrays and reports precise per-field errors (duplicate file id, unknown file id, invalid operation, inverted range, empty string) instead of one generic regex mismatch, replaces the free-floating `deps(...)` list with explicit `preserve`/`doNot` arrays per step, and lets steps that share a file reuse one `files`-table entry instead of repeating the path on every line. **Doc-blueprint mode** (opted in with `/scribe-doc`) applies the same blueprint-and-expand flow to any standalone Markdown document — README, ARCHITECTURE, CHANGELOG entries, ADRs, PR descriptions.

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

## Learn more

- `AGENTS.md` — repository guidelines, conventions, testing, and the manual QA checklist.
- `ARCHITECTURE.md` — full module-by-module breakdown and data-flow diagram.
- `PATTERNS.md` — async/error-handling/type-safety code patterns used throughout `src/`.
