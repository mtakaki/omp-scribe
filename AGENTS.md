# Repository Guidelines

**omp-scribe** is a TypeScript-based oh-my-pi extension that reduces plan-mode token costs by splitting expensive-model planning from cheap-model Markdown expansion.

---

## Project Overview

### Purpose

During oh-my-pi's plan mode, the expensive (high-quality) model traditionally authores the entire plan-document Markdown body (~2000–5000 tokens). This extension reduces that token cost by having the expensive model submit only a **compact blueprint** — JSON metadata plus dense Tokenized Architectural Diff (TAD) step lines (~500 bytes), whose referenced file line-ranges the extension hydrates from disk — then delegating Markdown expansion to a **cheap model** (e.g., `@smol` role) via a private nested session.

The extension transparently swaps the cheap-model output before the native `write` tool executes, so the expensive model never emits the plan body itself. All other plan-mode mechanics (approval UI, file destination, native workflow) remain unchanged.

### Key Mechanism

1. **On plan-mode turn**: Extension injects a `propose_plan_blueprint` tool and directive.
2. **Expensive model**: Calls `propose_plan_blueprint` with compact JSON metadata plus one TAD line per approach step; calls `write` with placeholder `"pending"`.
3. **Tool handler**: Parses each TAD line, hydrates its referenced line range from disk, then spawns a nested cheap-model session to expand the resulting plain-text brief into Markdown; caches result.
4. **Write interception**: Extension intercepts the `write` call, swaps placeholder for cached Markdown, then native write tool executes.
5. **Result**: Expensive model token footprint drops from ~2500 tokens to ~7 bytes (the placeholder).

---

## Architecture & Data Flow

### Core Modules

| Module | Purpose | Key Exports | Lines |
|--------|---------|-------------|-------|
| `src/types.ts` | Compact blueprint shape shared between expensive and cheap models | `PlanBlueprint`, `PlanBlueprintFile`, `DocBlueprint`, `DocBlueprintSection` | 42 |
| `src/tad.ts` | Tokenized Architectural Diff parsing and line-range hydration from disk | `TAD_LINE_RE`, `TAD_LINE_SHAPE`, `TadStep`, `parseTadLine()`, `hydrateTadStep()` | 151 |
| `src/config.ts` | Flags, plan-mode detection, plan-file resolution, oh-my-pi contracts, persisted per-project writer-model config, footer-status formatter, process-wide draft stores | `isPlanModeActive()`, `isPlanModeBranch()`, `planFileTarget()`, `pendingPlanEntry()`, `readScribeConfig()`, `registerScribeFlags()`, `readPersistedScribeConfig()`, `writePersistedScribeConfig()`, `formatScribeStatus()`, `pendingMarkdownStore()`, `PendingBlueprint` | 396 |
| `src/writer-session.ts` | Nested session spawning; cheap-model expansion engine; TAD step hydration | `expandBlueprintToMarkdown()`, `expandDocBlueprintToMarkdown()`, `buildPlanPromptText()`, `ExpandResult` type, `WRITER_SYSTEM_PROMPT`, `DOC_WRITER_SYSTEM_PROMPT` | 203 |
| `src/index.ts` | Extension factory; lifecycle events, tool registration, footer-status wiring, state management, write-content swap | Default export `scribe(pi: ExtensionAPI)` | 608 |

### Data Flow

```
Plan-mode turn starts
    ↓
before_agent_start event fires
    ├─ Detect plan mode (isPlanModeActive → last mode_change in session branch)
    ├─ Activate propose_plan_blueprint tool
    └─ Inject SCRIBE_DIRECTIVE
        ↓
Expensive model reads system prompt
    ├─ Calls propose_plan_blueprint with TAD-line array in approach field
    │    ↓
    │    Tool execute handler
    │    ├─ Spawn private AgentRegistry + tools-free nested session
    │    ├─ Parse each approach string with parseTadLine()
    │    ├─ Hydrate each TAD step in parallel with hydrateTadStep() (reads project-relative file, extracts line range)
    │    ├─ Build labeled plain-text prompt with buildPlanPromptText()
    │    ├─ Send prompt text to cheap writer model via session.prompt()
    │    ├─ Collect expanded Markdown via session.subscribe()
    │    ├─ Store in pendingMarkdownStore()[slug] as PendingBlueprint { sessionKey, markdown }
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
    └─ write tool executes with full Markdown body
        ├─ Expensive model never saw the full Markdown
        └─ File written complete
            ↓
    Continue to xd://propose (native approval flow)
```

