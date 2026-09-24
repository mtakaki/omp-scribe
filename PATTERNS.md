# omp-scribe: Code Patterns & Conventions

A guide to understanding the async patterns, error handling, type safety, and extension lifecycle in this oh-my-pi extension codebase.

---

## 1. Async Patterns

### Promise-based Event Subscriptions

**File: `writer-session.ts`**

The extension uses event subscriptions to stream output from nested sessions. The pattern wraps event streaming in a `Promise` to convert callback-based event flow into awaitable async code:

```typescript
let markdown = "";
await new Promise<void>((resolve, reject) => {
  const unsubscribe = activeSession.subscribe(evt => {
    if (evt.type === "message_update" && evt.assistantMessageEvent.type === "text_delta") {
      markdown += evt.assistantMessageEvent.delta;
      return;
    }
    if (evt.type === "agent_end" && evt.isTerminal !== false) {
      unsubscribe();
      resolve();
    }
  });
  activeSession.prompt(promptText).catch((err: unknown) => {
    unsubscribe();
    reject(err instanceof Error ? err : new Error(String(err)));
  });
});
```

**Pattern:**
- Capture a local variable (`markdown = ""`) that accumulates streamed data across event callback invocations
- Call `resolve()` only when terminal event (`agent_end`) arrives to signal completion
- Immediately `unsubscribe()` to prevent dangling event listeners
- Chain `.catch()` on the async prompt trigger to reject the promise on error
- Type the promise return as `Promise<void>` — the real result lives in the closed-over `markdown` variable

### Async/Await with Try-Finally for Resource Cleanup

**File: `writer-session.ts` (lines 45-88)**

Nested sessions must be disposed even if errors occur:

```typescript
try {
  const created = await sdk.createAgentSession({ /* ... */ });
  session = created.session;
  const activeSession = session;
  
  let markdown = "";
  await new Promise<void>((resolve, reject) => { /* ... */ });
  
  markdown = markdown.trim();
  if (!markdown) return { error: "Writer model returned an empty response." };
  return { markdown };
} catch (error) {
  return { error: error instanceof Error ? error.message : String(error) };
} finally {
  if (session) await session.dispose();
}
```

**Pattern:**
- Separate variable initialization (`session = undefined`) before try to ensure finally can safely check it
- Store the created session so finally can dispose it
- Re-assign to `const activeSession = session` to provide a stable reference for the event subscription closure (immutable re-binding)
- Dispose is unconditional in `finally`, protecting against early returns and exceptions

### Bounded Retry Around a Nested-Session Call

**File: `writer-session.ts`**

`runWriterExpansion` streams exactly one nested-session completion; `runWriterExpansionWithRetry` places a single, bounded retry in front of it:

```typescript
async function runWriterExpansionWithRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModel: Model,
  systemPrompt: string,
  promptText: string,
): Promise<ExpandResult> {
  const first = await runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText);
  if (!("error" in first)) return first;
  if (ctx.hasUI) {
    ctx.ui.notify(`Scribe: writer model failed (${first.error}); retrying with a fresh session.`, "warning");
  }
  return runWriterExpansion(pi, ctx, writerModel, systemPrompt, promptText);
}
```

**Pattern:**
- Same signature as the helper it wraps, so a caller swaps one call for the other with no other change.
- Both a thrown session error and an empty completion reach the caller as `{ error }` from `runWriterExpansion`, so the single `"error" in first` check covers both transient cases.
- The retry constructs a brand-new nested session (no reused state), which is what makes it a genuine second attempt rather than a replay.
- Exactly one retry: a persistently broken writer model still surfaces its error promptly instead of looping.
- `expandBlueprintToMarkdown` and `expandDocBlueprintToMarkdown` call this wrapper only; `runWriterExpansion` is never invoked directly by either public entry point.
- The wrapped helper is what streams `message_update`/`text_delta` events into the markdown string and folds each assistant `message_end` into the writer's token-usage and cost totals.

### Event Handler Async Signatures

**File: `index.ts` (lines 33-42, 103-126, 128-151)**

Extension event handlers are always `async`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  cfg = await readScribeConfig(pi, ctx.cwd);
});

pi.on("before_agent_start", async (event, ctx) => {
  const wantsBlueprintTool = isPlanModeActive(ctx);
  const activeTools = pi.getActiveTools();
  // ... decision logic ...
  if (wantsBlueprintTool !== hasBlueprintTool) {
    await pi.setActiveTools(nextTools);  // Awaited, blocking until applied
  }
  return { systemPrompt: [...event.systemPrompt, SCRIBE_DIRECTIVE] };
});

pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
  if (event.toolName !== "write") return;
  // ... logic that may block or return early ...
});
```

**Pattern:**
- All event handlers are `async` even if not strictly required, maintaining consistency
- Awaiting API calls that modify extension state (`.setActiveTools()`) ensures sequential consistency
- Early returns (`if (!slug) return`) are valid; omitting early return means "no modification for this event"
- Tool handlers can return early to signal "pass through without modification"

---

## 2. Error Handling Strategy

### Discriminated Union Return Type (`Result<T>`)

**File: `writer-session.ts`**

Errors are returned as part of the return value, not thrown:

```typescript
export type ExpandResult =
  | { markdown: string; model: { provider: string; id: string }; usage: { input: number; output: number }; costUsd: number }
  | { error: string };

