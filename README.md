# omp-scribe

Cost-reduction extension for oh-my-pi. It splits expensive-model prose authoring into two phases — a compact blueprint from the expensive model, then Markdown expansion by a cheap model — and substitutes the expanded text into the pending `write` before the native tool executes, so the expensive model never emits the document body.

- **Plan mode** (automatic): the plan model submits a blueprint and writes the literal placeholder `"pending"` (7 bytes) as the plan file's content.
- **Doc-blueprint mode** (opted in with `/scribe-doc`): the same blueprint-and-expand flow for any standalone Markdown document the brain model is about to author — README, ARCHITECTURE, CHANGELOG entries, ADRs, PR descriptions.

## Mechanics

**Plan mode.** `before_agent_start` fires every turn. `isPlanModeActive()` lets the newest mode signal in the session branch (`ctx.sessionManager.getBranch()`) decide: a `mode_change` entry (`"plan"` = on; `"plan_paused"`/`"none"`/`"goal"`/`"vibe"` = off), or — for `--plan-yolo`, which arms plan mode without persisting one — the hidden `plan-mode-context` message (on) and `plan-yolo-handoff` (off). On a plan turn the extension activates `propose_plan_blueprint` via `pi.setActiveTools()` and appends a `<scribe>` directive to the system prompt. The plan model then submits one compact `PlanBlueprint`: `slug`, `title`, `context`, `approach[]` (one Tokenized Architectural Diff line per step, in the format `@path/to/file.ext[start-end]{+|!|~}deps(dep/a.ts,dep/b.ts)#snake_case_intent`, where `[start-end]` is omitted for new files, `{+}` adds, `{!}` deletes, `{~}` modifies, `deps` may be empty, and `#intent` is a snake_case label), `criticalFiles[{path,reason}]`, `verification[]`, `assumptions[]`. The three trailing sections are optional — models drop trailing tool-argument keys, and a dropped key must not become a hard validation failure that forces a retry.

The tool's `execute` handler calls `expandBlueprintToMarkdown()` (`src/writer-session.ts`): it parses each TAD line, hydrates the referenced file line-ranges from disk, spawns a short-lived, tools-free nested `AgentSession` on the writer model with `WRITER_SYSTEM_PROMPT`, sends a labelled plain-text brief holding each step's raw TAD line plus its hydrated snippet, and streams back the Markdown. The result is cached in the process-wide `pendingMarkdownStore()`, keyed by `slug`; if the expansion fails, the tool says so and tells the model to write the plan itself. The plan model writes `path: "local://<slug>-plan.md"`, `content: "pending"`. A `tool_call` handler then resolves the draft to consume — `planFileTarget()` recognises every `local://*plan.md` artifact the host lists as a plan file, and `pendingPlanEntry()` picks the declared slug first, then the session's only pending draft, which is what makes the host's default `local://PLAN.md` target work. On a hit it swaps `content` for the expanded Markdown and deletes the entry. If the placeholder arrives with nothing to resolve, the write is blocked with an explanatory error naming the pending slugs, so the literal word never lands in a plan file; any other content passes through unmodified. `session_shutdown` purges leftover entries for that session.

**Doc-blueprint mode.** Running `/scribe-doc` adds the current session key to the process-wide `armedDocSessions()` set (running it again while armed toggles it off). On the next `before_agent_start` the extension activates `propose_doc_blueprint` and appends a `<scribe-doc>` directive. The brain model submits one compact `DocBlueprint`: `slug`, `title`, `path` (the exact write target, e.g. `"README.md"`), `sections[{heading, bullets}]`. `expandDocBlueprintToMarkdown()` sends `{title, sections}` to a nested session running `DOC_WRITER_SYSTEM_PROMPT`; the result is cached in `pendingDocMarkdownStore()` keyed by `path`, and the declared path is recorded in `docDraftHistory()` (`path` → owning session key) so a stale retry is still recognised as doc-mode traffic. The brain model writes `path: "<declared path>"`, `content: "pending"`, and the `tool_call` handler resolves the draft on every non-plan write: `pendingDocEntry()` tries the declared path first, then the session's only pending draft — so a write to `./README.md` still matches a blueprint that declared `README.md`. On a hit it swaps content, deletes the entry, and disarms doc mode for the session. A placeholder with nothing to resolve is blocked, both while doc mode is armed and on a stale retry after the draft was consumed (`docDraftHistory()` recognises a path this session ever declared), so the literal word never lands in a file a blueprint targeted; writes to never-declared paths with doc mode unarmed always pass through unmodified. `session_shutdown` purges all three stores for that session.

