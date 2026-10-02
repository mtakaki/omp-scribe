# Repository Guidelines

**omp-scribe** is a TypeScript-based oh-my-pi extension that reduces plan-mode token costs by splitting expensive-model planning from cheap-model Markdown expansion.

---

## Project Overview

### Purpose

During oh-my-pi's plan mode, the expensive (high-quality) model traditionally authores the entire plan-document Markdown body (~2000–5000 tokens). This extension reduces that token cost by having the expensive model submit only a **compact blueprint** — JSON metadata plus **Scribe IR** (a `files` table of positional `[id, path, reason]` tuples and a `steps` array of `[fileId, operation, range, intent, preserve, doNot]` tuples, ~500 bytes), whose referenced file line-ranges the extension hydrates from disk — then delegating Markdown expansion to a **cheap model** (e.g., `@smol` role) via a private nested session.

The extension transparently swaps the cheap-model output before the native `write` tool executes, so the expensive model never emits the plan body itself. Refinements after the first draft never re-emit it either: the expensive model submits a small delta through `propose_plan_update`, the cheap model rewrites only the sections that delta names, and `src/plan-sections.ts` splices those sections into the plan file already on disk, leaving every section the update did not name byte-identical. All other plan-mode mechanics (approval UI, file destination, native workflow) remain unchanged.

### Key Mechanism

1. **On plan-mode turn**: Extension activates `propose_plan_blueprint` and `propose_plan_update` together and injects the `<scribe>` directive.
2. **Expensive model**: Calls `propose_plan_blueprint` with compact JSON metadata plus the Scribe IR `files`/`steps` tuples and a **`literals` table** of `[id, value]` tuples, writing an `[[<id>]]` marker wherever a declared value belongs instead of typing the value; calls `write` with placeholder `"pending"`.
3. **Tool handler**: Validates and resolves that IR, validates the literal table (`validateLiteralTable()`/`validateLiteralUsage()`), hydrates each step's referenced line range from disk (200 lines, or 40 for a step that names no range and only adds), then spawns a nested cheap-model session to expand the resulting plain-text brief into Markdown; substitutes every declared `[[<id>]]` marker deterministically (`resolveLiteralPlaceholders()`) and only then gates every load-bearing literal the brief supplies, asking the writer to re-emit any section that lost one (bounded rounds) — a declared literal is restored by re-placing its marker, and only a literal the repair pass could not restore is reported; caches result under the blueprint slug.
4. **Write interception**: Extension intercepts the `write` call, swaps placeholder for cached Markdown, then native write tool executes.
5. **Refinement**: For a later change the expensive model calls `propose_plan_update` with only the fields that changed (plus optional `drop` headings and an optional `literals` table) and `write`s the placeholder again; the cheap model rewrites just those sections against the plan text read from disk or the newest pending draft, the same deterministic marker substitution plus declared-literal check runs on the sections it rewrote, and the extension splices them in.
6. **Doc mode**: `propose_doc_blueprint` takes the same optional `literals` table and its JSON payload carries it; the doc draft runs through the same deterministic substitution and declared-literal gate as the plan paths.
7. **Result**: Expensive model token footprint drops from ~2500 tokens to ~7 bytes (the placeholder) per plan write, and to a compact delta JSON per refinement.

---

## Architecture & Data Flow

### Core Modules