export async function expandBlueprintToMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModelSpec: string,
  blueprint: PlanBlueprint,
): Promise<ExpandResult> {
  const writerModel = resolveWriterModel(ctx, writerModelSpec); // spec ?? "@smol"
  if (!writerModel) {
    return { error: `No model resolves for writer model "${writerModelSpec}" or fallback role "@smol".` };
  }

  let resolvedSteps: ScribeStepResolved[];
  try {
    validateScribeBlueprint(blueprint);
    resolvedSteps = resolveScribeSteps(blueprint);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const hydrated = await Promise.all(resolvedSteps.map(step => hydrateScribeStep(ctx.cwd, step)));
  return runWriterExpansionWithRetry(pi, ctx, writerModel, WRITER_SYSTEM_PROMPT, buildPlanPromptText(blueprint, hydrated));
}
```

**Pattern:**
- Tagged union: caller must handle both branches (`"error" in result` narrows to the failure; otherwise `result.markdown`)
- No throwing from normal-path errors; exceptions only for truly unexpected failures
- Catch-all exception handler converts unknown errors to the error discriminant — including the descriptive `Error` `validateScribeBlueprint` throws
- Fallback model resolution (`resolveWriterModel()` = spec `??` `@smol`) provides graceful degradation
- All return paths remain type-safe and exhaustive
- The success variant is no longer just the text: it carries the writer model's identity, token usage, and cost, which `index.ts` forwards into `PendingBlueprint` so `computeCosts()` (`pricing.ts`) and `appendSavingsRun()` (`stats-store.ts`) can price and persist the run after the write swap

### Tool Execution Error Response (`isError` flag)

**File: `index.ts` (lines 82-86)**

Tools signal errors via the response object:

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const blueprint = params as PlanBlueprint;
  const result = await expandBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
  if ("error" in result) {
    return {
      content: [{ type: "text", text: `Blueprint expansion failed: ${result.error}` }],
      isError: true,  // Signals the model that the tool call failed
    };
  }
  // ...
}
```

**Pattern:**
- Tools return `{ isError: true }` when preconditions fail (model expansion error)
- The human-readable error message goes in `content[0].text`
- Model sees the error and can retry or fall back without the plan file being created

### Blocking Tool Response (Defensive Error Prevention)

**File: `index.ts` (lines 141-145)**

Prevents invalid state from reaching disk:

```typescript
if (input.content.trim() === PLACEHOLDER_CONTENT) {
  return {
    block: true,
    reason: `No drafted Markdown found for slug "${slug}". Call ${BLUEPRINT_TOOL_NAME} with slug "${slug}" first, then retry this write with content "${PLACEHOLDER_CONTENT}".`,
  };
}
```

**Pattern:**
- `block: true` prevents the native write tool from executing
- `reason` field explains exactly what the model did wrong and how to fix it
- This is a safety net: prevents the literal word "pending" from ever landing in the plan file
- Only triggered if the model skipped the blueprint tool entirely and used the placeholder

### Early Return for Non-Matching Events

**File: `index.ts` (lines 128-132)**

Gracefully handle events this extension doesn't modify:

```typescript
pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
  if (event.toolName !== "write") return;        // Not our tool
  const input = event.input as WriteToolInput;
  const target = planFileTarget(input.path);
  if (!target) return;                            // Not a plan file
  // ... now we handle it ...
});
```

**Pattern:**
- Omitting a return value means "no modification; pass through normally"
- Guard clauses at the top exit cleanly for non-matching cases
- No exception handling needed for normal filtering

---

## 3. Type Safety Practices

### Strict TypeScript & Type Imports

**File: `config.ts` (lines 1-2)**

Type-only imports prevent runtime bloat:

```typescript
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
```

**Pattern:**
- `import type` signals types are erased at compile time, never instantiated
- Runtime code uses host-injected `pi` namespace (see Dependency Injection section)
- DevDependencies in `package.json` are types-only; no direct runtime imports of `@oh-my-pi/pi-coding-agent`

### Structured Config Objects (ScribeConfig)

**File: `config.ts` (lines 21-31)**

Configuration encapsulated in a typed interface:

```typescript
export interface ScribeConfig {
  brainModel: string | undefined;
  writerModel: string;
}

export async function readScribeConfig(pi: ExtensionAPI, cwd: string): Promise<ScribeConfig> {
  const brain = pi.getFlag("scribe-brain-model");
  const writer = pi.getFlag("scribe-writer-model");
  const brainModel = typeof brain === "string" && brain.trim() ? brain.trim() : undefined;
  const flagged = typeof writer === "string" && writer.trim() ? writer.trim() : undefined;
  if (flagged !== undefined && flagged !== DEFAULT_WRITER_MODEL) {
    return { brainModel, writerModel: flagged };
  }
  const persisted = await readPersistedScribeConfig(cwd);
  return { brainModel, writerModel: persisted.writerModel ?? DEFAULT_WRITER_MODEL };
}
```

**Pattern:**
- Config is read once per session (in `session_start` event, which supplies `ctx.cwd`)
- Type guards (`typeof X === "string"`) ensure values are safe
- Defaults applied at the boundary, not scattered throughout
- Validation (`.trim()`, fallback to `DEFAULT_WRITER_MODEL`) happens in one place
- Writer-model precedence lives in exactly one function: non-default CLI flag → persisted per-project override → default
- Immutable after creation: stored in `let cfg` (lines 26) which is reassigned only at session start or by `/scribe-model`

### Type Guards and Defensive Checks

**File: `config.ts` (lines 102-143)**

Guard unknown values before processing:

```typescript
export interface PlanFileTarget {
  stem: string;
  slug: string | undefined;
}

export function planFileTarget(path: unknown): PlanFileTarget | undefined {
  if (typeof path !== "string") return undefined;
  const stem = PLAN_FILE_PATH_RE.exec(path)?.[1];
  if (stem === undefined) return undefined;
  const slug = /^(.*)-plan$/i.exec(stem)?.[1];
  return { stem, slug: slug ? slug : undefined };
}

export function pendingPlanEntry(
  store: ReadonlyMap<string, PendingBlueprint>,
  sessionKey: string,
  target: PlanFileTarget,
): { key: string; entry: PendingBlueprint } | undefined {
  const mine = [...store.entries()].filter(([, entry]) => entry.sessionKey === sessionKey);
  const wantedSlug = (target.slug ?? "").toLowerCase();
  const wantedStem = target.stem.toLowerCase();
  const exact = mine.find(
    ([key]) => key.toLowerCase() === wantedSlug || `${key}-plan`.toLowerCase() === wantedStem,
  );
  if (exact) return { key: exact[0], entry: exact[1] };
  return mine.length === 1 ? { key: mine[0][0], entry: mine[0][1] } : undefined;
}

export function sameModel(resolved: Model, current: Model | undefined): boolean {
  return !!current && resolved.provider === current.provider && resolved.id === current.id;
}
```

**Pattern:**
- Accept `unknown` at public boundaries, narrow to typed values
- `planFileTarget` tolerantly accepts any `local://*plan.md` path and extracts the slug when present
- `pendingPlanEntry` resolves a draft using case-insensitive slug matching, slug-as-stem matching, or (as fallback) the session's only pending draft
- Use `??` (nullish coalescing) and `?.` (optional chaining) for safe property access
- Return `undefined` when type check fails (not throwing)
- Validate all fields of compared objects (provider + id must both match)

### Tool Parameter Types via Zod

**File: `index.ts`**

Runtime validation with TypeScript type inference:

```typescript
parameters: z.object({
  slug: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    .describe("Plan slug; the final file is local://<slug>-plan.md"),
  title: z.string().describe("Short plan title"),
  context: z.string().describe("2-4 sentences: literal ask, need, intended end state"),
  files: z
    .array(z.array(z.unknown()).min(3).max(3))
    .min(1)
    .describe("Files the plan touches, each a 3-element [id, path, reason] array …"),
  steps: z
    .array(z.array(z.unknown()).min(6).max(6))
    .min(1)
    .describe("Ordered load-bearing change steps, each a 6-element [fileId, operation, range|null, intent, preserve[], doNot[]] array …"),
  verification: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
}),
```

And in the execute function:

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const raw = params as PlanBlueprintInput;          // Safe coercion after Zod validation
  const blueprint: PlanBlueprint = {
    ...raw,
    verification: raw.verification ?? [],            // Fill the optional fields the model omitted
    assumptions: raw.assumptions ?? [],
  };
  // ...
}
```

**Pattern:**
- Zod validates input at the tool boundary (guarantees schema compliance)
- `.describe()` provides human-readable field documentation, including the exact tuple arity and field order
- `.min(1)` enforces non-empty arrays; `.optional()` keeps trailing fields the model may drop on a large call from failing the whole tool call
- `.regex()` enforces slug format
- `params as PlanBlueprintInput` is safe because Zod has already validated the shape
- Zod has no tuple/union combinator, so `files`/`steps` can only be asserted as fixed-length arrays of `unknown` — `validateScribeBlueprint` in `scribe-ir.ts` is the sole place doing the per-position semantic checks (id uniqueness, operation membership, range ordering, the fileId cross-reference). This two-layer Zod-shape-plus-hand-written-validator split replaces the old approach, where one anchored regex had to validate every step line end to end.

### Event Handler Parameter Typing

**File: `index.ts` (lines 103, 128)**

Event handlers receive strongly typed parameters:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event is BeforeAgentStartEvent (has systemPrompt: readonly string[])
  // ctx is ExtensionContext (has cwd, models, modelRegistry, etc.)
  const wantsBlueprintTool = isPlanModeActive(ctx);
});

pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
  // event: ToolCallEvent (has toolName, input)
  // ctx: ExtensionContext
  if (event.toolName !== "write") return;
  const input = event.input as WriteToolInput;
});
```