## Requirements and install

- Node.js 16+ (ES2022/ESNext modules) or Bun
- oh-my-pi 18.1.6 or compatible (provides the `ExtensionAPI` this extension is built against)

```bash
npm install         # devDependencies only: @oh-my-pi/pi-coding-agent, typescript, @types/bun
npm run build       # tsc -p tsconfig.json — compiles src/**/*.ts to dist/**/*.js
npm run typecheck   # tsc -p tsconfig.json --noEmit — type-check without emitting
```

The extension has **zero runtime dependencies** — all oh-my-pi API access comes through the `ExtensionAPI` parameter injected into the default export, never a direct import, so the nested writer session shares the host's singleton `AgentRegistry` and `local://` resolver state. `dist/index.js` is the entry point oh-my-pi loads (declared in `package.json` as `"omp": { "extensions": ["./dist/index.js"] }`), so run `npm run build` before loading the extension.

## Run locally

oh-my-pi reads this project's `package.json` `"omp.extensions"` manifest to resolve `dist/index.js`:

```bash
npm run build
omp --extension /path/to/omp-scribe --plan-yolo -p "Your plan request here"
```

`--plan-yolo` forces read-only plan mode at start and auto-approves on the model's first resolve call; use a plain `--plan=<model>` plus a normal plan-mode prompt instead if you want to approve manually. `-e`/`--extension` loads the extension for that single CLI invocation only (a "cli"/"temporary" scope extension): it activates `propose_plan_blueprint` and the write-interception hooks, but does **not** register the extension as an installed package, so it never appears in the interactive `/extensions` command — the Extension Control Center's "OMP Extension Packages" category lists only packages installed under `~/.omp/plugins` (or `.omp/plugins` for `--local` scope). To load it in every session and make it discoverable there, run `omp install ./` (or `npm run link:local`) once and open a fresh interactive session.

### Verifying

Plan-mode detection reads the session branch, so plan mode must be entered *before* the prompt — `omp --plan-yolo -p "..."` only becomes detectable on the second turn. In a directory with no plan state, a normal turn must neither activate the blueprint tool nor inject the `<scribe>` directive. With plan mode on, the footer must read `Scribe ● plan (writer: …)`, then `Scribe ● plan — <n> chars drafted (writer: <provider/id>)`, reverting to the mode-only line after the `write` swap. Inspect the transcript under `~/.omp/agent/sessions/` for:

- a `propose_plan_blueprint` call whose arguments are compact metadata plus one TAD line per approach step (not Markdown prose)
- a subsequent `write` call whose model-authored `content` argument is the literal `"pending"` (7 bytes)
- the file at `local://<slug>-plan.md` on disk containing the full expanded Markdown (2000+ bytes)
- a `mode: "plan"` run appended to `savings_stats.json` under `<cwd>/.claude/plans/`

For doc mode, start a session with `omp --extension /path/to/omp-scribe -p "/scribe-doc"` followed by a prompt asking for a README (or other long-form document), then confirm a `propose_doc_blueprint` call with compact JSON (bullets only, no prose) and a subsequent `write` call with `content: "pending"`, that the file on disk contains the full expanded Markdown, and that `/savings` reports **Total doc-mode runs** = 1.

## Configuration flags

Registered by `registerScribeFlags()` (`src/config.ts`):

| Flag | Default | Effect |
|---|---|---|
| `--scribe-writer-model=<value>` | `@smol` | Model role/id resolved for the nested session that expands a blueprint (the plan-mode TAD brief or the doc-mode outline) into Markdown. Also settable per project at runtime with `/scribe-model`. |
| `--scribe-brain-model=<value>` | unset | Advisory only. If set and the active model at blueprint-submission time doesn't match, logs a warning; does not switch models itself — use `modelRoles.plan` / `--plan` / `PI_PLAN_MODEL` to actually control the plan-mode model. |