### State Management

**Process-wide singleton store** (`pendingMarkdownStore()` in `config.ts`):
- **`pendingMarkdownStore(): Map<string, PendingBlueprint>`** — Keyed by `slug` → `PendingBlueprint { sessionKey, markdown }`. Lives on `globalThis` under a namespaced key so all factory invocations share exactly one store, preventing cache misses across hot-reloads or duplicate module imports.

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
| `before_agent_start` (plan branch) | Blueprint tool activated; `<scribe>` directive injected; footer set to `● plan` |
| `before_agent_start` (non-plan branch) | Blueprint tool deactivated; no directive; footer set to idle/doc-armed |
| Blueprint tool execute | Footer gains the draft: `● plan — <n> chars drafted (writer: <provider/id>)`, or `✗ … expansion failed — <reason>` |
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
│   ├── config.ts             # Flags, plan-mode detection, plan-file resolution
│   ├── writer-session.ts     # Nested session spawning; expansion logic
│   ├── tad.ts               # TAD parsing and line-range hydration engine
│   ├── stats-store.ts        # Savings JSON read/append + /savings dashboard
│   ├── pricing.ts            # Dual-model cost math + @plan-role baseline fallback
│   └── types.ts              # Core domain types (PlanBlueprint, DocBlueprint)
├── tests/                    # bun test suites + fakes (tests/support/)
├── dist/                     # Compiled ES2022 output (generated by npm run build)
│   ├── index.js              # Entry point for oh-my-pi extension loader
│   ├── config.js
│   ├── writer-session.js
│   ├── tad.js
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
- **`src/config.ts`** — Flag registration, plan-mode detection (`isPlanModeActive()`/`isPlanModeBranch()`), plan-file resolution (`planFileTarget()`, `pendingPlanEntry()`) and doc-draft resolution (`pendingDocEntry()`), per-project writer-model persistence (`readPersistedScribeConfig()`/`writePersistedScribeConfig()`), the footer renderer (`formatScribeStatus()`), and the process-wide pending-draft singletons (`pendingMarkdownStore()`, `pendingDocMarkdownStore()`, `armedDocSessions()`, `docDraftHistory()`, `consumedWriteSwaps()`). Update the mode-entry and plan-file constants here if oh-my-pi's plan-mode internals change.

### Expansion Engine
- **`src/writer-session.ts`** — Nested session spawning, plan-mode TAD hydration plus plain-text brief assembly, and doc-mode JSON expansion. Only place where `sdk.createAgentSession()` is called. If writer-model behavior needs tuning, edit `WRITER_SYSTEM_PROMPT` / `DOC_WRITER_SYSTEM_PROMPT` here.

### Type Definitions
- **`src/types.ts`** — Core domain types. Plan-mode steps are TAD line strings (`approach: string[]`, parsed in `src/tad.ts`); the doc-mode outline is still shared between expensive and cheap models via JSON serialization.

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

**Unit/integration suite**: `bun test` (files under `tests/`, fakes in `tests/support/`). It covers detection, tool registration and execution, the write swap, doc mode, stats, pricing, writer-model resolution/persistence, and footer-status transitions. Run `npm run typecheck` first — it type-checks `src/` and `tests/`.