**Pattern:**
- Framework provides typed events; extension handlers receive them directly
- `ExtensionContext` is the standard parameter passed to every handler
- Some events require explicit type annotation (e.g., `ToolCallEvent`) if not inferred

---

## 4. Naming Conventions

### Constants: SCREAMING_SNAKE_CASE

**File: `config.ts`**

Public export constants:

```typescript
export const BLUEPRINT_TOOL_NAME = "propose_plan_blueprint";
export const PLAN_UPDATE_TOOL_NAME = "propose_plan_update";
export const DOC_BLUEPRINT_TOOL_NAME = "propose_doc_blueprint";
export const PLACEHOLDER_CONTENT = "pending";
export const DEFAULT_WRITER_MODEL = "@smol";
```

Private constants:

```typescript
const PLAN_FILE_PATH_RE = /^local:\/\/([A-Za-z0-9_-]*plan)\.md$/i;

export const BLUEPRINT_TOOL_NAME = "propose_plan_blueprint";
export function isPlanModeBranch(branch: readonly unknown[]): boolean { /* ... */ }
export function isPlanModeActive(ctx: ExtensionContext): boolean { /* ... */ }
export function planFileTarget(path: unknown): PlanFileTarget | undefined { /* ... */ }
export function pendingPlanEntry(...): { key: string; entry: PendingBlueprint } | undefined { /* ... */ }
```

**Pattern:**
- Module-scoped constants are `SCREAMING_SNAKE_CASE`, even if private
- Used for domain contracts (tool names, regex patterns, string markers)
- Centralizes magic strings so they can be reused and updated in one place

### Functions: camelCase, Descriptive Verbs

**File: `config.ts`, `scribe-ir.ts` & `writer-session.ts`**

Exported utility functions:

```typescript
export function registerScribeFlags(pi: ExtensionAPI): void { /* ... */ }
export async function readScribeConfig(pi: ExtensionAPI, cwd: string): Promise<ScribeConfig> { /* ... */ }
export async function readPersistedScribeConfig(cwd: string): Promise<PersistedScribeConfig> { /* ... */ }
export async function writePersistedScribeConfig(cwd: string, patch: PersistedScribeConfig): Promise<PersistedScribeConfig> { /* ... */ }
export function formatScribeStatus(cfg: ScribeConfig, state: ScribeStatusState): string { /* ... */ }
export function isPlanModeBranch(branch: readonly unknown[]): boolean { /* ... */ }
export function isPlanModeActive(ctx: ExtensionContext): boolean { /* ... */ }
export function planFileTarget(path: unknown): PlanFileTarget | undefined { /* ... */ }
export function pendingPlanEntry(...): { key: string; entry: PendingBlueprint } | undefined { /* ... */ }
export function pendingDocEntry(...): { key: string; entry: PendingBlueprint } | undefined { /* ... */ }
export function sameModel(resolved: Model, current: Model | undefined): boolean { /* ... */ }
export function resolveWriterModel(ctx: ExtensionContext, spec: string): Model | undefined { /* ... */ }
export function validateScribeBlueprint(blueprint: PlanBlueprint): void { /* ... */ }          // scribe-ir.ts
export function resolveScribeSteps(blueprint: PlanBlueprint): ScribeStepResolved[] { /* ... */ } // scribe-ir.ts
export async function hydrateScribeStep(projectRoot: string, step: ScribeStepResolved): Promise<HydratedScribeStep> { /* ... */ }
export async function expandBlueprintToMarkdown( /* ... */ ): Promise<ExpandResult> { /* ... */ }
```