### Writer-model resolution

Resolved once per session (on `session_start`, from `readScribeConfig()`) in this order:

1. `--scribe-writer-model=<value>`, when the value differs from the registered default (`@smol`)
2. the per-project override persisted at `.claude/plans/scribe_config.json` (written by `/scribe-model`)
3. `@smol`

A flag left at its default is indistinguishable from an unset flag, so `--scribe-writer-model=@smol` cannot beat a persisted override — run `/scribe-model reset` (or pass a different flag value) instead. The persisted file is written atomically (temp sibling + rename), and a missing, malformed, or hand-edited file degrades to "no override" rather than failing the session.

## Commands

| Command | Description |
|---|---|
| `/savings` | Show the cost-savings dashboard: actual dual-model cost vs. simulated single-brain-model baseline, broken down by plan-mode runs and doc-mode runs. When the live brain model has no catalog rate, the baseline is estimated from the `@plan`-role reference model's rates instead of collapsing to $0.00, and the affected figures are marked `~$`. |
| `/scribe-doc` | Arm doc-blueprint mode for the next standalone Markdown document write this session. Run again to disarm. |
| `/scribe-model` | Show or change the writer model. No argument opens a picker of authenticated models; `reset` drops the per-project override; a model spec (`provider/id` or `@role`) sets it directly. Argument completions offer `@smol`, `reset`, and the authenticated models. A spec that does not resolve leaves both the config file and the footer untouched. |

### Sample output

Real `/savings` output, with the five most recent run labels replaced by generic task names; every figure, count, and date is verbatim from this project's `.claude/plans/savings_stats.json`.

```
╔────────────────────────────────────────────────────────────────╗
║                 SCRIBE COST-SAVINGS DASHBOARD                  ║
╟────────────────────────────────────────────────────────────────╢
║  Total plan-mode runs                                      11  ║
║  Total doc-mode runs                                        0  ║
║  Total actual cost                                   $13.0687  ║
║  Total baseline cost (est.)                           $2.9251  ║
║  Total net savings                                    $0.1394  ║
║  Avg. savings / run                                   $0.0082  ║
║  Baseline via @plan-role estimate                           0  ║
╟────────────────────────────────────────────────────────────────╢
║  Brain tokens input                                   176,410  ║
║  Brain tokens output                                  561,270  ║
║  Writer tokens input                                   56,321  ║
║  Writer tokens output                                  86,658  ║
╟────────────────────────────────────────────────────────────────╢
║  Free/local writer runs                                     8  ║
║  Paid (remote) writer runs                                  1  ║
║  Writer spend (paid runs)                             $0.0404  ║
║  Savings via free writer                              $0.1394  ║
║  Savings via paid writer                              $0.0000  ║
╟────────────────────────────────────────────────────────────────╢
║  Recent runs:                                                  ║
║    2026-09-20  rename-core-module                     $0.0404  ║
║    2026-09-20  add-blueprint-format                   $0.0536  ║
║    2026-09-19  fix-cost-baseline-calc                 $0.0454  ║
║    2026-09-19  add-role-reference                     $0.0000  ║
║    2026-09-19  adjust-writer-token-est                $0.0000  ║
╚────────────────────────────────────────────────────────────────╝
⚠  4 run(s) used a brain model with no known per-token output rate in the catalog (e.g. a local/custom model); their baseline (and net savings) is recorded as $0.00 unless an @plan-role estimate replaced it — real baseline may be higher.
```

## Footer status

While a session is open, Scribe keeps a single footer line current (`ctx.ui.setStatus("scribe", …)`):

| State | Line |
|---|---|
| Idle | `Scribe ○ idle (writer: @smol)` |
| Doc-blueprint mode armed | `Scribe ○ doc armed (writer: @smol)` |
| Plan turn running | `Scribe ● plan (writer: @smol)` |
| Plan draft awaiting its placeholder write | `Scribe ● plan — 711 chars drafted (writer: anthropic/claude-haiku-4-5-20251001)` |
| Doc turn running | `Scribe ● doc (writer: @smol)` |
| Doc draft awaiting its placeholder write | `Scribe ● doc — 711 chars drafted (writer: anthropic/claude-haiku-4-5-20251001)` |
| Expansion failed | `Scribe ✗ plan expansion failed — <reason>` |