| Module | Purpose | Key Exports | Lines |
|--------|---------|-------------|-------|
| `src/types.ts` | Compact blueprint shapes shared between expensive and cheap models | `ScribeLiteral`, `ScribeFile`, `ScribeStep`, `PlanBlueprint`, `PlanUpdateBlueprint`, `DocBlueprint`, `DocBlueprintSection` | 104 |
| `src/scribe-ir.ts` | Scribe IR validation, file-id resolution, and line-range hydration from disk, recording whether each step's read found its file | `validateScribeBlueprint()`, `resolveScribeSteps()`, `hydrateScribeStep()`, `ScribeIrBlueprint`, `HydratedScribeStep`, `ScribeFileState` | 220 |
|`src/plan-sections.ts`|Pure plan-document section surgery: split, splice replacements, drop sections|`PLAN_SECTIONS`, `CANONICAL_PLAN_SECTIONS`, `splitPlanSections()`, `splicePlanSections()`, `planHeadingKey()`, `scanPlanHeadings()`|181|
|`src/literal-fidelity.ts`|Literal table plus literal-fidelity gate: owns the declared `[id, value]` table, its marker grammar, validation, and deterministic `[[id]]` substitution, and extracts/strips/reports the load-bearing literals a brief supplies, renders the repair brief and its system prompt|`mergeLiterals()`, `literalMarkers()`, `referencedLiterals()`, `formatLiteralTable()`, `resolveLiteralPlaceholders()`, `validateLiteralTable()`, `validateLiteralUsage()`, `extractLiterals()`, `normalizeForMatch()`, `findMissingLiterals()`, `checkFidelity()`, `buildRepairPromptText()`, `literalDumpLines()`, `removeLiteralDumpLines()`, `MAX_LITERAL_VALUE_LENGTH`, `LITERAL_ID_RE`, `PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT`, `FidelityTarget`, `RepairTarget`, `FidelityGap`, `FidelityReport`, `LiteralRunMetrics`, `PlaceholderResolution`|562|
|`src/token-accounting.ts`|Real-tokenizer accounting: resolves the host's native `countTokens` for a model's encoding and reports per-part writer-input counts, with an explicitly inexact estimate as the only fallback|`resolveTokenCounter()`, `tokenBreakdown()`, `accountWriterTokens()`, `encodingForModel()`, `estimateTextTokens()`, `TokenCounter`, `TokenBreakdown`, `TokenAccounting`, `DEFAULT_TOKEN_ENCODING`|150|
|`src/config.ts`|Flags, plan-mode detection, plan-file resolution, `local://` artifact resolution, oh-my-pi contracts, persisted per-project writer-model config, footer-status formatter, process-wide draft stores (whose `PendingBlueprint` carries the draft's `literalMetrics` and `tokenAccounting` to the write swap)|`isPlanModeActive()`, `isPlanModeBranch()`, `planFileTarget()`, `pendingPlanEntry()`, `resolveLocalArtifactPath()`, `readScribeConfig()`, `registerScribeFlags()`, `readPersistedScribeConfig()`, `writePersistedScribeConfig()`, `formatScribeStatus()`, `pendingMarkdownStore()`, `PendingBlueprint`|489|
|`src/writer-session.ts`|Nested session spawning; cheap-model expansion engine; Scribe IR hydration; plan-section rewrites; the truthful `lines` label a step's own hydration state decides (`(new file)` only when the read found no file, else `(no range given)` for an unranged step); the deterministic-then-repair literal gate (markers substituted from the literal table, then every gap absent from the whole plan repaired — a declared one by re-placing its marker) that plan mode, plan updates, and now doc mode all run their draft through|`expandBlueprintToMarkdown()`, `expandPlanUpdateToMarkdown()`, `expandDocBlueprintToMarkdown()`, `buildPlanPromptText()`, `buildPlanUpdatePromptText()`, `planUpdateHeadings()`, `planUpdateDrops()`, `planUpdateRemovals()`, `deltaSupplies()`, `enforceLiteralFidelity()`, `docFidelityTargets()`, `ExpandSuccess`, `ExpandResult` type, `MAX_FIDELITY_REPAIR_ROUNDS`, `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, `DOC_WRITER_SYSTEM_PROMPT`|892|
|`src/index.ts`|Extension factory; lifecycle events, tool registration, footer-status wiring, state management, write-content swap, literal-fidelity reporting; teaches the literal table through the `<scribe>` directive and the optional `literals` tool parameter, and surfaces the per-run `literalMetrics` in each tool's details|Default export `scribe(pi: ExtensionAPI)`|1022|

### Data Flow

```
Plan-mode turn starts
    ↓
before_agent_start event fires
    ├─ Detect plan mode (isPlanModeActive → newest mode entry in session branch)
    ├─ Activate propose_plan_blueprint + propose_plan_update
    └─ Inject SCRIBE_DIRECTIVE
        ↓
Expensive model reads system prompt
    ├─ Calls propose_plan_blueprint with compact metadata plus files/steps Scribe IR and a literals [id, value] table
    │    ↓
    │    Tool execute handler
    │    ├─ Spawn private AgentRegistry + tools-free nested session
    │    ├─ validateScribeBlueprint() then resolveScribeSteps(); validateLiteralTable()/validateLiteralUsage() on the literals table before any file is read
    │    ├─ Hydrate each resolved step in parallel with hydrateScribeStep() (reads project-relative file, extracts line range: 200 lines, or MAX_UNRANGED_SNIPPET_LINES = 40 for a step that names no range and only adds, and records whether the read found the file (`fileState`) so the brief prints `lines: (new file)` only for an absent file)
    │    ├─ Build labeled plain-text brief with buildPlanPromptText(), which renders the LITERALS block from formatLiteralTable()
    │    ├─ Send prompt text to cheap writer model via session.prompt()
    │    ├─ Collect expanded Markdown via session.subscribe()
    │    ├─ enforceLiteralFidelity(): resolveLiteralPlaceholders() substitutes every declared [[id]] marker first, then planFidelityTargets() → checkFidelity() gates the rest; every gap absent from the whole plan is repaired, each round briefs the writer with buildRepairPromptText() and splices the repaired sections in place (≤ MAX_FIDELITY_REPAIR_ROUNDS rounds, usage/cost accumulated), and the writer's own text — literal-only lines included — is what reaches the plan
    │    ├─ Attach the FidelityReport (checked / missing / missingSections), LiteralRunMetrics (resolved / unresolved / repair spend), and — measured with the host's native tokenizer — the writer input's TokenAccounting (system / brief / snippet / total) to the expansion
    │    ├─ Store in pendingMarkdownStore()[slug] as PendingBlueprint { sessionKey, markdown, … }
    │    └─ Return success message plus the fidelity line (verified count, or the unverified literals with a pointer at propose_plan_update)
    │
    ├─ Calls write with path=local://<slug>-plan.md, content="pending"
    │    ↓
    │    tool_call event fires
    │    ├─ Resolve the target via planFileTarget(path)
    │    ├─ Look up the draft via pendingPlanEntry(store, sessionKey, target)
    │    ├─ Found! Swap content with expanded Markdown
    │    └─ Return modified input to native write tool
    │
    ├─ write tool executes with full Markdown body
    │    ├─ Expensive model never saw the full Markdown
    │    └─ File written complete
    │
    ├─ Refinement: calls propose_plan_update with only the fields that changed
    │    ↓
    │    Tool execute handler
    │    ├─ planUpdateHeadings()/planUpdateDrops()/planUpdateRemovals() → the sections to rewrite, the ones named for deletion, and the ones actually removed (a heading the delta also supplies is regenerated, not removed)
    │    ├─ Resolve the current plan text: the newest pending draft, else readPlanArtifact()
    │    │    (resolveLocalArtifactPath() → <artifactsDir>/local/<slug>-plan.md, then PLAN.md)
    │    ├─ Reject a delta with no changes, or steps arriving without their files
    │    ├─ expandPlanUpdateToMarkdown(): validate + hydrate the delta's steps, then brief the writer
    │    │    with each requested section's current text plus the delta (buildPlanUpdatePromptText)
    │    ├─ enforceLiteralFidelity() over the delta's own literals: its declared markers resolve deterministically and the rest are gated, so a section that lost one is repaired before the caller parses headings
    │    ├─ Require the writer to return every requested heading, else fail leaving the store empty
    │    ├─ splicePlanSections(currentText, replacements, removals) → unnamed sections keep their exact bytes
    │    ├─ Store in pendingMarkdownStore()[slug] with deltaDocOutputTokens
    │    └─ Return the same call-write-with-pending instruction
    │
    ├─ Doc mode: propose_doc_blueprint carries the same literals table in its JSON payload, and the doc draft runs the same resolveLiteralPlaceholders() → enforceLiteralFidelity() gate (docFidelityTargets())
    │
    └─ Writes the placeholder again → tool_call swaps the spliced document (same path as above)
        ↓
    Continue to xd://propose (native approval flow)
```

### State Management

**Process-wide singleton store** (`pendingMarkdownStore()` in `config.ts`):
- **`pendingMarkdownStore(): Map<string, PendingBlueprint>`** — Keyed by `slug` → `PendingBlueprint { sessionKey, markdown, writerModel, writerUsage, writerCostUsd, irOutputTokens, deltaDocOutputTokens? }`. Lives on `globalThis` under a namespaced key so all factory invocations share exactly one store, preventing cache misses across hot-reloads or duplicate module imports. `deltaDocOutputTokens` is set only by `propose_plan_update` (the estimated tokens of the sections it regenerated, so incremental updates are priced against the delta rather than the whole document); the write swap falls back to measuring `markdown` when it is absent.

**Persisted per-project config** (`.claude/plans/scribe_config.json`, `config.ts`):
- **`readPersistedScribeConfig(cwd)` / `writePersistedScribeConfig(cwd, patch)`** — The `/scribe-model` override lives here (`{ writerModel: "provider/id" }`). Writes are atomic (temp sibling + `rename`) and read failures self-heal to `{}`; a patch field set to `undefined` deletes the key.

**Closure-captured state** (in `index.ts` factory function):
- **`cfg: ScribeConfig`** — Mutable; refreshed on `session_start` from `readScribeConfig(pi, ctx.cwd)`, whose `writerModel` precedence is non-default CLI flag → persisted override → `@smol`. Updated in place by `/scribe-model`.
- **`lastKnownModels: Model[]`** — `ctx.models.list()` snapshot from `session_start`; feeds the `/scribe-model` picker and its argument completions.
- **`sessionKey(ctx)`** — Computes unique session identifier (fallback `"default"`); stored as a field in each `PendingBlueprint` for session-scoped cleanup.

**Lifecycle**:

| Event | Action |
|-------|--------|
| Load-time | `registerScribeFlags()` called; tools registered (inactive) |
| `session_start` | `cfg = await readScribeConfig(pi, ctx.cwd)`; model list captured; footer set to idle/doc-armed/plan |
| `before_agent_start` (plan branch) | Plan tools (`propose_plan_blueprint`, `propose_plan_update`) activated together; `<scribe>` directive injected; footer set to `● plan` |
| `before_agent_start` (non-plan branch) | Plan tools deactivated; no directive; footer set to idle/doc-armed |
|Blueprint tool execute|Footer gains the draft: `● plan — <n> chars drafted (writer: <provider/id>)`, or `✗ … expansion failed — <reason>`. `details` carries `fidelity`, `literalMetrics` (deterministic `resolved` count, `unresolved` markers, and the repair rounds/tokens), and the real-tokenizer `tokenAccounting`, and the result text carries the literal-fidelity line: the verified literal count, the substitutions made from the table, or the unverified literals with a pointer at `propose_plan_update` (and any section the draft never emitted). With `--scribe-token-report`, one `writer input … tokens (system …, brief …, snippet …)` line is logged; the result text never changes with the flag|
| Update tool execute | Same draft footer; a drop-only delta needs no writer session and records the `scribe/splice` identity with zero writer tokens (and zeroed `literalMetrics`). The result carries the same literal-fidelity line for the sections the delta rewrote |
| `tool_call` (write to a plan file with a pending draft) | Content swapped; store entry deleted; footer returns to its mode-only state. The savings entry records `literalResolved`, `llmRepairCalls`, and the repair input/output tokens from the draft's `literalMetrics` |
| Doc tool execute | Same draft footer for the doc file; the result carries `details.fidelity` and the same literal-fidelity line, computed after the deterministic substitution |
| `session_shutdown` | Store entries whose `sessionKey` matches current session deleted; footer cleared |
| `/scribe-model` | Resolves and persists the chosen writer model (or clears it on `reset`), then refreshes the footer |

All footer writes go through `ctx.ui.setStatus("scribe", …)` and are skipped when `ctx.hasUI` is false.

---

## Key Directories

```
.
├── src/
│   ├── index.ts              # Extension factory; events, tool registration, state
│   ├── config.ts             # Flags, plan-mode detection, plan-file/artifact resolution
│   ├── writer-session.ts     # Nested session spawning; expansion and section-rewrite logic
│   ├── scribe-ir.ts          # Scribe IR validation, resolution, and line-range hydration
│   ├── plan-sections.ts      # Pure plan-document section split/splice engine
│   ├── literal-fidelity.ts   # Pure literal extraction, gap check, and repair brief
│   ├── token-accounting.ts   # Native-tokenizer counts of the writer input
│   ├── stats-store.ts        # Savings JSON read/append + /savings dashboard
│   ├── pricing.ts            # Dual-model cost math + @plan-role baseline fallback
│   └── types.ts              # Core domain types (PlanBlueprint, PlanUpdateBlueprint, DocBlueprint)
├── tests/                    # bun test suites + fakes (tests/support/)
├── fixtures/token-economics/ # Checked-in fixture plan + sources for `npm run measure`
├── scripts/                  # measure-tokens.ts (the token harness)
├── dist/                     # Compiled ES2022 output (generated by npm run build)
│   ├── index.js              # Entry point for oh-my-pi extension loader
│   ├── config.js
│   ├── writer-session.js
│   ├── scribe-ir.js
│   ├── plan-sections.js
│   ├── literal-fidelity.js
│   ├── token-accounting.js
│   └── types.js
├── package.json              # Manifest; declares devDependencies, build scripts, omp config
├── tsconfig.json             # TypeScript compiler settings (ES2022, ESNext, strict)
└── AGENTS.md                 # This file
```

**Source files**: Write-time targets for edits. All `.ts` files are in `src/`.

**Compiled output**: Runtime targets. The `dist/` directory is auto-generated by `npm run build` and should not be edited by hand.

**Build integration**: `package.json` declares `"omp": { "extensions": ["./dist/index.js"] }`, pointing oh-my-pi to the compiled entry point.

---

## Development Commands

### Build

```bash
npm run build
# Invokes: tsc -p tsconfig.json
# Compiles src/**/*.ts → dist/**/*.js
# Output: ES2022 ESNext modules (~69 KB total, zero runtime dependencies)
```

**When to run**: After edits to `src/` files. Build must succeed before loading extension into oh-my-pi.

### Typecheck (without emitting)

```bash
npm run typecheck
# Invokes: tsc -p tsconfig.json --noEmit
# Validates TypeScript; does not write dist/*.js
# Exit codes: 0 = pass, non-zero = type errors
```

**When to run**: In CI/pre-commit hooks, before `npm run build`, to catch type errors early.

### Measure tokens

```bash
npm run measure
# Invokes: bun scripts/measure-tokens.ts
# Hydrates fixtures/token-economics/plan.json through the real hydration path
# and prints, with the host's native tokenizer, the cost of the tuple payload,
# a prose rendering, the compact DSL, the writer system prompt, the brief, the
# hydrated snippets, the expanded plan body, and the writer input total — per
# encoding — plus the planner surface (the directive, the three tool schemas,
# and the writer system prompts). `bun run measure --examples` prints the
# fixture's expanded plan body and tuple JSON verbatim with their counts.
```

**When to run**: After editing a prompt, a tool description, the `<scribe>` directive, or the snippet caps — and before believing any claim about the pipeline's token cost. It exits non-zero when the writer input is not at least 35% below the recorded pre-change 6021-token baseline, when the tuple IR costs more than 1.15x a prose rendering of the same plan, or when no exact native tokenizer resolves (this harness never prints estimates as measurements).

### Install Dependencies

```bash
npm install
# Installs devDependencies: @oh-my-pi/pi-coding-agent@18.1.6, typescript@^5.7.0
# Generates package-lock.json (lock file for reproducible builds)
# Required once after cloning, or after changing package.json
```

### No Runtime Dependencies

The extension has **zero production dependencies**. All oh-my-pi API access is injected at runtime; type-only imports use `import type` syntax and are erased by the compiler.

---

## Code Conventions & Common Patterns

### Async Patterns

**Promise-based event subscriptions** (writer-session.ts, lines 87–107):
```typescript
await new Promise<void>((resolve, reject) => {
  const unsubscribe = activeSession.subscribe(evt => {
    if (evt.type === "message_update" && evt.assistantMessageEvent.type === "text_delta") {
      markdown += evt.assistantMessageEvent.delta;  // Accumulate across events
      return;
    }
    if (evt.type === "agent_end" && evt.isTerminal !== false) {
      unsubscribe();  // Cleanup immediately
      resolve();      // Signal completion
    }
  });
  activeSession.prompt(promptText).catch(reject);
});
```

**Pattern**: Convert callback-based event streaming into awaitable async by capturing a closed-over variable and resolving on terminal event.

**Try-finally for resource cleanup** (writer-session.ts, lines 65–117):
```typescript
let session: AgentSession | undefined;
try {
  const created = await sdk.createAgentSession({ /* ... */ });
  session = created.session;
  // ... work ...
  return { markdown };
} catch (error) {
  return { error: error instanceof Error ? error.message : String(error) };
} finally {
  if (session) await session.dispose();  // Always cleanup
}
```

**Pattern**: Pre-declare resource outside try; store in finally-accessible variable; unconditionally dispose in finally block, protecting against early returns and exceptions.

**Event handler async signatures** (index.ts, lines 33–42, 103–126, 128–151):
- All event handlers are `async` for consistency, even if not strictly required.
- Awaited API calls (`.setActiveTools()`, `.prompt()`) ensure sequential consistency.
- Early returns are valid; omitting early return means "no modification for this event."

### Error Handling

**Discriminated union return type** (writer-session.ts, line 25):
```typescript
export type ExpandResult = { markdown: string } | { error: string };
```

**Pattern**: Errors returned as part of return value, not thrown. Caller must handle both discriminants:
```typescript
const result = await expandBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
if ("error" in result) {
  return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
}
// result.markdown is narrowed to string here
```

**Tool error responses** (index.ts, lines 82–86):
```typescript
if ("error" in result) {
  return {
    content: [{ type: "text", text: `Blueprint expansion failed: ${result.error}` }],
    isError: true,  // Model sees this and can retry
  };
}
```

**Blocking tool responses** (index.ts, lines 141–145):
```typescript
if (input.content.trim() === PLACEHOLDER_CONTENT) {
  return {
    block: true,
    reason: `No drafted Markdown found for slug "${slug}". Call ${BLUEPRINT_TOOL_NAME} first.`,
  };
}
```

**Pattern**: Prevent invalid state (placeholder without expansion) from reaching disk; explain exactly what the model did wrong.

### Type Safety

- **Strict mode**: `tsconfig.json` enables all strict options. All types must be explicit; no `any`.
- **Type guards**: `"error" in result` narrows discriminated unions; `instanceof Error` checks exception types.
- **Type-only imports**: All oh-my-pi API types use `import type` syntax, erased at compile-time.
- **Zod validation**: Tool parameters validated by Zod schema at registration; input type inferred as `PlanBlueprint`.

### Naming Conventions

| Category | Style | Examples |
|----------|-------|----------|
| **Constants** | SCREAMING_SNAKE_CASE | `BLUEPRINT_TOOL_NAME`, `PLACEHOLDER_CONTENT`, `PLAN_FILE_PATH_RE` |
| **Functions** | camelCase | `isPlanModeActive()`, `expandBlueprintToMarkdown()`, `sessionKey()` |
| **Types/Interfaces** | PascalCase | `PlanBlueprint`, `ScribeConfig`, `ExpandResult` |
| **Variables** | camelCase | `cfg`, `pendingMarkdown`, `markdown`, `blueprint` |

### Configuration Pattern

```typescript
// Flag registration (load-time, safe)
export function registerScribeFlags(pi: ExtensionAPI): void {
  pi.registerFlag("scribe-brain-model", { type: "string", ... });
  pi.registerFlag("scribe-writer-model", { type: "string", default: "@smol" });
}

// Flag reading (session_start, idempotent)
export function readScribeConfig(pi: ExtensionAPI): ScribeConfig {
  const brain = pi.getFlag("scribe-brain-model");
  const writer = pi.getFlag("scribe-writer-model");
  return { brainModel: brain ? brain.trim() : undefined, writerModel: writer?.trim() ?? "@smol" };
}
```

**Pattern**: Register flags first (load-time safe); read on every `session_start` to pick up CLI changes.

### Dependency Injection

The extension receives oh-my-pi API as a parameter, not imported:

```typescript
export default function scribe(pi: ExtensionAPI): void {
  // 'pi' injected by host
  pi.registerFlag(...)
  pi.registerTool(...)
  pi.on("session_start", () => {
    const cfg = readScribeConfig(pi);
  });
  
  // Access SDK via pi.pi (shared host state)
  const sdk = pi.pi;
  const agentRegistry = new sdk.AgentRegistry();
  await sdk.createAgentSession({ ... });
}
```

**Pattern**: Never import `@oh-my-pi/pi-coding-agent` at runtime (type-only imports only). Always use injected `pi` parameter and `pi.pi` namespace for SDK access. This ensures the nested session shares the host's singleton `AgentRegistry` and `local://` resolver state.

### oh-my-pi Contract Points

Three hardcoded assumptions about oh-my-pi's internals (documented in `config.ts`):

1. **Plan-mode state**: the host persists every mode transition as a `mode_change` session entry (`SessionManager.appendModeChange`, read back by the host's own `#reconcileModeFromSession` in `modes/interactive-mode.ts`), so `isPlanModeBranch()` scans `ctx.sessionManager.getBranch()` backwards and lets the newest `mode_change` decide (`"plan"` = active; `"plan_paused"`/`"none"`/`"goal"`/`"vibe"` = inactive). The plan brief itself arrives as a hidden custom message with `customType: "plan-mode-context"` — **never** in `BeforeAgentStartEvent.systemPrompt` — and the `--plan-yolo` flow arms plan mode without a `mode_change`, which is why `"plan-mode-context"` (on) and `"plan-yolo-handoff"` (off) are accepted as a fallback. **Maintenance**: if the host renames these entry types, update the constants at the top of `config.ts`.

2. **Plan-file paths**: plan files are the session-local `local://*plan.md` artifacts `listPlanFiles()` enumerates, including the default `local://PLAN.md` and the canonical `local://<slug>-plan.md`; the stem charset (letters, numbers, underscores, hyphens) mirrors `normalizePlanTitle()` in `src/plan-mode/approved-plan.ts`. **Maintenance**: if that charset changes, update `PLAN_FILE_PATH_RE` in `config.ts` (line 22).

3. **`message_end` is a detached snapshot**: mutating `event.message.content` there cannot reach the user or the provider, so no feature may swap assistant text from that handler.

---

## Important Files

### Entry Point
- **`dist/index.js`** — Compiled entry point loaded by oh-my-pi. Exports default function `scribe(pi)`. All event handlers, tool registration, and state management defined here.

### Configuration & Detection
- **`src/config.ts`** — Flag registration, plan-mode detection (`isPlanModeActive()`/`isPlanModeBranch()`), plan-file resolution (`planFileTarget()`, `pendingPlanEntry()`) and doc-draft resolution (`pendingDocEntry()`), `local://` artifact lookups for the update path (`resolveLocalArtifactPath()`), per-project writer-model persistence (`readPersistedScribeConfig()`/`writePersistedScribeConfig()`), the footer renderer (`formatScribeStatus()`), and the process-wide pending-draft singletons (`pendingMarkdownStore()`, `pendingDocMarkdownStore()`, `armedDocSessions()`, `docDraftHistory()`, `consumedWriteSwaps()`). Update the mode-entry, plan-file, and `local://`-root constants here if oh-my-pi's internals change.

### Plan Sections
- **`src/plan-sections.ts`** — Pure text engine for delegated plan updates: `splitPlanSections()` (fence-aware `##` splitter whose chunks concatenate back to the input byte-for-byte), `splicePlanSections()` (replace in place, insert at the canonical position, append unknown headings, delete dropped ones, and keep every unnamed section verbatim), plus `PLAN_SECTIONS`/`CANONICAL_PLAN_SECTIONS`. It reads no files and imports no host APIs. Update `PLAN_SECTIONS` if the plan-document section names or order change; if the heading level changes, update the section regex too.

### Literal Fidelity
- **`src/literal-fidelity.ts`** — Pure text engine for the fidelity gate: `extractLiterals()` mines the load-bearing literals out of brief text, `findMissingLiterals()`/`checkFidelity()` report which ones a draft lost and which target sections it never emitted, and `buildRepairPromptText()` plus `PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT` render the repair brief. It reads no files and imports no host APIs. Tune the extraction patterns and the shape filters here when a real draft loses a literal the extractor never collected.

### Expansion Engine
- **`src/writer-session.ts`** — Nested session spawning, plan-mode Scribe IR hydration plus plain-text brief assembly, plan-section rewrites, doc-mode JSON expansion, and the literal-fidelity gate (`enforceLiteralFidelity()`, `MAX_FIDELITY_REPAIR_ROUNDS`, `fidelitySources()`) that both plan paths run their draft through. Only place where `sdk.createAgentSession()` is called. If writer-model behavior needs tuning, edit `WRITER_SYSTEM_PROMPT` / `PLAN_UPDATE_WRITER_SYSTEM_PROMPT` / `DOC_WRITER_SYSTEM_PROMPT` here.

### Type Definitions
- **`src/types.ts`** — Core domain types. Plan-mode steps are positional tuples validated by `src/scribe-ir.ts`; `PlanUpdateBlueprint` is the incremental delta `propose_plan_update` accepts; the doc-mode outline is shared between expensive and cheap models via JSON serialization.

### Build Configuration
- **`package.json`** — Manifest; defines devDependencies, build scripts, `"omp.extensions"` config pointing to `dist/index.js`.
- **`tsconfig.json`** — TypeScript settings: ES2022 target, ESNext modules, strict mode, `src/` root, `dist/` output.

---

## Runtime & Tooling Preferences

### Node.js & Package Manager

- **Minimum Node.js**: 16.x (ES2022 and ESNext modules supported)
- **Bun**: Supported for faster builds and execution
- **Package manager**: npm (uses `package-lock.json` for reproducible installs)

### Module System

- **ESM (ECMAScript Modules)** — `package.json` declares `"type": "module"`
- **TypeScript target**: ES2022 (compiles to modern JavaScript)
- **Module resolution**: `"Bundler"` (supports both relative and bare imports)
- **Compiled format**: ESNext module syntax (`import`/`export`)

### oh-my-pi Integration

- **Minimum oh-my-pi version**: 18.1.6 (uses `ExtensionAPI` from this version)
- **Extension loader**: oh-my-pi reads `package.json` → `"omp.extensions"` array → dynamically imports each module → calls default export with `ExtensionAPI`
- **No CLI flags required**: Extension self-registers flags (`--scribe-brain-model`, `--scribe-writer-model`, `--scribe-token-report`) via `registerScribeFlags()`

### Zero Dependencies at Runtime

- No `node_modules/` packages imported at runtime
- All oh-my-pi API types are `import type` only (compile-time erased)
- Nested sessions access oh-my-pi SDK via injected `pi.pi` namespace, not direct imports
- This ensures the nested writer session shares the host's `AgentRegistry` singleton (critical for `local://` resource sharing)

---

## Testing & QA

### Test Framework

**Unit/integration suite**: `bun test` (files under `tests/`, fakes in `tests/support/`). It covers detection, tool registration and execution, the write swap, delegated plan updates, the plan-section splice engine, doc mode, stats, pricing, writer-model resolution/persistence, and footer-status transitions. Run `npm run typecheck` first — it type-checks `src/` and `tests/`.

**Manual verification of the live flow** (the suite cannot model the host's plan mode):

1. **Compilation check**: `npm run build` must succeed with zero errors.
2. **Interactive plan-mode run**: plain `omp` in a scratch directory, then `/plan`, then a plan request. Detection reads the session branch, so plan mode must be entered *before* the prompt; `omp --plan-yolo -p "..."` only becomes detectable on the second turn, because `--plan-yolo` arms plan mode in-session without persisting a `mode_change` entry.
   Verify:
   - the footer reads `Scribe ○ idle (writer: …)` at session start and `Scribe ● plan (writer: …)` once plan mode is on
   - both `propose_plan_blueprint` and `propose_plan_update` are offered and the blueprint tool accepts a compact payload with Scribe IR `files`/`steps` tuples plus an optional `literals` table of `[id, value]` tuples
   - a blueprint whose `literals` table declares a value used as an `[[<id>]]` marker yields the deterministic-substitution sentence in the tool result, the plan file carries the substituted value with no `[[` marker left, and `details.literalMetrics.resolved` counts the substitutions
   - the `propose_plan_blueprint` result text ends with the literal-fidelity line — `all <n> load-bearing literals the brief supplies are verified verbatim in the draft`, or the unverified literals in backticks with a pointer at `propose_plan_update` — and the transcript shows no plan-file `Read` and no `propose_plan_update` call between that result and the `write`
   - the footer then reads `Scribe ● plan — <n> chars drafted (writer: <provider/id>)`, reverting to the mode-only line after the `write` swap
   - the `write` call with placeholder `"pending"` succeeds and the plan file contains the full expanded Markdown
   - `savings_stats.json` under `<cwd>/.claude/plans/` gains a `mode: "plan"` run whose `docOutputTokens` measures the whole document, and `/savings` shows `Literals resolved (deterministic)` above zero with `LLM literal-repair calls` at zero for a fully declared draft
3. **Delegated plan update**: in that same plan-mode turn, copy the plan file aside and ask for a refinement (e.g. "record one extra constraint: …"). Expect `propose_plan_update` followed by `write` with content `"pending"`, and no hand-written plan Markdown.
   Verify:
   - the tool result names the rewritten headings and the plan file under the session's `local://` root contains the newly rendered section under its own `##` heading, with the literal placeholder never written
   - `diff` against the copy shows every section the update did not name is byte-identical (only the rewritten section changed)
   - `savings_stats.json` gains a second `mode: "plan"` run whose `docOutputTokens` matches roughly the regenerated sections' token estimate, not the whole document (the `/savings` "Delegated doc tokens (est.)" row excludes the unchanged sections)
   - the footer shows the plan draft line after the update, then reverts to the mode-only line after the swap
   - failure paths: calling `propose_plan_update` before any plan file exists reports a locate failure telling the model to call `propose_plan_blueprint` first, and a `write` with content `"pending"` after a failed update is still blocked with the existing no-drafted-Markdown reason
4. **Inert check**: in a directory with no plan state, a normal turn must not activate the plan tools nor inject the `<scribe>` directive.
5. **Token report**: run a plan turn with `--scribe-token-report`. Verify the `propose_plan_blueprint` result details carry `tokenAccounting` with `system` + `brief` = `total` and one `writer input … tokens (system … brief … snippet …)` line in the log. `exact: true` (with an `encoding`) holds when the native tokenizer resolves — true under `bun`, false inside a bun-compiled host binary, which reports `encoding: null, exact: false` and a `(approximate: no native tokenizer)` log suffix instead. Without the flag the result text must be byte-identical and no such line may be logged.
6. **Writer-model configuration**: run `/scribe-model` (the picker must list authenticated models), `/scribe-model <provider/id>`, and `/scribe-model reset`. Verify the footer updates immediately in each case, `.claude/plans/scribe_config.json` gains or loses its `writerModel` key, an unresolvable spec leaves both untouched, and a *new* session in that project starts on the persisted model. In a non-UI session (`omp -p`), `/scribe-model` must report the current model instead of blocking on a picker.

This `-e`/`--extension` invocation is session-scoped: it will not register the extension as an installed package, so it never appears in the interactive `/extensions` (Extension Control Center) UI. To confirm `/extensions` visibility, run `npm run link:local` (`omp plugin link .`) once, then open a plain `omp` session (no `-e` needed) and check `/extensions` → `OMP Extension Packages` for `omp-scribe`.

6. **Transcript inspection**: After a plan-mode session, inspect the transcript (stored in `~/.omp/agent/sessions/`) to confirm the `propose_plan_blueprint` call carried compact metadata plus Scribe IR tuples rather than Markdown prose, and that any refinement used `propose_plan_update` with only the changed fields. Note that in omp 18.2.6 a `tool_call` revision is applied before the call is persisted, so the recorded `write` arguments show the swapped Markdown, and the `tool_result` annotation ("The <n>-character draft from <model> replaced the content you submitted") plus the savings stats entry are the direct evidence that the swap ran.

### Coverage Expectations

- ✅ Plan-mode detection (`mode_change`/`plan-mode-context` in the session branch; `plan_paused` and non-plan modes are inactive)
- ✅ Tool activation/deactivation (both plan tools active only in plan turns, neither on a doc-armed or idle turn)
- ✅ Blueprint expansion (the cheap model expands the Scribe IR brief, hydrated from disk, into Markdown successfully)
- ✅ Cache management (expanded Markdown cached in the process-wide singleton store, keyed by slug; deleted after use)
- ✅ Write-content swap (placeholder swapped for the expanded Markdown before the write executes; `local://PLAN.md` resolves through the session's only draft)
- ✅ Error cases (expansion failure, empty response, unmatched placeholder on a plan-file path, wrong path)
- ✅ Fallback modes (model bypasses the blueprint tool and writes real Markdown; no interference)
- ✅ Scribe IR validation, resolution & hydration (`validateScribeBlueprint` rejection of malformed file/step tuples, unknown file ids, invalid operations, inverted ranges, empty strings — with the step requirement optional for the delta path; `hydrateScribeStep` resolving project-relative paths, reading files, extracting line ranges, the 200-line cap for ranged and unranged modify/delete steps, the 40-line cap for an unranged add step, missing-file/outside-root notes; test suite in `tests/scribe-ir.test.ts`)
- ✅ Plan-section splice engine (`tests/plan-sections.test.ts`: replacement in place leaves other sections byte-identical, a missing heading inserts at its canonical position, an unknown heading appends, drops remove the named section, fenced code blocks are ignored, and an update naming nothing returns the input unchanged)
- ✅ Literal fidelity (`tests/literal-fidelity.test.ts`: extraction order across backticked spans, quoted identifiers, SCREAMING_SNAKE constants, `local://` references, template fragments, dotted calls, and project-relative paths; rejection of prose, a bare number, a two-character span, and a word-internal apostrophe; whitespace-normalized matching including re-wrapped and backtick-stripped text; gap reporting that keeps an absent section out of `missing` while still counting what it checked; repair-brief assembly. `tests/writer-session.test.ts` covers the repair pass end to end: the lossy draft is repaired with only the flagged section spliced, usage and cost accumulate onto the initial expansion, an unfixable gap is reported with the draft intact, a compliant draft spends no session, and an update-path delta triggers the same repair. `tests/index.test.ts` covers the tool result: `verified verbatim` plus `details.fidelity` for a compliant draft, and for a lossy one the unverified literal in backticks with a pointer at `propose_plan_update`, leaving the un-repaired draft in the pending store)
- ✅ Literal table engine (`tests/literal-fidelity.test.ts`: `resolveLiteralPlaceholders()` resolves a known marker to its exact value and counts each occurrence once, leaves an unknown id and a malformed span byte-identical while recording the trimmed body once in `unresolved`, resolves a repeated marker at every occurrence, round-trips a multi-line and a longer-than-200-character value, and never rescans a substituted value; `referencedLiterals()`/`literalMarkers()` reading order and case-folding; `formatLiteralTable()` rendering the header plus one `[[<id>]] = <json>` line per entry and nothing for an empty table; the five exact `validateLiteralTable()` errors and `validateLiteralUsage()`'s unreferenced-id throw; `mergeLiterals()`; and `literalDumpLines()` recognizing a line that is nothing but markers)
- ✅ Declared-literal preservation (`tests/writer-session.test.ts`: a draft emitting every declared `[[<id>]]` marker substitutes the exact values, with `literalMetrics.resolved` matching the marker count, an empty `fidelity.missing`, and no repair session; a draft that paraphrases a declared literal or omits its marker is repaired in one round with two sessions, the exact substituted value landing in the returned Markdown, and a repair that drops the marker again is reported as residue in `fidelity.missing`; a duplicated marker substitutes both occurrences; a reworded Context paragraph that keeps its marker still passes; and a doc blueprint whose bullets carry a marker resolves it)
- ✅ Tool-boundary literal reporting (`tests/index.test.ts`: `propose_plan_blueprint` with a declared table returns `verified verbatim` with an empty `details.fidelity.missing`, the pending store holds markdown with the exact substituted value and no `[[`, `details.literalMetrics.resolved` is greater than zero, and the write swap records a savings run with `literalResolved` greater than zero and `llmRepairCalls === 0`)
- ✅ Savings dashboard literal rows (`tests/stats-store.test.ts`: `Literals resolved (deterministic)`, `LLM literal-repair calls`, and `LLM repair tokens (in+out)` read the accumulated `totalLiteralResolved`/`totalLlmRepairCalls`/summed repair tokens after an `appendSavingsRun()` carrying the new entry fields, and 0 for a zeroed ledger)
- ✅ Delegated plan updates (tool registration and plan-mode-only activation, delta shape rejection for no-changes and steps-without-files, IR validation errors surfaced without storing a draft, `local://` artifact resolution from the artifacts dir and the temp-root fallback, locate failures, empty plan files, a writer response missing a requested heading rejected with the plan left untouched, drop-only deltas applied without a writer session, sequential updates building on the pending draft, the write swap finalizing the spliced plan, `deltaDocOutputTokens` pricing only the regenerated sections, and update failures incrementing the blueprint failure counters)
- ✅ Token budgets and writer accounting (`tests/token-economics.test.ts` captures the injected `<scribe>` directive and the registered tool schemas and asserts, with the real tokenizer in the fixture's encoding, that the directive, each tool schema (description plus every parameter name and `describe`), and all three writer system prompts stay under their ceilings; that the directive still carries `propose_plan_blueprint`, `propose_plan_update`, `[[<id>]]`, `pending`, and `xd://propose`; that every tuple position, operation char, id pattern, and the 8000-char bound survives; that the plan headings and the renderer rule are verbatim; and that the fixture's tuple JSON is at most 1.15x a prose rendering of the same plan — every assertion skipping with a stated reason when no native tokenizer resolves. `tests/index.test.ts` covers the accounting itself: the blueprint result's `details.tokenAccounting` and draft entry carry exact system/brief/snippet/total counts, one `writer input …` line is logged with `--scribe-token-report` and none without it, and the result text is unchanged when the flag is off. `scripts/measure-tokens.ts` is the harness behind those numbers)
- ✅ Baseline pricing (`@plan`-role fallback: an unpriced brain model prices its baseline from the reference model's rates with `baselineIsEstimate` tracking and `~$` dashboard marking; an unresolvable role keeps the legacy $0.00 lower bound)
- ✅ Writer-model precedence (non-default CLI flag → persisted override → `@smol`) and persistence (round-trip, ENOENT/malformed/wrong-type self-heal, key removal on reset)
- ✅ Footer status (`idle`/`doc armed`/`plan`/`doc`/draft/`failed` strings, per-turn recomputation, draft revert after the swap, clear on shutdown, nothing written without UI)
- ✅ `/scribe-model` (registration and completions, direct spec, picker + cancel, `reset`, unresolvable spec leaves file and footer untouched, override reloaded on the next session start)

### Code Quality

- **Linting**: None (project preference: rely on TypeScript strict mode for safety)
- **Formatting**: Code is hand-formatted; no auto-formatter configured
- **Pre-commit hooks**: None (run `npm run typecheck` manually before committing)

### Build Verification

Always run before committing or deploying:
```bash
npm run typecheck  # Catch type errors
npm run build      # Compile to dist/
# Inspect dist/ for presence of dist/index.js (entry point)
```

---

## Maintenance Notes

### Adding a New Event Handler

1. Decide if the handler modifies extension state or just observes.
2. Add `pi.on("event_name", async (event, ctx) => { ... })` to the factory function.
3. If modifying plan-draft state, use the process-wide singleton store (`pendingMarkdownStore()`) from `config.ts`; for other per-session state, use closure-captured variables.
4. Return early if this extension doesn't apply (e.g., `if (event.toolName !== "write") return`).
5. Rebuild: `npm run build`

### Adding a New Flag

1. Call `pi.registerFlag(name, { type, description, default })` in `registerScribeFlags()`.
2. Add a field to `ScribeConfig` interface.
3. Read the flag in `readScribeConfig(pi, cwd)` (async; `cwd` is what lets a persisted per-project override beat the flag's default) and return it in the config object.
4. Access in event handlers via closure-captured `cfg` variable (e.g., `cfg.writerModel`).
5. Rebuild: `npm run build`

### Maintaining the Scribe IR Wire Format

Plan-mode step encoding is the positional-tuple IR described by `ScribeFile`/`ScribeStep` in `src/types.ts` and validated by `validateScribeBlueprint()` in `src/scribe-ir.ts` (the tool boundary's Zod schema can only assert fixed-length arrays of unknowns, so the per-position semantics live there). The `literals` table (`[id, value]` tuples typed as `ScribeLiteral`, optional on all three blueprint types) rides alongside that tuple IR and is validated separately by `validateLiteralTable()`/`validateLiteralUsage()` — see *Maintaining the Literal Table*. Any change to the tuple shape must update these in lock-step:

1. **Update `ScribeFile`/`ScribeStep`** in `src/types.ts` (and `PlanUpdateBlueprint` if the delta's field set changes).
2. **Update `validateScribeBlueprint()`** in `src/scribe-ir.ts` — the tuple-length checks, per-position checks, and error messages — plus `resolveScribeSteps()` if the resolution changes.
3. **Update the Zod schemas** for `propose_plan_blueprint`/`propose_plan_update` in `src/index.ts` so the boundary enforces the new tuple lengths and field set (and carries the optional `literals` parameter each tool already takes).
4. **Update the `<scribe>` directive** in `src/index.ts` to teach the model the new shape, including the delta path's once-per-refinement rule.
5. **Update `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, and `buildPlanPromptText()`/`buildPlanUpdatePromptText()`** in `src/writer-session.ts` to decode the new shape correctly.
6. **Keep the tuple IR and the literal table independent**: `literals` stays optional on every blueprint type so a planner that declares none keeps the extraction-and-repair fallback, and it is validated by the literal validators rather than by `validateScribeBlueprint()`.
7. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Maintaining the Plan-Section Contract

Delegated updates depend on the plan-document structure the initial expansion emits:

1. **Section names and order** live in `PLAN_SECTIONS` (`src/plan-sections.ts`), from which `CANONICAL_PLAN_SECTIONS` is derived; keep them in step with the section headings `WRITER_SYSTEM_PROMPT` fixes. A heading level change requires updating `SECTION_HEADING_RE` too.
2. **The writer's section contract** — one `## <heading>` per requested section, spelled as the brief spells it — is enforced by the update tool, which rejects a response missing any requested heading rather than splicing nothing.
3. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Maintaining the Literal Table

The literal table is what lets the writer avoid typing a load-bearing string at all: the planner declares each exact value once in `literals` (the `[id, value]` tuples typed as `ScribeLiteral` in `src/types.ts`), writes an `[[<id>]]` marker where the value belongs, and the extension substitutes the value after the response. Keep the declaration, validation, substitution, and prompts coherent across the boundaries below.

1. **Declaration grammar** lives in `src/literal-fidelity.ts`: an id matches `LITERAL_ID_RE` (`[A-Za-z][A-Za-z0-9_-]{0,15}`, unique case-insensitively) and a value is a non-empty string of at most `MAX_LITERAL_VALUE_LENGTH` (8000) characters. Widen a bound only by changing the constant, and keep the id grammar the `<scribe>` directive and the tool schemas quote in step.
2. **Validate the table at every tool boundary**: `validateLiteralTable()` for the shape and id/value rules, `validateLiteralUsage()` for the every-declared-id-is-referenced-by-a-marker rule, called on `blueprint.literals`/`delta.literals` before any file is read (`blueprintLiteralTexts()`, `deltaLiteralTexts()`, and `docLiteralTexts()` in `src/writer-session.ts` supply the prose the usage check scans). Both throw with the offending index and value, matching `validateScribeBlueprint()`'s message style; never downgrade them to a silent drop or a case-sensitive id comparison.
3. **Substitution is single-pass**: `resolveLiteralPlaceholders()` replaces every marker whose body is a declared id, matched case-insensitively, through `String.prototype.replace` with a function callback, so a substituted value that itself contains marker syntax is never rescanned. An unknown or malformed span stays byte-identical and is recorded once in `unresolved`.
4. **`mergeLiterals()` is the de-duplicator**: it keeps the first occurrence under `normalizeForMatch()` and drops any later value an earlier kept one already contains, which is what lets a declared literal win over the same string `extractLiterals()` mined from the brief; `extractLiterals()` itself ends in `mergeLiterals(...)`.
5. **A declared literal is repaired by re-placing its marker, never by retyping its value**: `repairableGaps()` in `src/writer-session.ts` keeps every literal absent from the whole gate haystack — declared ones included — so the repair brief prints `[[<id>]] = <json value>` and `resolveLiteralPlaceholders()` substitutes the exact value afterwards. A literal the repair pass cannot restore, or one that already survives elsewhere in the plan, is reported in `fidelity.missing` (the caller re-records the gap with `propose_plan_update`). `LiteralRunMetrics` keeps the deterministic `resolved` count separate from the repair rounds and tokens.
6. **`FidelitySource.extractInline`** decides whether a source's text may also contribute inline-extracted literals beyond its declared markers; it is true for every source except a delta's `context` (`deltaFidelityTargets()` sets it `false`), because a refinement's Context paragraph may be reworded while its declared markers must still appear. `docFidelityTargets()` is the doc path's counterpart — `expandDocBlueprintToMarkdown()` runs the same substitution and gate.
7. **Prompts move in lockstep**: the marker contract — emit the marker verbatim, never type the value it stands for, never invent an unlisted marker, emit every supplied marker where its value belongs, never put a marker or a literal on a line by itself — must stay in step across `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, `DOC_WRITER_SYSTEM_PROMPT`, and `PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT` in `src/writer-session.ts`, plus the `<scribe>` directive and both plan tools' `steps` description (`STEP_LITERAL_REQUIREMENT`) in `src/index.ts`.
8. **Render the wire form in one place**: `formatLiteralTable()` is the only code that emits the `LITERALS` block and its `[[<id>]] = <json value>` line form, consumed by `buildPlanPromptText()`, `buildPlanUpdatePromptText()`, and `buildRepairPromptText()`. `buildRepairPromptText()` takes the table as its required fourth parameter, so a missing literal a table entry declares prints as `- [[<id>]] = <json value>` and a missing one no entry declares keeps the legacy backticked form.
9. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Maintaining the Literal-Fidelity Gate

The gate is deliberately conservative: a literal it never extracts is simply not verified, which costs one lost guarantee, whereas a false positive costs a repair session on every plan. Widen it only when a real draft loses a literal the extractor never collected. Since the literal table landed, `resolveLiteralPlaceholders()` runs first and this extraction gate covers the literals no declared table entry carries, re-placing a declared marker the writer dropped — a declared literal is never retyped by an LLM, and one the repair pass cannot restore is reported in `fidelity.missing` — while a planner that declares no `literals` keeps exactly this gate as before.

1. **Extraction rules** live in `src/literal-fidelity.ts`: the per-shape patterns, `MIN_LITERAL_LENGTH`/`MAX_LITERAL_LENGTH`, and `isLiteralShaped()`'s whitespace, bare-number, and fragment-edge rejections. `extractLiterals()` keeps candidates in reading order and ends in `mergeLiterals(...)`, so a declared literal wins over the same string mined from the brief and a candidate containing a `[[...]]` marker is rejected (a marker references a table entry, it is never itself a literal). The gate is string-only — backticked, quoted, constant, `local://`, template, dotted-call, and path shapes — so prose, a bare number, and a two-character span all yield nothing. `FRAGMENT_EDGE_RE` rejects a candidate a split left dangling — one opening with `)`, `]`, `}`, `;`, or `,`, or ending with `(`, `[`, `{`, or `,` — and a backticked span that is exactly one quoted string yields the text inside its quotes, so `` (target `"artistas"`) `` extracts `artistas`.
2. **What gets gated** is `fidelitySources()` in `src/writer-session.ts`: the canonical headings paired with the brief text that supplies each. A step is mined from its own lines only, never from the hydrated `source:` snippet — that snippet is code the writer reads for grounding, not a literal it must echo. `planFidelityTargets()` builds the blueprint path's targets and `deltaFidelityTargets()` the delta path's, where the `context` source sets `extractInline: false` because a refinement's Context paragraph is folded into the section's existing prose rather than reproduced — so only its declared markers are required there. `docFidelityTargets()` builds the doc path's targets.
3. **A literal list never satisfies the gate**: `literalDumpLines()`/`removeLiteralDumpLines()` flag a bullet, list item, or bare line whose whole content is backticked literals or `[[id]]` markers, so `enforceLiteralFidelity` strips them from the haystack it compares — the writer's own line still reaches the plan — and refuses a repair response whose section carries one. The helpers are line-based and fence-blind, and deliberately separator-agnostic (`LINE_MARKER_RE`, `BACKTICK_SPAN_RE`, `SEPARATOR_RE`) — widen `SEPARATOR_RE` when a real dump line reduces to something else.
4. **Repair budget and loop bound**: `MAX_FIDELITY_REPAIR_ROUNDS` (`src/writer-session.ts`). Setting it to `0` degrades the gate to report-only with no other code change. A round that leaves the document byte-identical ends the loop early, and `enforceLiteralFidelity` notifies once after the loop — a residue warning while literals are still missing, else an info that the repair restored them — instead of warning before it.
5. **Prompts move in lockstep**: a new literal shape needs its rule in `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, `DOC_WRITER_SYSTEM_PROMPT`, `PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT`, the `<scribe>` directive's `intent` bullet, and both plan tools' `steps` description (`STEP_LITERAL_REQUIREMENT` in `index.ts`). `buildRepairPromptText()` now takes the literal table as its required fourth parameter, so a missing literal a table entry declares prints as `- [[<id>]] = <json value>` (the marker to re-emit) while a missing one no entry declares keeps the legacy backticked form.
6. **Section presence is reported, never repaired**: a target heading the draft never emitted lands in `missingSections`, because inserting a section the caller never asked for would change the plan and the update path already owns the unrendered-heading rejection.
7. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Maintaining the Token Budgets

Every token the planner pays before it drafts — the `<scribe>` directive, the three tool schemas, and the writer system prompts — is ceilinged, and the ceilings are enforced with the host's real tokenizer rather than a character estimate. The pipeline's cost is a feature, so it gets a regression test.

1. **The numbers come from `npm run measure`** (`scripts/measure-tokens.ts`), which hydrates `fixtures/token-economics/plan.json` through the real path — `resolveScribeSteps` → `hydrateScribeStep` → `buildPlanPromptText`, via `tests/support/token-fixture.ts` — and prints the tuple payload, a prose rendering, the compact DSL, the writer system prompt, the brief, the hydrated snippets, and the writer input total per encoding. Never quote a character estimate as a measurement; run the harness.
2. **The ceilings live in `tests/token-economics.test.ts`**: `DIRECTIVE_CEILING`, `TOOL_TEXT_BUDGETS`, and `WRITER_PROMPT_BUDGETS`, each recorded beside the pre-change count it is a fraction of. The tool-text extraction walks the omptype schema IR and counts parameter names plus every `desc`/`expected` string, so re-derive a baseline with the same extraction — `git show HEAD:src/index.ts` into a scratch module, register it against `createFakeExtensionApi`, and count.
3. **Budgets are ceilings, not pins**: a tokenizer upgrade may move a number. Grow one only by re-recording the baseline deliberately, never by loosening a ceiling to make a change pass.
4. **The fixture is data, not code**: `fixtures/` is outside both tsconfig `include` lists, and no fixture file may be named `*.test.ts`/`*.spec.ts` — `bun test` discovers by name anywhere in the tree. Keep `plan.json`'s literal ids referenced by markers, or `validateLiteralUsage()` rejects it.
5. **Encodings mirror the host**: `ENCODING_BY_TOKENIZER` in `src/token-accounting.ts` maps `Model.tokenizer` to the native `Encoding` member exactly as the host's own table does, defaulting to `O200kBase`. Keep them in step when the catalog gains a tokenizer family, and keep the module's import of `@oh-my-pi/pi-natives` dynamic (a variable specifier): the addon is optional per platform, and a static import would break extension load where it is missing. The same specifier makes the counter report `exact: false` inside a bun-compiled host binary, where the host's own copy of the package is inlined at build time and a bare specifier from an externally loaded extension cannot resolve — verified against omp 18.3.5, whose tool result then carries `tokenAccounting` with `encoding: null, exact: false` and logs the same. That is a diagnostic downgrade only: no expansion changes. `bun run measure` must run under the dev runtime (`bun`, devDependencies installed), where the addon resolves and the printed counts are exact.
6. **The snippet caps are the writer payload's main lever**: `MAX_SNIPPET_LINES` (200) bounds ranged and unranged modify/delete steps, `MAX_UNRANGED_SNIPPET_LINES` (40) bounds a step that names no range and only adds — the case where the snippet is background rather than the subject of the change. Both live in `src/scribe-ir.ts`; raise the unranged cap there if a live run shows the writer inventing content it should have matched.
7. Rebuild and test: `npm run typecheck && npm run build && bun test && bun run measure`.

### Updating oh-my-pi Contracts

If oh-my-pi changes its plan-mode internals:

1. **If the mode-entry contract changes** (entry type or `mode` vocabulary): update `PLAN_MODE_CONTEXT_CUSTOM_TYPE` / `PLAN_MODE_EXITED_CUSTOM_TYPES` and the `mode_change` check in `isPlanModeBranch()` in `config.ts`.
2. **If plan-file naming changes** (charset or suffix): update `PLAN_FILE_PATH_RE` in `config.ts` (line 22) and the `planFileTarget()` slug rule.
3. **If the `local://` root layout changes** (artifacts-dir child name, temp-dir fallback, or session-id sanitising): update `resolveLocalArtifactPath()` and its `LOCAL_ROOT_DIR_NAME`/`safeSessionId` helpers in `config.ts`, which mirror the host's `resolveLocalRoot` without importing it. Verified against omp 18.2.11: `local://<name>` lives at `<session-dir>/local/<name>`, surfaced to extensions as `ctx.localProtocolOptions.getArtifactsDir()`.
4. **If the plan tools' names or options change**: keep `PLAN_MODE_TOOL_NAMES`/`SCRIBE_TOOL_NAMES` in `index.ts` in step with the registered tool names, since activation, brain-usage accumulation, and failure counting all key off them.
5. **If `ExtensionAPI` interface changes**: Update type imports in `src/*.ts` (header comments); recompile and test.
6. **If tool lifecycle events change**: Update event handler signatures in `index.ts`.

Rebuild after any contract changes: `npm run build && npm run typecheck && bun test`