**Pattern:**
- Verb + noun: `register...`, `read...`, `is...`, `extract...`, `same...`, `expand...`
- Boolean predicates start with `is` or `same`
- Extraction functions return the extracted value or `undefined`
- Async functions return `Promise<T>`
- No getters/setters; use direct function names like `readConfig()`

### Interfaces & Types: PascalCase

**File: `types.ts`, `scribe-ir.ts` & `config.ts`**

```typescript
export type ScribeOperation = "+" | "!" | "~";
export type ScribeFile = readonly [id: string, path: string, reason: string];
export type ScribeRange = readonly [start: number, end: number];
export type ScribeStep = readonly [fileId: string, operation: ScribeOperation, range: ScribeRange | null, intent: string, preserve: readonly string[], doNot: readonly string[]];
export interface PlanBlueprint { /* ... */ }
export interface DocBlueprintSection { /* ... */ }
export interface DocBlueprint { /* ... */ }
export interface ScribeStepResolved { /* ... */ }   // scribe-ir.ts
export interface HydratedScribeStep { /* ... */ }   // scribe-ir.ts
export interface ScribeConfig { /* ... */ }         // config.ts
export type ExpandResult = { markdown: string; model: { provider: string; id: string }; usage: { input: number; output: number }; costUsd: number } | { error: string };
```

**Pattern:**
- Interfaces are PascalCase (domain types)
- Type aliases are PascalCase, covering both the positional Scribe IR tuples and discriminated unions
- Suffix interfaces with the domain noun: `...Blueprint`, `...Config`, `...Step`, `...Range`

### Variables: camelCase, Descriptive Nouns

**File: `index.ts`**

```typescript
let cfg: ScribeConfig = { /* ... */ };               // Configuration
let lastKnownModels: Model[] = [];                   // Model snapshot for /scribe-model
let brainUsage = { input: 0, output: 0 };            // Cost-tracking state for this turn
let brainOutputRatePerMillionUsd = 0;
const sessionKey = (ctx: ExtensionContext): string => { /* ... */ };  // Derived key function
```

**Pattern:**
- Local variables use full nouns (`cfg`, `blueprint`, `markdown`, `result`)
- Store keys are the draft's own slug (plan) or declared write target (doc); session ownership lives inside the entry, not in the key
- Derived functions get descriptive names (`sessionKey`)

### Private vs. Export

**File: `config.ts`**

```typescript
const PLAN_FILE_PATH_RE = /^local:\/\/([A-Za-z0-9_-]*plan)\.md$/i;  // Private: internal regex

export const BLUEPRINT_TOOL_NAME = "propose_plan_blueprint";   // Public: referenced in multiple files
export function isPlanModeBranch(branch: readonly unknown[]): boolean { /* ... */ }  // Public
export function isPlanModeActive(ctx: ExtensionContext): boolean { /* ... */ }       // Public
export function planFileTarget(path: unknown): PlanFileTarget | undefined { /* ... */ }      // Public
export function pendingPlanEntry(...): { key: string; entry: PendingBlueprint } | undefined { /* ... */ }  // Public
```

**Pattern:**
- Internal contracts (regex, string markers) are private to `config.ts`
- Public APIs (`BLUEPRINT_TOOL_NAME`) are exported and reused
- Functions are exported unless they're truly one-off helpers

---

## 5. Configuration & Flag Patterns

### Flag Registration at Load Time

**File: `config.ts` (lines 33-44)**

Flags are registered once when the extension loads:

```typescript
export function registerScribeFlags(pi: ExtensionAPI): void {
  pi.registerFlag("scribe-brain-model", {
    type: "string",
    description:
      'Expected model for plan-mode blueprint drafting (advisory only; set modelRoles.plan to actually switch models), e.g. "anthropic/claude-opus-4-5"',
  });
  pi.registerFlag("scribe-writer-model", {
    type: "string",
    description: "Model used to expand the compact plan/doc blueprint into the final Markdown file.",
    default: "@smol",
  });
}
```

Called immediately in extension init:

```typescript
// index.ts, line 24
export default function scribe(pi: ExtensionAPI): void {
  registerScribeFlags(pi);
  // ... rest of extension ...
}
```

**Pattern:**
- Flag registration happens once at extension load time (safe per docs)
- `type: "string"` with optional `default` value
- Clear descriptions explain what each flag does
- Flag namespace prefixed with extension name: `scribe-*`

### Lazy Config Reading at Session Start

**File: `index.ts` (lines 33-35)**

Configuration is read fresh for each session:

```typescript
let cfg: ScribeConfig = { brainModel: undefined, writerModel: DEFAULT_WRITER_MODEL };

pi.on("session_start", async (_event, ctx) => {
  cfg = await readScribeConfig(pi, ctx.cwd);
});
```

**Pattern:**
- Config object initialized with safe defaults at extension load time
- Reassigned to current values at each `session_start` event
- Event handlers use the cached `cfg` variable (closure capture)
- Supports flag changes between sessions without reloading the extension

### Default Values Applied at Boundaries

**File: `config.ts` (lines 46-52)**

