/**
 * Minimal hand-built fakes for ExtensionAPI and ExtensionContext.
 *
 * Only the properties actually read by the code under test are implemented.
 * Everything else is intentionally absent; casts via `as unknown as T` silence
 * the type checker without requiring a full structural implementation of the
 * 1000+ line real interfaces.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-catalog";
import { z } from "@oh-my-pi/omptype/zod";

// ─── Model helpers ───────────────────────────────────────────────────────────

export function makeModel(provider: string, id: string, cost: { input: number; output: number; cacheRead: number; cacheWrite: number } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }): Model {
  return { provider, id, cost } as unknown as Model;
}

// ─── ExtensionContext fake ────────────────────────────────────────────────────

export interface FakeContextOverrides {
  cwd?: string;
  hasUI?: boolean;
  sessionId?: string;
  currentModel?: Model;
  resolveModel?: (spec: string) => Model | undefined;
  /** Authenticated models `ctx.models.list()` reports (feeds `/scribe-model`). */
  models?: Model[];
  /** Value `ctx.ui.select()` resolves with; `undefined` models a cancelled dialog. */
  selectResult?: string;
  /** Entries the fake `sessionManager.getBranch()` returns. Plan-mode detection
   *  reads this, so tests supply `mode_change` / custom-message entries here.
   *  The array is returned as-is, letting a test mutate it to simulate a mode
   *  transition between turns. */
  branch?: unknown[];
}

/** One `ctx.ui.select()` invocation: the dialog title plus the normalized
 *  options it was offered (bare strings widened to `{ label }`). */
export interface FakeSelectCall {
  title: string;
  options: Array<{ label: string; description?: string }>;
}

export interface FakeExtensionContext {
  ctx: ExtensionContext;
  notifications: Array<{ message: string; level: string }>;
  /** Footer status writes by key; `undefined` records a clear. */
  statuses: Map<string, string | undefined>;
  /** Every `ctx.ui.select()` call, in order. */
  selectCalls: FakeSelectCall[];
  /** What `ctx.ui.select()` resolves with (from `overrides.selectResult`). */
  selectResult: string | undefined;
}

