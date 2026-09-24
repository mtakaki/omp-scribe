# Repository Guidelines

**omp-scribe** is a TypeScript-based oh-my-pi extension that reduces plan-mode token costs by splitting expensive-model planning from cheap-model Markdown expansion.

---

## Project Overview

### Purpose

During oh-my-pi's plan mode, the expensive (high-quality) model traditionally authores the entire plan-document Markdown body (~2000–5000 tokens). This extension reduces that token cost by having the expensive model submit only a **compact blueprint** — JSON metadata plus **Scribe IR** (a `files` table of positional `[id, path, reason]` tuples and a `steps` array of `[fileId, operation, range, intent, preserve, doNot]` tuples, ~500 bytes), whose referenced file line-ranges the extension hydrates from disk — then delegating Markdown expansion to a **cheap model** (e.g., `@smol` role) via a private nested session.

The extension transparently swaps the cheap-model output before the native `write` tool executes, so the expensive model never emits the plan body itself. Refinements after the first draft never re-emit it either: the expensive model submits a small delta through `propose_plan_update`, the cheap model rewrites only the sections that delta names, and `src/plan-sections.ts` splices those sections into the plan file already on disk, leaving every section the update did not name byte-identical. All other plan-mode mechanics (approval UI, file destination, native workflow) remain unchanged.

### Key Mechanism

1. **On plan-mode turn**: Extension activates `propose_plan_blueprint` and `propose_plan_update` together and injects the `<scribe>` directive.
2. **Expensive model**: Calls `propose_plan_blueprint` with compact JSON metadata plus the Scribe IR `files`/`steps` tuples; calls `write` with placeholder `"pending"`.
3. **Tool handler**: Validates and resolves that IR, hydrates each step's referenced line range from disk, then spawns a nested cheap-model session to expand the resulting plain-text brief into Markdown; caches result under the blueprint slug.
4. **Write interception**: Extension intercepts the `write` call, swaps placeholder for cached Markdown, then native write tool executes.
5. **Refinement**: For a later change the expensive model calls `propose_plan_update` with only the fields that changed (plus optional `drop` headings) and `write`s the placeholder again; the cheap model rewrites just those sections against the plan text read from disk or the newest pending draft, and the extension splices them in.
6. **Result**: Expensive model token footprint drops from ~2500 tokens to ~7 bytes (the placeholder) per plan write, and to a compact delta JSON per refinement.

---

## Architecture & Data Flow

### Core Modules