```typescript
export async function readScribeConfig(pi: ExtensionAPI, cwd: string): Promise<ScribeConfig> {
  const brain = pi.getFlag("scribe-brain-model");
  const writer = pi.getFlag("scribe-writer-model");
  const brainModel = typeof brain === "string" && brain.trim() ? brain.trim() : undefined;
  const flagged = typeof writer === "string" && writer.trim() ? writer.trim() : undefined;
  if (flagged !== undefined && flagged !== DEFAULT_WRITER_MODEL) {
    return { brainModel, writerModel: flagged };
  }
  const persisted = await readPersistedScribeConfig(cwd);
  return { brainModel, writerModel: persisted.writerModel ?? DEFAULT_WRITER_MODEL };
}
```

**Pattern:**
- Flags are read from the API and type-checked
- Empty strings are treated as missing (falsy)
- `@smol` is the hard-coded fallback for writer model
- Trimming prevents whitespace-only values from being accepted

---

## 6. Event Lifecycle & Binding Patterns

### Extension Factory Function Pattern

**File: `index.ts`**

```typescript
export default function scribe(pi: ExtensionAPI): void {
  // 1. Register flags first
  registerScribeFlags(pi);

  // 2. Initialize module-scoped state
  let cfg: ScribeConfig = { brainModel: undefined, writerModel: DEFAULT_WRITER_MODEL };
  let lastKnownModels: Model[] = [];
  let brainUsage = { input: 0, output: 0 };   // cost tracking, reset per plan turn
  let brainModelId: string | undefined;
  let brainCostUsd = 0;
  let brainOutputRatePerMillionUsd = 0;

  // 3. Register event handlers in order of lifecycle
  pi.on("session_start", async (_event, ctx) => { /* ... */ });
  pi.on("session_shutdown", async (_event, ctx) => { /* ... */ });
  pi.on("message_end", async (event, ctx) => { /* brain-model usage/cost accounting */ });
  pi.on("before_agent_start", async (event, ctx) => { /* ... */ });
  pi.on("tool_call", async (event: ToolCallEvent, ctx) => { /* ... */ });

  // 4. Register both tools (inactive until a mode activates them)
  pi.registerTool({ /* propose_plan_blueprint */ });
  pi.registerTool({ /* propose_doc_blueprint */ });

  // 5. Register the slash commands
  pi.registerCommand("savings", { /* ... */ });
  pi.registerCommand("scribe-doc", { /* ... */ });
  pi.registerCommand("scribe-model", { /* ... */ });
}
```

**Pattern:**
- Extension factory returns `void` (framework handles registration)
- All setup happens synchronously in the factory
- Flags are registered before any event handlers
- Event handlers close over module state (`cfg`, `lastKnownModels`, the cost-tracking variables)
- Both tools are registered once and start inactive; per-turn activation happens in `before_agent_start`
- Command handlers receive an `ExtensionCommandContext`, which is where the `/scribe-model` picker and completions live
- All binding is declarative (no imperative "on demand" registration)

### State Isolation: Closure Capture

**File: `index.ts`**

```typescript
let cfg: ScribeConfig = { brainModel: undefined, writerModel: DEFAULT_WRITER_MODEL };
let lastKnownModels: Model[] = [];
let brainUsage = { input: 0, output: 0 };

const sessionKey = (ctx: ExtensionContext): string =>
  ctx.sessionManager.getSessionId?.() ?? "default";
```

Then in every event handler:

```typescript
pi.on("session_start", async (_event, ctx) => {
  cfg = await readScribeConfig(pi, ctx.cwd);      // Writes to outer cfg
  lastKnownModels = ctx.models.list?.() ?? [];    // Snapshot for /scribe-model
});

pi.on("session_shutdown", async (_event, ctx) => {
  const key = sessionKey(ctx);
  const store = pendingMarkdownStore();           // Process-wide store, not a closure cache
  for (const [slug, entry] of [...store.entries()]) {
    if (entry.sessionKey === key) store.delete(slug);
  }
});

// In the plan blueprint tool's execute function:
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  // Uses cfg from outer scope
  const result = await expandBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
  // Writes to the process-wide store from outer scope, keyed by slug
  pendingMarkdownStore().set(blueprint.slug, {
    sessionKey: sessionKey(ctx),
    markdown: result.markdown,
    writerModel: result.model,
    writerUsage: result.usage,
    writerCostUsd: result.costUsd,
  });
}
```

**Pattern:**
- Module-level `let` variables are visible to all event handlers (closure)
- Events can update shared state (`cfg`, `lastKnownModels`, the cost-tracking quartet)
- Session ID is derived on demand via `sessionKey()` and then carried *inside* each store entry
- Drafts live in the process-wide singleton stores rather than a per-factory Map, so duplicate factory invocations share them; sessions are isolated by `entry.sessionKey` at lookup time, not by a composite key

### Session Lifecycle: Start → Shutdown

**File: `index.ts`**

```typescript
pi.on("session_start", async (_event, ctx) => {
  cfg = await readScribeConfig(pi, ctx.cwd);
  lastKnownModels = ctx.models.list?.() ?? [];
  showStatus(ctx, baseStatus(ctx));
});

pi.on("session_shutdown", async (_event, ctx) => {
  const key = sessionKey(ctx);
  for (const [slug, entry] of [...pendingMarkdownStore().entries()]) {
    if (entry.sessionKey === key) pendingMarkdownStore().delete(slug);
  }
  for (const [path, entry] of [...pendingDocMarkdownStore().entries()]) {
    if (entry.sessionKey === key) pendingDocMarkdownStore().delete(path);
  }
  for (const [path, owner] of [...docDraftHistory().entries()]) {
    if (owner === key) docDraftHistory().delete(path);
  }
  armedDocSessions().delete(key);
  for (const [id, swap] of [...consumedWriteSwaps().entries()]) {
    if (swap.sessionKey === key) consumedWriteSwaps().delete(id);
  }
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
});
```