export function createFakeExtensionContext(overrides: FakeContextOverrides = {}): FakeExtensionContext {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const selectCalls: FakeSelectCall[] = [];
  const selectResult = overrides.selectResult;

  const resolveModel =
    overrides.resolveModel ??
    ((spec: string) => (spec === "@smol" ? makeModel("anthropic", "claude-haiku-3-5") : undefined));

  const ctx = {
    cwd: overrides.cwd ?? "/tmp/fake-cwd",
    hasUI: overrides.hasUI ?? true,
    sessionManager: {
      getSessionId: () => overrides.sessionId ?? "fake-session",
      getBranch: () => overrides.branch ?? [],
    },
    models: {
      resolve: (spec: string) => resolveModel(spec),
      current: () => overrides.currentModel ?? makeModel("anthropic", "claude-sonnet-4-5"),
      list: () => overrides.models ?? [],
    },
    modelRegistry: {
      authStorage: {},
    },
    localProtocolOptions: undefined,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      select: async (
        title: string,
        options: Array<string | { label: string; description?: string }>,
      ): Promise<string | undefined> => {
        selectCalls.push({
          title,
          options: options.map(option =>
            typeof option === "string" ? { label: option } : { label: option.label, description: option.description },
          ),
        });
        return selectResult;
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, notifications, statuses, selectCalls, selectResult };
}

// ─── Session-branch helpers ───────────────────────────────────────────────────

/** A persisted `mode_change` entry (`"plan"`, `"plan_paused"`, `"none"`, …). */
export function modeChangeEntry(mode: string): Record<string, unknown> {
  return { type: "mode_change", mode, data: {} };
}

/** A hidden custom message entry (`plan-mode-context`, `plan-yolo-handoff`, …). */
export function customMessageEntry(customType: string): Record<string, unknown> {
  return { type: "custom_message", customType, content: "custom message body" };
}

// ─── ExtensionAPI fake ───────────────────────────────────────────────────────

export interface RegisteredHandler {
  event: string;
  handler: (...args: unknown[]) => unknown;
}

export interface RegisteredTool {
  name: string;
  definition: Record<string, unknown>;
}

export interface RegisteredFlag {
  name: string;
  options: Record<string, unknown>;
}

export interface RegisteredCommand {
  name: string;
  options: Record<string, unknown>;
}

export interface FakeExtensionApi {
  pi: ExtensionAPI;
  /** Emit a registered event across all handlers; returns the last non-undefined result. */
  emit(event: string, ...args: unknown[]): Promise<unknown>;
  handlers: RegisteredHandler[];
  tools: RegisteredTool[];
  flags: RegisteredFlag[];
  commands: RegisteredCommand[];
  activeTools: string[];
  flagValues: Map<string, boolean | string | undefined>;
  warnings: string[];
  /** Call the execute handler of a registered tool by name. */
  callTool(name: string, toolCallId: string, params: unknown, ctx: ExtensionContext): Promise<unknown>;
}

export function createFakeExtensionApi(): FakeExtensionApi {
  const handlers: RegisteredHandler[] = [];
  const tools: RegisteredTool[] = [];
  const flags: RegisteredFlag[] = [];
  const commands: RegisteredCommand[] = [];
  let activeTools: string[] = [];
  const flagValues = new Map<string, boolean | string | undefined>();
  const warnings: string[] = [];

  async function emit(event: string, ...args: unknown[]): Promise<unknown> {
    let result: unknown;
    for (const h of handlers) {
      if (h.event === event) {
        const r = await (h.handler as (...a: unknown[]) => unknown)(...args);
        if (r !== undefined) result = r;
      }
    }
    return result;
  }

  async function callTool(name: string, toolCallId: string, params: unknown, ctx: ExtensionContext): Promise<unknown> {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`No tool registered with name "${name}"`);
    const exec = tool.definition["execute"] as (
      id: string,
      p: unknown,
      sig: unknown,
      upd: unknown,
      c: ExtensionContext,
    ) => Promise<unknown>;
    return exec(toolCallId, params, undefined, undefined, ctx);
  }

  // Fake pi.pi namespace — AgentRegistry + createAgentSession + SessionManager
  // are the parts writer-session.ts accesses via sdk = pi.pi.
  // Tests override fakePiPi.createAgentSession to inject a fake SDK.
  const fakePiPi = {
    AgentRegistry: class {},
    SessionManager: { inMemory: (_cwd: string) => ({}) },
    createAgentSession: async (_opts: unknown): Promise<{ session: unknown }> => {
      throw new Error("pi.pi.createAgentSession not configured — call injectSdk() in your test");
    },
  };

  const fakePi = {
    logger: {
      warn: (msg: string) => { warnings.push(msg); },
      debug: () => {},
      info: () => {},
      error: () => {},
    },
    zod: z,
    pi: fakePiPi as unknown,
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.push({ event, handler });
    },
    registerTool(def: Record<string, unknown>) {
      tools.push({ name: def["name"] as string, definition: def });
      // Tools with defaultInactive:true start excluded from activeTools
      if (!def["defaultInactive"]) {
        activeTools.push(def["name"] as string);
      }
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      commands.push({ name, options });
    },
    registerFlag(name: string, options: Record<string, unknown>) {
      flags.push({ name, options });
      if (!flagValues.has(name) && options["default"] !== undefined) {
        flagValues.set(name, options["default"] as boolean | string);
      }
    },
    getFlag(name: string): boolean | string | undefined {
      return flagValues.get(name);
    },
    getActiveTools(): string[] {
      return [...activeTools];
    },
    async setActiveTools(names: string[]): Promise<void> {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  return {
    pi: fakePi,
    emit,
    handlers,
    tools,
    flags,
    commands,
    get activeTools() { return activeTools; },
    flagValues,
    warnings,
    callTool,
  };
}

/** Inject a custom fake pi.pi SDK into an already-created FakeExtensionApi. */
export function injectSdk(fakeApi: FakeExtensionApi, sdk: unknown): void {
  (fakeApi.pi as unknown as Record<string, unknown>)["pi"] = sdk;
}