| Module | Purpose | Key Exports | Lines |
|--------|---------|-------------|-------|
| `src/types.ts` | Compact blueprint shapes shared between expensive and cheap models | `ScribeFile`, `ScribeStep`, `PlanBlueprint`, `PlanUpdateBlueprint`, `DocBlueprint`, `DocBlueprintSection` | 91 |
| `src/scribe-ir.ts` | Scribe IR validation, file-id resolution, and line-range hydration from disk | `validateScribeBlueprint()`, `resolveScribeSteps()`, `hydrateScribeStep()`, `ScribeIrBlueprint`, `HydratedScribeStep` | 200 |
| `src/plan-sections.ts` | Pure plan-document section surgery: split, splice replacements, drop sections | `PLAN_SECTIONS`, `CANONICAL_PLAN_SECTIONS`, `splitPlanSections()`, `splicePlanSections()`, `planHeadingKey()`, `scanPlanHeadings()` | 181 |
| `src/config.ts` | Flags, plan-mode detection, plan-file resolution, `local://` artifact resolution, oh-my-pi contracts, persisted per-project writer-model config, footer-status formatter, process-wide draft stores | `isPlanModeActive()`, `isPlanModeBranch()`, `planFileTarget()`, `pendingPlanEntry()`, `resolveLocalArtifactPath()`, `readScribeConfig()`, `registerScribeFlags()`, `readPersistedScribeConfig()`, `writePersistedScribeConfig()`, `formatScribeStatus()`, `pendingMarkdownStore()`, `PendingBlueprint` | 471 |
| `src/writer-session.ts` | Nested session spawning; cheap-model expansion engine; Scribe IR hydration; plan-section rewrites | `expandBlueprintToMarkdown()`, `expandPlanUpdateToMarkdown()`, `expandDocBlueprintToMarkdown()`, `buildPlanPromptText()`, `buildPlanUpdatePromptText()`, `planUpdateHeadings()`, `planUpdateDrops()`, `deltaSupplies()`, `ExpandResult` type, `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, `DOC_WRITER_SYSTEM_PROMPT` | 448 |
| `src/index.ts` | Extension factory; lifecycle events, tool registration, footer-status wiring, state management, write-content swap | Default export `scribe(pi: ExtensionAPI)` | 902 |

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
    ├─ Calls propose_plan_blueprint with compact metadata plus files/steps Scribe IR
    │    ↓
    │    Tool execute handler
    │    ├─ Spawn private AgentRegistry + tools-free nested session
    │    ├─ validateScribeBlueprint() then resolveScribeSteps()
    │    ├─ Hydrate each resolved step in parallel with hydrateScribeStep() (reads project-relative file, extracts line range)
    │    ├─ Build labeled plain-text brief with buildPlanPromptText()
    │    ├─ Send prompt text to cheap writer model via session.prompt()
    │    ├─ Collect expanded Markdown via session.subscribe()
    │    ├─ Store in pendingMarkdownStore()[slug] as PendingBlueprint { sessionKey, markdown, … }
    │    └─ Return success message
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
    │    ├─ planUpdateHeadings()/planUpdateDrops() → the sections to rewrite and the ones to delete
    │    ├─ Resolve the current plan text: the newest pending draft, else readPlanArtifact()
    │    │    (resolveLocalArtifactPath() → <artifactsDir>/local/<slug>-plan.md, then PLAN.md)
    │    ├─ Reject a delta with no changes, or steps arriving without their files
    │    ├─ expandPlanUpdateToMarkdown(): validate + hydrate the delta's steps, then brief the writer
    │    │    with each requested section's current text plus the delta (buildPlanUpdatePromptText)
    │    ├─ Require the writer to return every requested heading, else fail leaving the store empty
    │    ├─ splicePlanSections(currentText, replacements, drops) → unnamed sections keep their exact bytes
    │    ├─ Store in pendingMarkdownStore()[slug] with deltaDocOutputTokens
    │    └─ Return the same call-write-with-pending instruction
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
| Blueprint tool execute | Footer gains the draft: `● plan — <n> chars drafted (writer: <provider/id>)`, or `✗ … expansion failed — <reason>` |
| Update tool execute | Same draft footer; a drop-only delta needs no writer session and records the `scribe/splice` identity with zero writer tokens |
| `tool_call` (write to a plan file with a pending draft) | Content swapped; store entry deleted; footer returns to its mode-only state |
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
│   ├── stats-store.ts        # Savings JSON read/append + /savings dashboard
│   ├── pricing.ts            # Dual-model cost math + @plan-role baseline fallback
│   └── types.ts              # Core domain types (PlanBlueprint, PlanUpdateBlueprint, DocBlueprint)
├── tests/                    # bun test suites + fakes (tests/support/)
├── dist/                     # Compiled ES2022 output (generated by npm run build)
│   ├── index.js              # Entry point for oh-my-pi extension loader
│   ├── config.js
│   ├── writer-session.js
│   ├── scribe-ir.js
│   ├── plan-sections.js
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

### Expansion Engine
- **`src/writer-session.ts`** — Nested session spawning, plan-mode Scribe IR hydration plus plain-text brief assembly, plan-section rewrites, and doc-mode JSON expansion. Only place where `sdk.createAgentSession()` is called. If writer-model behavior needs tuning, edit `WRITER_SYSTEM_PROMPT` / `PLAN_UPDATE_WRITER_SYSTEM_PROMPT` / `DOC_WRITER_SYSTEM_PROMPT` here.

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
- **No CLI flags required**: Extension self-registers flags (`--scribe-brain-model`, `--scribe-writer-model`) via `registerScribeFlags()`

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
   - both `propose_plan_blueprint` and `propose_plan_update` are offered and the blueprint tool accepts a compact payload with Scribe IR `files`/`steps` tuples
   - the footer then reads `Scribe ● plan — <n> chars drafted (writer: <provider/id>)`, reverting to the mode-only line after the `write` swap
   - the `write` call with placeholder `"pending"` succeeds and the plan file contains the full expanded Markdown
   - `savings_stats.json` under `<cwd>/.claude/plans/` gains a `mode: "plan"` run whose `docOutputTokens` measures the whole document
3. **Delegated plan update**: in that same plan-mode turn, copy the plan file aside and ask for a refinement (e.g. "record one extra constraint: …"). Expect `propose_plan_update` followed by `write` with content `"pending"`, and no hand-written plan Markdown.
   Verify:
   - the tool result names the rewritten headings and the plan file under the session's `local://` root contains the newly rendered section under its own `##` heading, with the literal placeholder never written
   - `diff` against the copy shows every section the update did not name is byte-identical (only the rewritten section changed)
   - `savings_stats.json` gains a second `mode: "plan"` run whose `docOutputTokens` matches roughly the regenerated sections' token estimate, not the whole document (the `/savings` "Delegated doc tokens (est.)" row excludes the unchanged sections)
   - the footer shows the plan draft line after the update, then reverts to the mode-only line after the swap
   - failure paths: calling `propose_plan_update` before any plan file exists reports a locate failure telling the model to call `propose_plan_blueprint` first, and a `write` with content `"pending"` after a failed update is still blocked with the existing no-drafted-Markdown reason