**Pattern:**
- `session_start` loads fresh configuration, snapshots the model list for `/scribe-model`, and paints the footer
- `session_shutdown` sweeps all five singleton stores, deleting only the entries this session owns
- Ownership is the `sessionKey` carried inside each entry (or the `Set`/`Map` key for armed sessions and draft history), which keeps concurrent sessions from evicting each other's drafts
- Copy before iterating: `[...store.entries()]` (prevents concurrent-modification issues while deleting)
- The footer status key is cleared on shutdown so a later session starts clean

### Turn-Scoped Activation (before_agent_start)

**File: `index.ts`**

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const wantsBlueprintTool = isPlanModeActive(ctx);
  if (wantsBlueprintTool) {
    brainUsage = { input: 0, output: 0 };   // fresh accounting per plan turn
    brainModelId = undefined;
    brainCostUsd = 0;
    brainOutputRatePerMillionUsd = 0;
  }
  const wantsDocTool = armedDocSessions().has(sessionKey(ctx));

  const activeTools = pi.getActiveTools();
  const hasBlueprintTool = activeTools.includes(BLUEPRINT_TOOL_NAME);
  const hasDocTool = activeTools.includes(DOC_BLUEPRINT_TOOL_NAME);

  if (wantsBlueprintTool !== hasBlueprintTool || wantsDocTool !== hasDocTool) {
    let nextTools = [...activeTools];
    // …add each wanted tool / filter out each unwanted one…
    await pi.setActiveTools(nextTools);     // one call reconciles both tools
  }

  const additions: string[] = [];
  if (wantsBlueprintTool) additions.push(SCRIBE_DIRECTIVE);
  if (wantsDocTool) additions.push(DOC_SCRIBE_DIRECTIVE);
  if (additions.length === 0) return;
  return { systemPrompt: [...event.systemPrompt, ...additions] };
});
```

**Pattern:**
- Two independent mode checks drive two independent activations: `isPlanModeActive(ctx)` (scans the session branch) and `armedDocSessions().has(sessionKey(ctx))` (the `/scribe-doc` toggle)
- Both tools are reconciled in a single `setActiveTools` call, so the active set never settles in an intermediate state
- Entering plan mode resets the brain cost-tracking state, so each plan turn is priced on its own tokens
- Only the directives that apply are appended; when neither mode is on, the handler returns nothing
- A plan-mode transition also announces the resolved writer model, and an advisory warning is logged if the configured brain model differs from the active one

### Event Handler Return Contracts

**File: `index.ts` & `writer-session.ts`**

```typescript
// before_agent_start: return modified event (or nothing to pass through)
return { systemPrompt: [...event.systemPrompt, SCRIBE_DIRECTIVE] };

// session_start, session_shutdown: no return
pi.on("session_start", async () => { /* ... */ });
pi.on("session_shutdown", async (_event, ctx) => { /* ... */ });

// tool_call: return input/block/nothing
return { input: { ...input, content: markdown } };  // Modify input
return { block: true, reason: "..." };              // Prevent execution
return;                                              // Pass through
```

**Pattern:**
- Return object with modified event to intercept/modify
- Return nothing to pass through unchanged
- `block: true` with `reason` is a special error response
- Tool execute returns `{ content, details?, isError? }`

---

## 7. Dependency Injection & API Surface

### Host-Injected `pi` Namespace

**File: `writer-session.ts` (line 41) & `index.ts` (line 1)**

The extension never imports `@oh-my-pi/pi-coding-agent` at runtime:

```typescript
// index.ts: types-only import
import type { ExtensionAPI, ExtensionContext, /* ... */ } from "@oh-my-pi/pi-coding-agent";

// writer-session.ts: function signature uses types
export async function expandBlueprintToMarkdown(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  writerModelSpec: string,
  blueprint: PlanBlueprint,
): Promise<ExpandResult> {
  const sdk = pi.pi;  // <- Access to live SDK via host injection
  const agentRegistry = new sdk.AgentRegistry();
  const created = await sdk.createAgentSession({ /* ... */ });
}
```

**Pattern:**
- `pi: ExtensionAPI` is injected by the framework at extension load time
- `pi.pi` gives access to the live `PiCodingAgent` SDK (singletons like `AgentRegistry`)
- Never `import` the SDK directly; use only the injected `pi` namespace
- This ensures the nested session shares the host's singletons (critical for `local://` handoff)

### ExtensionContext Provides Runtime Environment

**File: `index.ts` & throughout**

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // ctx.sessionManager.getSessionId?.() — unique session ID
  // ctx.models.resolve(spec) — resolve model by name/role
  // ctx.models.current() — current active model
  // ctx.models.list() — authenticated models, for /scribe-model's picker + completions
  // ctx.hasUI — whether a UI is attached
  // ctx.ui.notify(msg, level) — user notifications
  // ctx.ui.setStatus(key, text) — footer status line
  // ctx.ui.select(title, options, opts) — the /scribe-model picker
  // ctx.cwd — working directory
  // ctx.modelRegistry — model provider registry
  // ctx.localProtocolOptions — for sharing local:// across sessions
  // ctx.logger — logging API
});

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  // ctx.cwd, ctx.modelRegistry, ctx.localProtocolOptions available
  const result = await expandBlueprintToMarkdown(pi, ctx, cfg.writerModel, blueprint);
}
```

**Pattern:**
- `ExtensionContext` is passed as second parameter to all event handlers
- `ctx.models` is used to resolve and compare models; `ctx.models.list()` additionally seeds the `/scribe-model` picker and its argument completions
- `ctx.sessionManager` provides unique session identification
- `ctx.modelRegistry` and `ctx.localProtocolOptions` enable nested sessions
- `ctx.cwd` is passed to nested session for file operations
- `ctx.hasUI` gates every footer write, notification, and the `/scribe-model` picker; without a UI the extension still tracks and swaps state, it just reports nothing

### Model Resolution & Caching

**File: `config.ts` (lines 73-74) & `writer-session.ts` (line 36)**

```typescript
// Comparison: does resolved match current?
export function sameModel(resolved: Model, current: Model | undefined): boolean {
  return !!current && resolved.provider === current.provider && resolved.id === current.id;
}