**Manual verification of the live flow** (the suite cannot model the host's plan mode):

1. **Compilation check**: `npm run build` must succeed with zero errors.
2. **Interactive plan-mode run**: plain `omp` in a scratch directory, then `/plan`, then a plan request. Detection reads the session branch, so plan mode must be entered *before* the prompt; `omp --plan-yolo -p "..."` only becomes detectable on the second turn, because `--plan-yolo` arms plan mode in-session without persisting a `mode_change` entry.
   Verify:
   - the footer reads `Scribe ○ idle (writer: …)` at session start and `Scribe ● plan (writer: …)` once plan mode is on
   - `propose_plan_blueprint` is offered and accepts a compact payload with TAD-line approach steps
   - the footer then reads `Scribe ● plan — <n> chars drafted (writer: <provider/id>)`, reverting to the mode-only line after the `write` swap
   - the `write` call with placeholder `"pending"` succeeds and the plan file contains the full expanded Markdown
   - `savings_stats.json` under `<cwd>/.claude/plans/` gains a `mode: "plan"` run
3. **Inert check**: in a directory with no plan state, a normal turn must not activate the blueprint tool nor inject the `<scribe>` directive.
4. **Writer-model configuration**: run `/scribe-model` (the picker must list authenticated models), `/scribe-model <provider/id>`, and `/scribe-model reset`. Verify the footer updates immediately in each case, `.claude/plans/scribe_config.json` gains or loses its `writerModel` key, an unresolvable spec leaves both untouched, and a *new* session in that project starts on the persisted model. In a non-UI session (`omp -p`), `/scribe-model` must report the current model instead of blocking on a picker.

This `-e`/`--extension` invocation is session-scoped: it will not register the extension as an installed package, so it never appears in the interactive `/extensions` (Extension Control Center) UI. To confirm `/extensions` visibility, run `npm run link:local` (`omp plugin link .`) once, then open a plain `omp` session (no `-e` needed) and check `/extensions` → `OMP Extension Packages` for `omp-scribe`.

5. **Transcript inspection**: After a plan-mode session, inspect the transcript (stored in `~/.omp/agent/sessions/`) to confirm the `propose_plan_blueprint` call carried compact metadata plus TAD step lines rather than Markdown prose. Note that in omp 18.2.6 a `tool_call` revision is applied before the call is persisted, so the recorded `write` arguments show the swapped Markdown; the savings stats entry is the direct evidence that the swap ran.

### Coverage Expectations

- ✅ Plan-mode detection (`mode_change`/`plan-mode-context` in the session branch; `plan_paused` and non-plan modes are inactive)
- ✅ Tool activation/deactivation (blueprint tool active only in plan turns)
- ✅ Blueprint expansion (the cheap model expands the TAD-line brief, hydrated from disk, into Markdown successfully)
- ✅ Cache management (expanded Markdown cached in the process-wide singleton store, keyed by slug; deleted after use)
- ✅ Write-content swap (placeholder swapped for the expanded Markdown before the write executes; `local://PLAN.md` resolves through the session's only draft)
- ✅ Error cases (expansion failure, empty response, unmatched placeholder on a plan-file path, wrong path)
- ✅ Fallback modes (model bypasses the blueprint tool and writes real Markdown; no interference)
- ✅ TAD parsing & hydration (`TAD_LINE_RE` regex validation of the format `@path/to/file.ext[start-end]{+|!|~}deps(...)#intent`; `parseTadLine()` rejection of malformed lines and inverted ranges; `hydrateTadStep()` resolves project-relative paths, reads files, extracts line ranges, 200-line cap, missing-file/outside-root notes; test suite in `tests/tad.test.ts`)
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

### Maintaining the TAD Wire Format

Plan-mode step encoding lives in `src/tad.ts` (the regex `TAD_LINE_RE`, the shape description `TAD_LINE_SHAPE`, and the parser `parseTadLine()`). Any change to the wire format—regex syntax, operation tags, dependencies encoding, or intent label structure—must update all three in lock-step:

1. **Update `TAD_LINE_RE`** in `src/tad.ts` to validate the new syntax.
2. **Update `TAD_LINE_SHAPE`** string to reflect the human-readable format (used in error messages and prompts).
3. **Update the `<scribe>` directive** in `src/index.ts` to teach the model the new syntax.
4. **Update `WRITER_SYSTEM_PROMPT`** in `src/writer-session.ts` to decode the new format correctly.
5. Rebuild and test: `npm run typecheck && npm run build && bun test`.

### Updating oh-my-pi Contracts

If oh-my-pi changes its plan-mode internals:

1. **If the mode-entry contract changes** (entry type or `mode` vocabulary): update `PLAN_MODE_CONTEXT_CUSTOM_TYPE` / `PLAN_MODE_EXITED_CUSTOM_TYPES` and the `mode_change` check in `isPlanModeBranch()` in `config.ts`.
2. **If plan-file naming changes** (charset or suffix): update `PLAN_FILE_PATH_RE` in `config.ts` (line 22) and the `planFileTarget()` slug rule.
3. **If `ExtensionAPI` interface changes**: Update type imports in `src/*.ts` (header comments); recompile and test.
4. **If tool lifecycle events change**: Update event handler signatures in `index.ts`.

Rebuild after any contract changes: `npm run build && npm run typecheck && bun test`