4. **Inert check**: in a directory with no plan state, a normal turn must not activate the plan tools nor inject the `<scribe>` directive.
5. **Writer-model configuration**: run `/scribe-model` (the picker must list authenticated models), `/scribe-model <provider/id>`, and `/scribe-model reset`. Verify the footer updates immediately in each case, `.claude/plans/scribe_config.json` gains or loses its `writerModel` key, an unresolvable spec leaves both untouched, and a *new* session in that project starts on the persisted model. In a non-UI session (`omp -p`), `/scribe-model` must report the current model instead of blocking on a picker.

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
- ✅ Scribe IR validation, resolution & hydration (`validateScribeBlueprint` rejection of malformed file/step tuples, unknown file ids, invalid operations, inverted ranges, empty strings — with the step requirement optional for the delta path; `hydrateScribeStep` resolving project-relative paths, reading files, extracting line ranges, 200-line cap, missing-file/outside-root notes; test suite in `tests/scribe-ir.test.ts`)
- ✅ Plan-section splice engine (`tests/plan-sections.test.ts`: replacement in place leaves other sections byte-identical, a missing heading inserts at its canonical position, an unknown heading appends, drops remove the named section, fenced code blocks are ignored, and an update naming nothing returns the input unchanged)
- ✅ Delegated plan updates (tool registration and plan-mode-only activation, delta shape rejection for no-changes and steps-without-files, IR validation errors surfaced without storing a draft, `local://` artifact resolution from the artifacts dir and the temp-root fallback, locate failures, empty plan files, a writer response missing a requested heading rejected with the plan left untouched, drop-only deltas applied without a writer session, sequential updates building on the pending draft, the write swap finalizing the spliced plan, `deltaDocOutputTokens` pricing only the regenerated sections, and update failures incrementing the blueprint failure counters)
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

Plan-mode step encoding is the positional-tuple IR described by `ScribeFile`/`ScribeStep` in `src/types.ts` and validated by `validateScribeBlueprint()` in `src/scribe-ir.ts` (the tool boundary's Zod schema can only assert fixed-length arrays of unknowns, so the per-position semantics live there). Any change to the tuple shape must update these in lock-step:

1. **Update `ScribeFile`/`ScribeStep`** in `src/types.ts` (and `PlanUpdateBlueprint` if the delta's field set changes).
2. **Update `validateScribeBlueprint()`** in `src/scribe-ir.ts` — the tuple-length checks, per-position checks, and error messages — plus `resolveScribeSteps()` if the resolution changes.
3. **Update the Zod schemas** for `propose_plan_blueprint`/`propose_plan_update` in `src/index.ts` so the boundary enforces the new tuple lengths and field set.
4. **Update the `<scribe>` directive** in `src/index.ts` to teach the model the new shape, including the delta path's once-per-refinement rule.
5. **Update `WRITER_SYSTEM_PROMPT`, `PLAN_UPDATE_WRITER_SYSTEM_PROMPT`, and `buildPlanPromptText()`/`buildPlanUpdatePromptText()`** in `src/writer-session.ts` to decode the new shape correctly.
6. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Maintaining the Plan-Section Contract

Delegated updates depend on the plan-document structure the initial expansion emits:

1. **Section names and order** live in `PLAN_SECTIONS` (`src/plan-sections.ts`), from which `CANONICAL_PLAN_SECTIONS` is derived; keep them in step with the section headings `WRITER_SYSTEM_PROMPT` fixes. A heading level change requires updating `SECTION_HEADING_RE` too.
2. **The writer's section contract** — one `## <heading>` per requested section, spelled as the brief spells it — is enforced by the update tool, which rejects a response missing any requested heading rather than splicing nothing.
3. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Updating oh-my-pi Contracts

If oh-my-pi changes its plan-mode internals:

1. **If the mode-entry contract changes** (entry type or `mode` vocabulary): update `PLAN_MODE_CONTEXT_CUSTOM_TYPE` / `PLAN_MODE_EXITED_CUSTOM_TYPES` and the `mode_change` check in `isPlanModeBranch()` in `config.ts`.
2. **If plan-file naming changes** (charset or suffix): update `PLAN_FILE_PATH_RE` in `config.ts` (line 22) and the `planFileTarget()` slug rule.
3. **If the `local://` root layout changes** (artifacts-dir child name, temp-dir fallback, or session-id sanitising): update `resolveLocalArtifactPath()` and its `LOCAL_ROOT_DIR_NAME`/`safeSessionId` helpers in `config.ts`, which mirror the host's `resolveLocalRoot` without importing it. Verified against omp 18.2.11: `local://<name>` lives at `<session-dir>/local/<name>`, surfaced to extensions as `ctx.localProtocolOptions.getArtifactsDir()`.
4. **If the plan tools' names or options change**: keep `PLAN_MODE_TOOL_NAMES`/`SCRIBE_TOOL_NAMES` in `index.ts` in step with the registered tool names, since activation, brain-usage accumulation, and failure counting all key off them.
5. **If `ExtensionAPI` interface changes**: Update type imports in `src/*.ts` (header comments); recompile and test.
6. **If tool lifecycle events change**: Update event handler signatures in `index.ts`.

Rebuild after any contract changes: `npm run build && npm run typecheck && bun test`