// Resolution with fallback
const writerModel = ctx.models.resolve(writerModelSpec) ?? ctx.models.resolve("@smol");
if (!writerModel) {
  return { error: `No model resolves for writer model "${writerModelSpec}" or fallback role "@smol".` };
}
```

**Pattern:**
- `ctx.models.resolve(spec)` returns a `Model` or `undefined`
- Model specs can be role names (`@smol`) or provider/id pairs
- Comparison uses both `provider` and `id` fields
- Graceful fallback: try configured model, then fallback role, then error

### Zod Access via Dependency Injection

**File: `index.ts` (line 44)**

```typescript
const z = pi.zod;
pi.registerTool({
  parameters: z.object({ /* ... */ }),
  // ...
});
```

**Pattern:**
- Zod is accessed via `pi.zod` (not imported separately)
- Ensures the extension and framework use the same Zod instance
- Prevents version mismatches or multiple schema validators

---

## 8. Contract Enforcement Patterns

### Plan-File Target Resolution

**File: `config.ts` (lines 102-143)**

Tolerant plan-file matching and draft resolution:

```typescript
export interface PlanFileTarget {
  stem: string;
  slug: string | undefined;
}

export function planFileTarget(path: unknown): PlanFileTarget | undefined {
  if (typeof path !== "string") return undefined;
  const stem = PLAN_FILE_PATH_RE.exec(path)?.[1];
  if (stem === undefined) return undefined;
  const slug = /^(.*)-plan$/i.exec(stem)?.[1];
  return { stem, slug: slug ? slug : undefined };
}

export function pendingPlanEntry(
  store: ReadonlyMap<string, PendingBlueprint>,
  sessionKey: string,
  target: PlanFileTarget,
): { key: string; entry: PendingBlueprint } | undefined {
  const mine = [...store.entries()].filter(([, entry]) => entry.sessionKey === sessionKey);
  const wantedSlug = (target.slug ?? "").toLowerCase();
  const wantedStem = target.stem.toLowerCase();
  const exact = mine.find(
    ([key]) => key.toLowerCase() === wantedSlug || `${key}-plan`.toLowerCase() === wantedStem,
  );
  if (exact) return { key: exact[0], entry: exact[1] };
  return mine.length === 1 ? { key: mine[0][0], entry: mine[0][1] } : undefined;
}
```

**Pattern:**
- `planFileTarget` matches any `local://*plan.md` path (case-insensitive) and extracts the slug when the canonical `<slug>-plan.md` form is used
- `pendingPlanEntry` resolves drafts using case-insensitive slug matching, stem matching, or the session's only draft (for `local://PLAN.md`)
- Tolerant matching allows models to write `local://PLAN.md` without knowing the blueprint slug
- Early returns on non-matching targets preserve native write behavior


### String-Based Plan Mode Detection

**File: `config.ts` (lines 13-15, 57-59)**

```typescript
const PLAN_FILE_PATH_RE = /^local:\/\/([A-Za-z0-9_-]*plan)\.md$/i;

export function isPlanModeBranch(branch: readonly unknown[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (typeof entry !== "object" || entry === null) continue;
    const { type, mode, customType } = entry as { type?: unknown; mode?: unknown; customType?: unknown };
    if (type === "mode_change") return mode === "plan";
    if (type !== "custom_message" || typeof customType !== "string") continue;
    if (customType === "plan-mode-context") return true;
    if (customType === "plan-yolo-handoff") return false;
  }
  return false;
}

export function isPlanModeActive(ctx: ExtensionContext): boolean {
  const branch: unknown = ctx.sessionManager?.getBranch?.();
  return Array.isArray(branch) ? isPlanModeBranch(branch) : false;
}
```

**Pattern:**
- Scans session branch backwards for the most recent mode-related entry
- `mode_change` entry decides: `type: "mode_change" && mode: "plan"` means active
- Without a `mode_change`, looks for custom messages: `plan-mode-context` means active, `plan-yolo-handoff` means inactive
- Defensive `getBranch` guard in `isPlanModeActive` ensures foreign contexts degrade to false instead of throwing
- More reliable than checking system prompt: the session entry reflects the host's own view of the current state

### Sentinel Content for Write Interception

**File: `config.ts` (line 11) & `index.ts` (lines 141-145)**

```typescript
export const PLACEHOLDER_CONTENT = "pending";

// In tool_call handler:
if (input.content.trim() === PLACEHOLDER_CONTENT) {
  return {
    block: true,
    reason: `No drafted Markdown found for slug "${slug}". Call ${BLUEPRINT_TOOL_NAME} with slug "${slug}" first, then retry this write with content "${PLACEHOLDER_CONTENT}".`,
  };
}
```

**Pattern:**
- Model is instructed to use the placeholder `"pending"` when calling write
- Extension recognizes this sentinel and blocks if no markdown was pre-drafted
- Prevents the placeholder from accidentally reaching disk
- Informs model what went wrong and how to fix it

### Contract Invariant: Tool Execution Order

**File: `index.ts` (directive)**