Until a draft exists the writer label is the configured spec; once one does, it is the concrete `provider/id` that produced it plus the drafted character count, and the failure reason is flattened to one line and truncated to 60 characters. The line reverts as soon as the write swap consumes the draft (which also disarms doc mode), the plan/doc states are recomputed at every `before_agent_start`, and it is cleared on `session_shutdown`. Nothing is written in sessions without UI (`ctx.hasUI === false`, e.g. `omp -p`).

## Project structure

| File | Purpose |
|---|---|
| `src/types.ts` | `PlanBlueprint` / `PlanBlueprintFile` (plan mode) and `DocBlueprint` / `DocBlueprintSection` (doc mode) — the compact blueprint contracts the brain model submits. Plan-mode `approach` entries are TAD strings; doc-mode sections reach the writer model as JSON. |
| `src/tad.ts` | TAD parsing and hydration: exports `TadStep`, `TadLineRange`, `TadOperation`, `TAD_LINE_RE` (validation regex), `TAD_LINE_SHAPE` (human-readable format), `parseTadLine()` (parses one line, throws on error), and `hydrateTadStep()` (resolves line-ranges from disk and formats with line numbers). One parse error in any approach step causes `expandBlueprintToMarkdown` to bail with a user-facing diagnostic. |
| `src/config.ts` | Flag registration/reading, plan-mode detection (`isPlanModeActive` / `isPlanModeBranch` over the session branch), plan-file resolution (`planFileTarget` / `pendingPlanEntry`) and doc-draft resolution (`pendingDocEntry`), per-project writer-model persistence (`readPersistedScribeConfig` / `writePersistedScribeConfig`), the footer renderer (`formatScribeStatus`), and the five process-wide singletons: `pendingMarkdownStore()`, `pendingDocMarkdownStore()`, `armedDocSessions()`, `docDraftHistory()`, `consumedWriteSwaps()`. |
| `src/writer-session.ts` | `expandBlueprintToMarkdown()` (parses TAD lines, hydrates each file-range from disk in parallel, builds the labelled brief via `buildPlanPromptText()`), `expandDocBlueprintToMarkdown()` (sends `{title, sections}` as-is), and the shared `runWriterExpansion()` that spawns the tools-free writer session, sends the prompt, and streams back Markdown. |
| `src/index.ts` | Extension factory (default export `scribe(pi)`): tool registration for both blueprint tools, `/savings`, `/scribe-doc`, and `/scribe-model` registration, footer-status wiring, and the `before_agent_start` / `tool_call` / `session_start` / `session_shutdown` / `message_end` handlers. |
| `src/stats-store.ts` | Persisted savings stats: `SavingsRunLogEntry` (with `mode: "plan" \| "doc"` and `baselineIsEstimate`), `SavingsStatsFile` (with `totalPlanRuns` / `totalDocRuns` / `totalEstimatedBaselineRuns`), atomic file write, and the `/savings` dashboard renderer. |
| `src/pricing.ts` | `computeCosts()` for the brain vs. baseline comparison: both sides carry the brain's own turn cost, so that shared exploration cost cancels out of the difference, and the baseline additionally charges the writer's real output token count at the brain model's output rate — falling back to the `@plan`-role reference model's rates (brain input tokens + writer output tokens) when the live brain model has no catalog output rate, in which case those runs report `baselineIsEstimate: true` and render with a `~$` marker. |
| `dist/` | Compiled output loaded by oh-my-pi; generated by `npm run build`, not hand-edited. |

## More documentation

- `AGENTS.md` — repository guidelines, conventions, and manual QA checklist.
- `ARCHITECTURE.md` — full module-by-module breakdown and data-flow diagram.
- `BUILD_ANALYSIS.md` — build configuration, dependency strategy, and troubleshooting.
- `PATTERNS.md` — async/error-handling/type-safety code patterns used throughout `src/`.