```typescript
const SCRIBE_DIRECTIVE = `<scribe>
Cost control is active for this plan turn. Do NOT compose the Markdown plan document yourself.
1. Call \`${BLUEPRINT_TOOL_NAME}\` exactly once with a compact JSON object (no prose, no Markdown) covering slug/title/context/verification/assumptions, plus \`files\` and \`steps\` arrays:
   files entries are [id, path, reason] — id is a short label (e.g. "A"), path is project-relative, reason is one line on why the file matters.
   steps entries are [fileId, operation, range, intent, preserve, doNot]:
   - \`fileId\` — must match an id in \`files\`.
   - \`operation\` — "+" add, "!" delete, "~" modify.
   - \`range\` — [startLine, endLine] inclusive 1-based, or null when no existing range applies (e.g. a new file).
   - \`intent\` — a concise natural-language sentence describing the change; never an abbreviation or code.
   - \`preserve\` — array of things that must keep working; empty array when none.
   - \`doNot\` — array of explicit prohibitions; empty array when none.
   Never paste file content or line bodies into a step: the extension reads the referenced range from disk for the writer model.
   Example: files: [["A","src/auth.ts","password validation and cookie handling"]], steps: [["A","~",[42,67],"Validate the configured production password and issue the existing cookie.",["preserve the existing cookie format"],["do not modify admin authentication"]]].
2. After it returns, call \`write\` with path \`local://<slug>-plan.md\` (the same slug you supplied) and content exactly the single word \`${PLACEHOLDER_CONTENT}\` — the extension substitutes the expanded Markdown automatically before the write executes. Use \`write\` even when the plan file already exists: the draft is a complete replacement, so never edit it in place.
3. Then continue the normal \`xd://propose\` submission with that slug, as usual.
Never draft the Markdown plan body yourself, at any point in this turn. If \`${BLUEPRINT_TOOL_NAME}\` reports a failure, write the plan Markdown yourself with \`write\` and continue — never the placeholder word.
</scribe>\`;
```

**Pattern:**
- Directive is injected into the system prompt to enforce call ordering
- Model is told: blueprint tool first, then `write`, then propose
- The `files`/`steps` tuple shape — including a worked one-step example — is spelled out in the directive, so the model never has to infer the IR or guess field order
- Violations are detected in the `tool_call` handler (placeholder write with no drafted Markdown)
- The contract is human-readable and tied to specific tool names
- `DOC_SCRIBE_DIRECTIVE` enforces the analogous order for doc mode: call `propose_doc_blueprint` exactly once, then `write` the declared path with the placeholder — never compose the body directly

### Stateful Caching: Process-Wide Stores

**File: `config.ts` (stores) & `index.ts` (use)**

```typescript
// config.ts — globalThis-backed singletons, shared by every factory closure
export function pendingMarkdownStore(): Map<string, PendingBlueprint> { /* ... */ }
export function pendingDocMarkdownStore(): Map<string, PendingBlueprint> { /* ... */ }

// In the blueprint tool's execute:
pendingMarkdownStore().set(blueprint.slug, {
  sessionKey: sessionKey(ctx), markdown: result.markdown, /* writerModel, writerUsage, writerCostUsd */
});

// In the tool_call handler:
const resolved = pendingPlanEntry(pendingMarkdownStore(), sessionKey(ctx), target);
if (resolved !== undefined) {
  const { key, entry } = resolved;
  pendingMarkdownStore().delete(key);   // Consume exactly once
  return { input: { ...input, content: entry.markdown } };
}
```

**Pattern:**
- Keys are the draft's own slug (plan) or declared write target (doc); plan and doc drafts cannot collide because they live in separate stores
- Session ownership is carried inside the entry (`entry.sessionKey`) and checked by `pendingPlanEntry()`/`pendingDocEntry()` before a key is matched, so concurrent sessions never see each other's drafts
- Consumption is exactly-once: the entry is deleted before the swapped input is returned
- Storing the maps on `globalThis` keeps one instance per process even across duplicated module imports or hot reloads

### Scribe IR Structural Validation

**File: `scribe-ir.ts`**

The tool's Zod schema can only assert that each `files`/`steps` entry is an array of the right length, so per-field semantics are enforced by a hand-written validator that throws on the *first* violation:

```typescript
blueprint.steps.forEach((entry, index) => {
  if (!Array.isArray(entry) || entry.length !== 6) {
    throw new Error(`steps[${index}]: must be a 6-element [fileId, operation, range, intent, preserve, doNot] tuple.`);
  }
  const [fileId, operation, range, intent, preserve, doNot] = entry;
  if (typeof fileId !== "string" || !seenIds.has(fileId)) {
    throw new Error(`steps[${index}]: references unknown file id ${JSON.stringify(fileId)}.`);
  }
  if (operation !== "+" && operation !== "!" && operation !== "~") {
    throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): invalid operation ${JSON.stringify(operation)}; expected "+", "!", or "~".`);
  }
  if (range !== null) {
    // …must be [start, end]; start a positive integer; end >= start…
  }
});
```

**Pattern:**
- Every message names the offending index and, where known, the file id, so the planning model can correct exactly one thing and resubmit
- Validation is strict and total: it runs before any step is resolved or read from disk, and it never silently repairs malformed IR
- Cross-field checks the schema genuinely cannot express (does this `fileId` appear in `files`? is this `range` inverted?) live here, which is why `resolveScribeSteps()` is documented as call-after-validate
- `expandBlueprintToMarkdown` catches the throw and returns it as `{ error }`, preserving the module's "errors are return values" contract

---

## Summary: Design Principles

1. **Async: Promises over callbacks.** Event streams wrap in `Promise` for awaitable code; finally-blocks guarantee resource cleanup.

2. **Errors: Return values over exceptions.** Discriminated unions (`Result<T>`) for normal-path errors; exceptions only for truly unexpected failures. The success variant now also carries pricing/attribution metadata (`model`, `usage`, `costUsd`), which the write-swap handler turns into a persisted savings run.

3. **Types: Strict mode, type guards at boundaries.** Type-only imports; unknown inputs narrowed to typed values; Zod validation at tool parameters.

4. **Names: Verbs + nouns, clear intent.** `register*`, `read*`, `is*`, `extract*` functions; PascalCase types, camelCase variables.

5. **Configuration: Flags at load time, values read at session start.** Centralized defaults and validation in config module.

6. **Events: Declarative binding, closure capture for state.** All handlers registered in factory; shared state via module variables.

7. **Contracts: Regex, strings, schemas for enforcement.** Path matching, prompt markers, and tool schemas all prevent invalid states, and `validateScribeBlueprint` now enforces the per-field Scribe IR contract that a single regex previously covered only partially.

8. **Injection: Host provides SDK singletons via `pi` namespace.** Never import the SDK directly; use injected `pi` to access live singletons.

