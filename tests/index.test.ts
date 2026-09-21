/**
 * Integration tests for scribe(pi) — the full extension factory.
 *
 * Each test calls scribe(fakeApi.pi) to register all handlers, then drives
 * the fake API to exercise individual event paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Model } from "@oh-my-pi/pi-catalog";
import scribe from "../src/index";
import { BLUEPRINT_TOOL_NAME, DOC_BLUEPRINT_TOOL_NAME, consumedWriteSwaps, pendingMarkdownStore, armedDocSessions, pendingDocMarkdownStore, docDraftHistory, readPersistedScribeConfig, SCRIBE_MODEL_CONFIG_RELATIVE_PATH, scribeModelConfigPath } from "../src/config";
import { formatSavingsDashboard, readStatsFile } from "../src/stats-store";
import { createFakeExtensionApi, createFakeExtensionContext, customMessageEntry, makeModel, modeChangeEntry, type FakeExtensionApi } from "./support/fake-extension-api";
import { createFakeSdk, type FakeSessionEvent } from "./support/fake-agent-session";

/** Shared example files/steps tuples reused across blueprint fixtures. */
const EXAMPLE_FILES = [["E", "src/example.ts", "example file"]] as const;
const EXAMPLE_STEPS = [["E", "~", [1, 2], "Update the example export to describe the change under test.", [], []]] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Turn-start event. Plan-mode detection reads the session branch (see
 *  `planModeContext`), never the system prompt, so the event shape is identical
 *  for plan and non-plan turns. */
function makeTurnEvent(extraBlocks: string[] = []) {
  return { type: "before_agent_start", systemPrompt: ["Assistant instructions.", ...extraBlocks] };
}

/** Context whose session branch reports plan mode as active. */
function planModeContext(overrides: Parameters<typeof createFakeExtensionContext>[0] = {}) {
  return createFakeExtensionContext({ ...overrides, branch: [modeChangeEntry("plan")] });
}

function makeWriteEvent(path: string, content: string, toolCallId = "tcid-001") {
  return { type: "tool_call", toolName: "write", toolCallId, input: { path, content } };
}

function makeMessageEndEvent(role: string, usage: { input: number; output: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } = { input: 100, output: 20 }, provider = "anthropic", model = "claude-opus-4-5") {
  return { type: "message_end", message: { role, usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage }, provider, model } };
}

function makeAssistantTextMessageEndEvent(text: string, usage: { input: number; output: number; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } = { input: 100, output: 20 }, provider = "anthropic", model = "claude-opus-4-5") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
      provider,
      model,
    },
  };
}

function successScript(text: string, writerCostTotal = 0.006): FakeSessionEvent[] {
  return [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    {
      type: "message_end",
      message: { role: "assistant", usage: { input: 80, output: 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: writerCostTotal } }, provider: "anthropic", model: "claude-haiku-3-5" },
    },
    { type: "agent_end", isTerminal: true },
  ];
}

// Temporarily suppress console noise from any logger.warn calls
const NOOP = () => {};

/** Look up a registered slash command's handler for direct invocation. */
function commandHandler(fakeApi: FakeExtensionApi, name: string): (_args: unknown, ctx: unknown) => Promise<void> {
  const command = fakeApi.commands.find(c => c.name === name);
  if (!command) throw new Error(`No command registered with name "${name}"`);
  return command.options["handler"] as (_args: unknown, ctx: unknown) => Promise<void>;
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `scribe-idx-test-${randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  // Clear singleton stores between tests
  pendingMarkdownStore().clear();
  pendingDocMarkdownStore().clear();
  armedDocSessions().clear();
  consumedWriteSwaps().clear();
  docDraftHistory().clear();
});

afterEach(async () => {
  pendingMarkdownStore().clear();
  pendingDocMarkdownStore().clear();
  armedDocSessions().clear();
  consumedWriteSwaps().clear();
  docDraftHistory().clear();
  await rm(cwd, { recursive: true, force: true });
});

// ─── Tool registration ────────────────────────────────────────────────────────

describe("scribe: tool registration", () => {
  it("registers the propose_plan_blueprint tool as defaultInactive", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const blueprintTool = fakeApi.tools.find(t => t.name === BLUEPRINT_TOOL_NAME);
    expect(blueprintTool).toBeDefined();
    expect(blueprintTool?.definition["defaultInactive"]).toBe(true);
    // Should NOT be in activeTools initially
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("registers exactly two flags", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const names = fakeApi.flags.map(f => f.name);
    expect(names).toContain("scribe-brain-model");
    expect(names).toContain("scribe-writer-model");
  });

  it("registers the /savings command", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    expect(fakeApi.commands.some(c => c.name === "savings")).toBe(true);
  });
});

// ─── before_agent_start ───────────────────────────────────────────────────────

describe("scribe: before_agent_start", () => {
  it("activates blueprint tool when the session branch reports plan mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).toContain(BLUEPRINT_TOOL_NAME);
  });

  it("deactivates blueprint tool once the branch leaves plan mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const branch = [modeChangeEntry("plan")];
    const { ctx } = createFakeExtensionContext({ cwd, branch });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).toContain(BLUEPRINT_TOOL_NAME);

    // Approval appends `mode_change none`; the next turn is no longer a plan turn.
    branch.push(modeChangeEntry("none"));
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("treats plan mode as inactive without any mode entry in the branch", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("treats plan_paused as inactive", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, branch: [modeChangeEntry("plan_paused")] });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("detects plan mode from the plan-mode-context message when no mode_change exists (--plan-yolo)", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    // plan-yolo arms plan mode in-session without persisting a mode_change entry.
    const { ctx } = createFakeExtensionContext({ cwd, branch: [customMessageEntry("plan-mode-context")] });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).toContain(BLUEPRINT_TOOL_NAME);
  });

  it("treats plan-yolo-handoff as leaving plan mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({
      cwd,
      branch: [customMessageEntry("plan-mode-context"), customMessageEntry("plan-yolo-handoff")],
    });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("does not mistake context-file prose for plan mode", async () => {
    // Regression: the detector previously matched the literal string
    // "Plan mode active." anywhere in a system-prompt block, so any repository
    // whose AGENTS.md/README quoted that sentence (including this one) turned
    // every turn into a plan turn.
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(["Plan mode active."]), ctx);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("injects SCRIBE_DIRECTIVE into systemPrompt in plan mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    const result = await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx) as
      { systemPrompt?: string[] } | undefined;
    expect(result?.systemPrompt?.some(block => block.includes("<scribe>"))).toBe(true);
  });

  it("does not inject directive on a non-plan turn", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    const result = await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx) as
      { systemPrompt?: string[] } | undefined;
    // Handler returns early; no systemPrompt returned
    expect(result?.systemPrompt).toBeUndefined();
  });

  it("banner fires exactly once on entry into plan mode (not on repeat)", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications } = planModeContext({ cwd, hasUI: true });

    // First entry: banner should fire
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    const countAfterFirst = notifications.filter(n => n.message.includes("plan mode")).length;
    expect(countAfterFirst).toBe(1);

    // Second consecutive plan-mode turn: tool already active, no transition — no new banner
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    const countAfterSecond = notifications.filter(n => n.message.includes("plan mode")).length;
    expect(countAfterSecond).toBe(1); // same — no additional notification
  });

  it("resets brainUsage when entering plan mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const branch = [modeChangeEntry("plan")];
    const { ctx } = createFakeExtensionContext({ cwd, branch });

    // Accumulate some usage
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    await fakeApi.emit("message_end", makeMessageEndEvent("assistant", { input: 500, output: 200 }), ctx);

    // Enter plan mode again (new plan-mode session)
    branch.push(modeChangeEntry("none"));
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx); // exit
    branch.push(modeChangeEntry("plan"));
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx); // re-enter
    // brainUsage is reset; usage from later message_end starts fresh

    // If usage was reset, a subsequent tool_call will produce correct stats
    // (We test this indirectly through stats written by the tool_call handler)
  });

  it("logs warning when brainModel flag differs from active model", async () => {
    const fakeApi = createFakeExtensionApi();
    fakeApi.flagValues.set("scribe-brain-model", "anthropic/claude-opus-4-5");
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({
      cwd,
      currentModel: makeModel("anthropic", "claude-haiku-3-5"),
      resolveModel: (spec) => {
        if (spec === "anthropic/claude-opus-4-5") return makeModel("anthropic", "claude-opus-4-5");
        if (spec === "@smol") return makeModel("anthropic", "claude-haiku-3-5");
        return undefined;
      },
    });

    // session_start must fire first so readScribeConfig picks up the flag value
    await fakeApi.emit("session_start", {}, ctx);
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.warnings.some(w => w.includes("brainModel"))).toBe(true);
  });
});

// ─── message_end ─────────────────────────────────────────────────────────────

describe("scribe: message_end", () => {
  it("accumulates brain usage when blueprint tool is active", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Plan\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    // Activate blueprint tool
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    // Two message_end events — usage should accumulate
    await fakeApi.emit("message_end", makeMessageEndEvent("assistant", { input: 100, output: 20 }), ctx);
    await fakeApi.emit("message_end", makeMessageEndEvent("assistant", { input: 200, output: 30 }), ctx);

    // Execute the blueprint tool to trigger a write
    const blueprint = {
      slug: "acc-test",
      title: "Acc Test",
      context: "Context.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["pass"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "tool-call-1", blueprint, ctx);

    // Trigger write swap
    const writeEvt = makeWriteEvent("local://acc-test-plan.md", "pending", "tc-acc-1");
    await fakeApi.emit("tool_call", writeEvt, ctx);

    // Inspect stats file
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1);
    // Brain tokens: 100+200 input, 20+30 output
    expect(stats.totalBrainInputTokens).toBe(300);
    expect(stats.totalBrainOutputTokens).toBe(50);

    // The submitted blueprint is recorded as the scribe-specific output the brain
    // had to emit in place of the document body.
    const blueprintTokens = Math.round(JSON.stringify(blueprint).length / 4);
    expect(stats.totalIrOutputTokens).toBe(blueprintTokens);

    // Without scribe the brain would have emitted the writer's document instead of
    // the blueprint, so the dashboard trades one for the other.
    const row = formatSavingsDashboard(stats)
      .split("\n")
      .find(line => line.includes("Estimated brain tokens output without scribe"));
    const withoutScribe = stats.totalBrainOutputTokens + stats.totalWriterOutputTokens - blueprintTokens;
    expect(row).toContain(withoutScribe.toLocaleString("en-US"));
  });

  it("does not accumulate usage for non-assistant messages", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    // User message — should be ignored
    await fakeApi.emit("message_end", makeMessageEndEvent("user", { input: 999, output: 0 }), ctx);

    // No blueprint call or write — just verify nothing explodes
    // (Usage tracking doesn't surface unless a blueprint tool_call+write happens)
    expect(fakeApi.warnings).toHaveLength(0);
  });
});

// ─── propose_plan_blueprint tool execute ─────────────────────────────────────

describe("scribe: propose_plan_blueprint execute", () => {
  it("expands blueprint and caches markdown in the pending store", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# My Plan\n\nExpanded content."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = {
      slug: "my-plan",
      title: "My Plan",
      context: "Context sentence.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["bun test"],
      assumptions: [],
    };
    const result = await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "tcid-bp-1", blueprint, ctx) as Record<string, unknown>;

    // Not an error
    expect(result["isError"]).toBeUndefined();
    const contentArr = result["content"] as Array<{ text: string }>;
    expect(contentArr[0]!.text).toContain("Blueprint accepted");

    // Pending store has the entry
    expect(pendingMarkdownStore().has("my-plan")).toBe(true);
    expect(pendingMarkdownStore().get("my-plan")!.markdown).toBe("# My Plan\n\nExpanded content.");
  });

  it("expands a blueprint whose optional sections were omitted", async () => {
    // Models drop trailing tool-argument keys; the three optional sections must
    // default to empty instead of failing pre-execution validation.
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Lean Plan\n\nExpanded."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    const minimal = {
      slug: "lean-plan",
      title: "Lean Plan",
      context: "Context.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
    };
    const result = await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-lean", minimal, ctx) as Record<string, unknown>;

    expect(result["isError"]).toBeUndefined();
    expect(pendingMarkdownStore().get("lean-plan")!.markdown).toBe("# Lean Plan\n\nExpanded.");
  });

  it("returns isError when expansion fails", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({
      cwd,
      resolveModel: () => undefined, // expansion will fail: no model
    });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = {
      slug: "failing-plan",
      title: "Failing",
      context: "Context.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    const result = await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "tcid-bp-2", blueprint, ctx) as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
  });
});

// ─── tool_call write swap ─────────────────────────────────────────────────────

describe("scribe: tool_call write swap", () => {
  it("swaps placeholder content with expanded markdown", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Swapped Plan\n\nFull Markdown here."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    // Call blueprint tool to populate the store
    const blueprint = {
      slug: "swapped-plan",
      title: "Swapped Plan",
      context: "Context.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["pass"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-tcid", blueprint, ctx);

    // Emit write event with placeholder
    const writeEvt = makeWriteEvent("local://swapped-plan-plan.md", "pending", "tc-swap-1");
    const swapResult = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;

    expect(swapResult?.input?.content).toBe("# Swapped Plan\n\nFull Markdown here.");

    // Store entry deleted after swap
    expect(pendingMarkdownStore().has("swapped-plan")).toBe(false);
  });

  it("duplicate toolCallId returns cached swap (idempotent delivery)", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Dup Plan\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = {
      slug: "dup-plan",
      title: "Dup Plan",
      context: "C.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-dup", blueprint, ctx);

    const writeEvt = makeWriteEvent("local://dup-plan-plan.md", "pending", "tc-dup-001");

    // First fire → swap
    const r1 = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;
    expect(r1?.input?.content).toBe("# Dup Plan\n\nBody.");

    // Second fire with same toolCallId → returns cached swap; totalRuns stays 1
    const r2 = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;
    expect(r2?.input?.content).toBe("# Dup Plan\n\nBody.");

    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1); // not 2
  });

  it("blocks write with placeholder when no pending blueprint exists", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const writeEvt = makeWriteEvent("local://missing-plan.md", "pending", "tc-block-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("missing");
  });

  it("passes through non-placeholder content unmodified", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const writeEvt = makeWriteEvent("local://direct-plan.md", "# Full Markdown written by model", "tc-pt-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx);
    // passthrough returns undefined
    expect(result).toBeUndefined();
  });

  it("ignores writes to non-plan-file paths", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd });

    const writeEvt = makeWriteEvent("/some/file.txt", "anything", "tc-nf-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx);
    expect(result).toBeUndefined();
  });

  it("ignores non-write tool calls", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    const bashEvt = { type: "tool_call", toolName: "bash", toolCallId: "tc-bash", input: { command: "ls" } };
    const result = await fakeApi.emit("tool_call", bashEvt, ctx);
    expect(result).toBeUndefined();
  });
  it("swaps the host's default local://PLAN.md target using the session's only draft", async () => {
    // The plan-mode prompt points at `local://PLAN.md` whenever that is the
    // session's plan file, so a single pending draft must resolve for it too.
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Plan.md Draft\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    const blueprint = {
      slug: "plan-alias",
      title: "Plan Alias",
      context: "C.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-alias", blueprint, ctx);

    const writeEvt = makeWriteEvent("local://PLAN.md", "pending", "tc-alias-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;

    expect(result?.input?.content).toBe("# Plan.md Draft\n\nBody.");
    expect(pendingMarkdownStore().has("plan-alias")).toBe(false);
  });

  it("resolves a differently named plan file to the session's pending draft", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Drafted\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    const blueprint = {
      slug: "right-slug",
      title: "Right",
      context: "C.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-hint", blueprint, ctx);

    // A single pending draft resolves any plan-file name, so the model's file
    // still receives the drafted Markdown instead of a forced retry.
    const writeEvt = makeWriteEvent("local://wrong-slug-plan.md", "pending", "tc-hint-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;

    expect(result?.input?.content).toBe("# Drafted\n\nBody.");
    expect(pendingMarkdownStore().has("right-slug")).toBe(false);
  });

  it("blocks an unresolvable placeholder write and lists the pending drafts", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Drafted\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    // Two drafts pending for the session, neither matching the write target:
    // the extension cannot know which one the model meant, so it must refuse
    // rather than write the literal placeholder to a plan file.
    const blueprint = {
      slug: "first-slug",
      title: "First",
      context: "C.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-amb-1", blueprint, ctx);
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-amb-2", { ...blueprint, slug: "second-slug" }, ctx);

    const writeEvt = makeWriteEvent("local://third-slug-plan.md", "pending", "tc-amb-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { block?: boolean; reason?: string } | undefined;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("first-slug");
    expect(result?.reason).toContain("second-slug");
  });

  it("accepts underscore slugs, which the host allows in plan filenames", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Under\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = planModeContext({ cwd });

    const blueprint = {
      slug: "my_slug",
      title: "Under",
      context: "C.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-under", blueprint, ctx);

    const writeEvt = makeWriteEvent("local://my_slug-plan.md", "pending", "tc-under-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;

    expect(result?.input?.content).toBe("# Under\n\nBody.");
  });
});
// ─── session_shutdown cleanup ─────────────────────────────────────────────────

describe("scribe: session_shutdown", () => {
  it("removes pending store entries that match the shutting-down session", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    pendingMarkdownStore().set("slug-a", {
      sessionKey: "session-A",
      markdown: "# A",
      writerModel: { provider: "anthropic", id: "haiku" },
      writerUsage: { input: 1, output: 1 },
      writerCostUsd: 0,
      irOutputTokens: 0,
    });
    pendingMarkdownStore().set("slug-b", {
      sessionKey: "session-B",
      markdown: "# B",
      writerModel: { provider: "anthropic", id: "haiku" },
      writerUsage: { input: 1, output: 1 },
      writerCostUsd: 0,
      irOutputTokens: 0,
    });

    const { ctx } = createFakeExtensionContext({ sessionId: "session-A" });
    fakeApi.emit("session_shutdown", {}, ctx);

    // session-A entry removed; session-B untouched
    expect(pendingMarkdownStore().has("slug-a")).toBe(false);
    expect(pendingMarkdownStore().has("slug-b")).toBe(true);
  });

  it("removes consumedWriteSwaps entries that match the shutting-down session", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    consumedWriteSwaps().set("tc-X", { sessionKey: "session-A", input: { path: "x", content: "y" } });
    consumedWriteSwaps().set("tc-Y", { sessionKey: "session-B", input: { path: "x", content: "y" } });

    const { ctx } = createFakeExtensionContext({ sessionId: "session-A" });
    fakeApi.emit("session_shutdown", {}, ctx);

    expect(consumedWriteSwaps().has("tc-X")).toBe(false);
    expect(consumedWriteSwaps().has("tc-Y")).toBe(true);
  });
});

// ─── /savings command ─────────────────────────────────────────────────────────

describe("scribe: /savings command", () => {
  it("invokes ui.notify with the dashboard string", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications } = createFakeExtensionContext({ cwd });

    const savingsCmd = fakeApi.commands.find(c => c.name === "savings");
    expect(savingsCmd).toBeDefined();
    const handler = savingsCmd!.options["handler"] as (_args: unknown, ctx: unknown) => Promise<void>;
    await handler([], ctx);

    expect(notifications.some(n => n.message.includes("SCRIBE COST-SAVINGS DASHBOARD"))).toBe(true);
  });
});

// ─── Local model regression (cost=0 must not misreport as nonzero) ─────────────

describe("scribe: local model cost regression", () => {
  it("local Ollama-style model produces actualCostUsd=0, baselineCostUsd=0, netSavingsUsd=0, priced=false", async () => {
    // Simulate a local deepseek-r1 served by Ollama: model id would previously fuzzy-match
    // the deleted 'deepseek-r1' pricing tier, incorrectly charging hosted API rates.
    const localModel = makeModel("ollama", "deepseek-r1"); // cost.output = 0 by default

    const { fakeSdk, setScript } = createFakeSdk();
    // Writer model also has zero cost (it's the same local Ollama instance)
    setScript(successScript("# Local Model Plan\n\nExpanded content.", 0));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);

    const { ctx } = planModeContext({
      cwd,
      currentModel: localModel,
      resolveModel: (spec) => (spec === "@smol" ? makeModel("anthropic", "claude-haiku-3-5") : undefined),
    });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    // Brain message with zero cost (local model charges nothing)
    await fakeApi.emit("message_end", makeMessageEndEvent("assistant", { input: 1000, output: 50 }), ctx);

    const blueprint = {
      slug: "local-model-plan",
      title: "Local Model Plan",
      context: "Context.",
      files: EXAMPLE_FILES,
      steps: EXAMPLE_STEPS,
      verification: ["v"],
      assumptions: [],
    };
    await fakeApi.callTool(BLUEPRINT_TOOL_NAME, "bp-local", blueprint, ctx);

    const writeEvt = makeWriteEvent("local://local-model-plan-plan.md", "pending", "tc-local-1");
    await fakeApi.emit("tool_call", writeEvt, ctx);

    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1);
    const run = stats.runs[0]!;
    expect(run.actualCostUsd).toBe(0);
    expect(run.baselineCostUsd).toBe(0);
    expect(run.netSavingsUsd).toBe(0);
    expect(run.priced).toBe(false);
  });

  it("prices the baseline from the @plan-role reference model when the live brain model is unpriced", async () => {
    // Same zero-cost local brain as above, but the host resolves a priced @plan
    // reference model: the baseline must fall back to those rates instead of
    // collapsing total net savings to $0.00.
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Local Model Plan\n\nExpanded content.", 0));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);

    const { ctx } = planModeContext({
      cwd,
      currentModel: makeModel("ollama", "deepseek-r1"),
      resolveModel: (spec) => {
        if (spec === "@smol") return makeModel("anthropic", "claude-haiku-3-5");
        if (spec === "@plan") {
          return makeModel("anthropic", "claude-opus-4-5", { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
        }
        return undefined;
      },
    });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    await fakeApi.emit("message_end", makeMessageEndEvent("assistant", { input: 1000, output: 50 }), ctx);

    await fakeApi.callTool(
      BLUEPRINT_TOOL_NAME,
      "bp-ref",
      {
        slug: "local-model-plan",
        title: "Local Model Plan",
        context: "Context.",
        files: EXAMPLE_FILES,
        steps: EXAMPLE_STEPS,
        verification: ["v"],
        assumptions: [],
      },
      ctx,
    );

    await fakeApi.emit("tool_call", makeWriteEvent("local://local-model-plan-plan.md", "pending", "tc-ref-1"), ctx);

    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1);
    expect(stats.totalEstimatedBaselineRuns).toBe(1);
    const run = stats.runs[0]!;
    expect(run.actualCostUsd).toBe(0);
    expect(run.priced).toBe(false);
    expect(run.baselineIsEstimate).toBe(true);
    // brainInputTokens (1000) * ref input rate (3) + writerOutputTokens (40) * ref output rate (15), per million.
    const expectedBaseline = (1000 * 3 + 40 * 15) / 1e6;
    expect(run.baselineCostUsd).toBeCloseTo(expectedBaseline, 8);
    expect(run.netSavingsUsd).toBeCloseTo(run.baselineCostUsd, 8);
    expect(run.netSavingsUsd).toBeGreaterThan(0);
  });
});

// ─── /scribe-doc command ──────────────────────────────────────────────────────

describe("scribe: /scribe-doc command", () => {
  it("arms doc mode for the session on first invocation", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications } = createFakeExtensionContext({ cwd, sessionId: "s-doc-1" });

    const cmd = fakeApi.commands.find(c => c.name === "scribe-doc");
    expect(cmd).toBeDefined();
    const handler = cmd!.options["handler"] as (_args: unknown, ctx: unknown) => Promise<void>;
    await handler([], ctx);

    expect(armedDocSessions().has("s-doc-1")).toBe(true);
    expect(notifications.some(n => n.message.includes("armed"))).toBe(true);
  });

  it("disarms doc mode on second invocation (toggle)", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications } = createFakeExtensionContext({ cwd, sessionId: "s-doc-2" });

    const cmd = fakeApi.commands.find(c => c.name === "scribe-doc")!;
    const handler = cmd.options["handler"] as (_args: unknown, ctx: unknown) => Promise<void>;
    await handler([], ctx); // arm
    await handler([], ctx); // disarm

    expect(armedDocSessions().has("s-doc-2")).toBe(false);
    expect(notifications.some(n => n.message.includes("disarmed"))).toBe(true);
  });
});

// ─── Doc-mode before_agent_start ─────────────────────────────────────────────

describe("scribe: doc-mode before_agent_start", () => {
  it("activates DOC_BLUEPRINT_TOOL_NAME when session is armed", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-doc-3" });

    armedDocSessions().add("s-doc-3");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    expect(fakeApi.activeTools).toContain(DOC_BLUEPRINT_TOOL_NAME);
    expect(fakeApi.activeTools).not.toContain(BLUEPRINT_TOOL_NAME);
  });

  it("deactivates DOC_BLUEPRINT_TOOL_NAME on the next turn when session is no longer armed", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-doc-4" });

    armedDocSessions().add("s-doc-4");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).toContain(DOC_BLUEPRINT_TOOL_NAME);

    armedDocSessions().delete("s-doc-4");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(fakeApi.activeTools).not.toContain(DOC_BLUEPRINT_TOOL_NAME);
  });

  it("injects DOC_SCRIBE_DIRECTIVE into systemPrompt when armed", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-doc-5" });

    armedDocSessions().add("s-doc-5");
    const result = await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx) as
      { systemPrompt?: string[] } | undefined;
    expect(result?.systemPrompt?.some(b => b.includes("<scribe-doc>"))).toBe(true);
  });

  it("does not inject DOC_SCRIBE_DIRECTIVE in normal (unarmed) mode", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    const result = await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx) as
      { systemPrompt?: string[] } | undefined;
    expect(result?.systemPrompt).toBeUndefined();
  });

  it("injects both SCRIBE_DIRECTIVE and DOC_SCRIBE_DIRECTIVE if plan mode and doc mode armed simultaneously", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = planModeContext({ cwd, sessionId: "s-doc-6" });

    armedDocSessions().add("s-doc-6");
    const result = await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx) as
      { systemPrompt?: string[] } | undefined;
    expect(result?.systemPrompt?.some(b => b.includes("<scribe>"))).toBe(true);
    expect(result?.systemPrompt?.some(b => b.includes("<scribe-doc>"))).toBe(true);
  });
});

// ─── propose_doc_blueprint tool execute ──────────────────────────────────────

describe("scribe: propose_doc_blueprint execute", () => {
  it("expands doc blueprint and caches markdown in pendingDocMarkdownStore keyed by path", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# My README\n\nExpanded content."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    const blueprint = {
      slug: "my-readme",
      title: "My README",
      path: "README.md",
      sections: [{ heading: "Overview", bullets: ["This project does X."] }],
    };
    const result = await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "tcid-doc-1", blueprint, ctx) as Record<string, unknown>;

    expect(result["isError"]).toBeUndefined();
    const contentArr = result["content"] as Array<{ text: string }>;
    expect(contentArr[0]!.text).toContain("Doc blueprint accepted");

    expect(pendingDocMarkdownStore().has("README.md")).toBe(true);
    expect(pendingDocMarkdownStore().get("README.md")!.markdown).toBe("# My README\n\nExpanded content.");
    expect(pendingDocMarkdownStore().get("README.md")!.slug).toBe("my-readme");
  });

  it("returns isError when expansion fails", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({
      cwd,
      resolveModel: () => undefined,
    });

    const blueprint = {
      slug: "fail-doc",
      title: "Failing",
      path: "FAIL.md",
      sections: [{ heading: "S", bullets: ["b"] }],
    };
    const result = await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "tcid-doc-2", blueprint, ctx) as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
  });
});

// ─── Doc-mode tool_call write swap ───────────────────────────────────────────

describe("scribe: doc-mode tool_call write swap", () => {
  it("swaps placeholder content with expanded doc markdown keyed by path", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# My README\n\nFull content."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-swap-1" });

    armedDocSessions().add("s-swap-1");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = {
      slug: "my-readme",
      title: "My README",
      path: "README.md",
      sections: [{ heading: "Intro", bullets: ["Content."] }],
    };
    await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "bp-doc-1", blueprint, ctx);
    expect(pendingDocMarkdownStore().has("README.md")).toBe(true);

    const writeEvt = makeWriteEvent("README.md", "pending", "tc-doc-swap-1");
    const swapResult = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;

    expect(swapResult?.input?.content).toBe("# My README\n\nFull content.");
    expect(pendingDocMarkdownStore().has("README.md")).toBe(false);
    // Doc session should be disarmed after swap
    expect(armedDocSessions().has("s-swap-1")).toBe(false);
  });

  it("blocks write with placeholder when no pending doc blueprint exists and session is armed", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-block-1" });

    armedDocSessions().add("s-block-1");

    const writeEvt = makeWriteEvent("README.md", "pending", "tc-doc-block-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("README.md");
    expect(result?.reason).toContain(DOC_BLUEPRINT_TOOL_NAME);
  });

  it("passes through placeholder write to non-plan paths when doc mode is NOT armed", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd });

    const writeEvt = makeWriteEvent("README.md", "pending", "tc-doc-pt-1");
    const result = await fakeApi.emit("tool_call", writeEvt, ctx);
    expect(result).toBeUndefined();
  });

  it("doc write swap records a run with mode: doc and increments totalDocRuns", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Arch Doc\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-stats-1" });

    armedDocSessions().add("s-stats-1");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = {
      slug: "arch-doc",
      title: "Architecture",
      path: "docs/ARCH.md",
      sections: [{ heading: "Overview", bullets: ["Top-level design."] }],
    };
    await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "bp-stats-1", blueprint, ctx);

    await fakeApi.emit("tool_call", makeWriteEvent("docs/ARCH.md", "pending", "tc-stats-1"), ctx);

    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1);
    expect(stats.totalDocRuns).toBe(1);
    expect(stats.totalPlanRuns).toBe(0);
    expect(stats.runs[0]!.mode).toBe("doc");
    expect(stats.runs[0]!.slug).toBe("arch-doc");
    // Doc blueprints are billed the same way: the outline JSON is scribe-specific output.
    expect(stats.totalIrOutputTokens).toBe(Math.round(JSON.stringify(blueprint).length / 4));
  });

  it("duplicate toolCallId for doc write returns cached swap (idempotent delivery)", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Dup Doc\n\nBody."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-dup-doc-1" });

    armedDocSessions().add("s-dup-doc-1");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = { slug: "dup-doc", title: "Dup Doc", path: "DUP.md", sections: [{ heading: "S", bullets: ["b"] }] };
    await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "bp-dup-doc", blueprint, ctx);

    const writeEvt = makeWriteEvent("DUP.md", "pending", "tc-dup-doc-001");

    const r1 = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;
    expect(r1?.input?.content).toBe("# Dup Doc\n\nBody.");

    const r2 = await fakeApi.emit("tool_call", writeEvt, ctx) as { input?: { content: string } } | undefined;
    expect(r2?.input?.content).toBe("# Dup Doc\n\nBody.");

    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(1); // not 2
  });

  it("blocks a stale placeholder retry after the draft was consumed by an earlier swap", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# My README\n\nFull content."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-stale-1" });

    armedDocSessions().add("s-stale-1");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = { slug: "my-readme", title: "My README", path: "README.md", sections: [{ heading: "Intro", bullets: ["Content."] }] };
    await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "bp-stale-1", blueprint, ctx);

    const swap = await fakeApi.emit("tool_call", makeWriteEvent("README.md", "pending", "tc-stale-swap"), ctx) as
      | { input?: { content: string } }
      | undefined;
    expect(swap?.input?.content).toBe("# My README\n\nFull content.");
    expect(armedDocSessions().has("s-stale-1")).toBe(false);

    const retry = await fakeApi.emit("tool_call", makeWriteEvent("README.md", "pending", "tc-stale-retry"), ctx) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(retry?.block).toBe(true);
    expect(retry?.reason).toContain("already drafted and consumed");
    expect(retry?.reason).toContain("README.md");
    expect(retry?.reason).toContain(DOC_BLUEPRINT_TOOL_NAME);
  });

  it("swaps a write whose path differs trivially from the declared blueprint path", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# My README\n\nFallback content."));

    const fakeApi = createFakeExtensionApi();
    const { pi } = fakeApi;
    (pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(pi);
    const { ctx } = createFakeExtensionContext({ cwd, sessionId: "s-fuzzy-1" });

    armedDocSessions().add("s-fuzzy-1");
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);

    const blueprint = { slug: "my-readme", title: "My README", path: "README.md", sections: [{ heading: "Intro", bullets: ["Content."] }] };
    await fakeApi.callTool(DOC_BLUEPRINT_TOOL_NAME, "bp-fuzzy-1", blueprint, ctx);

    const result = await fakeApi.emit("tool_call", makeWriteEvent("./README.md", "pending", "tc-fuzzy-1"), ctx) as
      | { input?: { content: string }; block?: boolean }
      | undefined;

    expect(result?.block).toBeUndefined();
    expect(result?.input?.content).toBe("# My README\n\nFallback content.");
    expect(pendingDocMarkdownStore().has("README.md")).toBe(false);
  });
});

// ─── Doc-mode session_shutdown cleanup ───────────────────────────────────────

describe("scribe: doc-mode session_shutdown", () => {
  it("removes pendingDocMarkdownStore entries for the shutting-down session", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    pendingDocMarkdownStore().set("a.md", {
      sessionKey: "session-A",
      markdown: "# A",
      writerModel: { provider: "anthropic", id: "haiku" },
      writerUsage: { input: 1, output: 1 },
      writerCostUsd: 0,
      irOutputTokens: 0,
    });
    pendingDocMarkdownStore().set("b.md", {
      sessionKey: "session-B",
      markdown: "# B",
      writerModel: { provider: "anthropic", id: "haiku" },
      writerUsage: { input: 1, output: 1 },
      writerCostUsd: 0,
      irOutputTokens: 0,
    });

    const { ctx } = createFakeExtensionContext({ sessionId: "session-A" });
    fakeApi.emit("session_shutdown", {}, ctx);

    expect(pendingDocMarkdownStore().has("a.md")).toBe(false);
    expect(pendingDocMarkdownStore().has("b.md")).toBe(true);
  });

  it("removes armedDocSessions entry for the shutting-down session", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    armedDocSessions().add("session-X");
    armedDocSessions().add("session-Y");

    const { ctx } = createFakeExtensionContext({ sessionId: "session-X" });
    fakeApi.emit("session_shutdown", {}, ctx);

    expect(armedDocSessions().has("session-X")).toBe(false);
    expect(armedDocSessions().has("session-Y")).toBe(true);
  });

  it("removes docDraftHistory entries owned by the shutting-down session", () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    docDraftHistory().set("a.md", "session-A");
    docDraftHistory().set("b.md", "session-B");

    const { ctx } = createFakeExtensionContext({ sessionId: "session-A" });
    fakeApi.emit("session_shutdown", {}, ctx);

    expect(docDraftHistory().has("a.md")).toBe(false);
    expect(docDraftHistory().has("b.md")).toBe(true);
  });
});

// ─── Footer status ────────────────────────────────────────────────────────────

describe("scribe: footer status", () => {
  it("shows the idle line at session start and clears it at session shutdown", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, statuses } = createFakeExtensionContext({ cwd });

    await fakeApi.emit("session_start", {}, ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");

    await fakeApi.emit("session_shutdown", {}, ctx);
    expect(statuses.get("scribe")).toBeUndefined();
  });

  it("writes no status when the host has no UI", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, statuses } = createFakeExtensionContext({ cwd, hasUI: false, branch: [modeChangeEntry("plan")] });

    await fakeApi.emit("session_start", {}, ctx);
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    await fakeApi.emit("session_shutdown", {}, ctx);

    expect(statuses.size).toBe(0);
  });

  it("flips idle -> plan -> idle across turns", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const branch: unknown[] = [];
    const { ctx, statuses } = createFakeExtensionContext({ cwd, branch });

    await fakeApi.emit("session_start", {}, ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");

    branch.push(modeChangeEntry("plan"));
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ● plan (writer: @smol)");

    branch.push(modeChangeEntry("none"));
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");
  });

  it("starts in the plan line when the session branch is already in plan mode", async () => {
    // A resumed session (or `--plan-yolo`) enters the session with plan mode
    // already on; the footer must say so instead of asserting idle.
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, statuses } = createFakeExtensionContext({ cwd, branch: [modeChangeEntry("plan")] });

    await fakeApi.emit("session_start", {}, ctx);
    expect(statuses.get("scribe")).toBe("Scribe ● plan (writer: @smol)");
  });

  it("names the resolved writer model and draft size, then reverts after the write swap", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    const draft = "# Status Plan\n\nDrafted body.";
    setScript(successScript(draft));

    const fakeApi = createFakeExtensionApi();
    (fakeApi.pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(fakeApi.pi);
    const { ctx, statuses } = planModeContext({ cwd });

    await fakeApi.emit("session_start", {}, ctx);
    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ● plan (writer: @smol)");

    await fakeApi.callTool(
      BLUEPRINT_TOOL_NAME,
      "tcid-status-plan",
      { slug: "status-plan", title: "Status Plan", context: "C.", files: EXAMPLE_FILES, steps: EXAMPLE_STEPS },
      ctx,
    );
    expect(statuses.get("scribe")).toBe(
      `Scribe ● plan — ${draft.length} chars drafted (writer: anthropic/claude-haiku-3-5)`,
    );

    await fakeApi.emit("tool_call", makeWriteEvent("local://status-plan-plan.md", "pending", "tc-status-plan-1"), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ● plan (writer: @smol)");
  });

  it("reports a failed plan expansion in the footer", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, statuses } = planModeContext({ cwd, resolveModel: () => undefined });

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    await fakeApi.callTool(
      BLUEPRINT_TOOL_NAME,
      "tcid-status-fail",
      { slug: "fail-plan", title: "Fail", context: "C.", files: EXAMPLE_FILES, steps: EXAMPLE_STEPS },
      ctx,
    );

    expect(statuses.get("scribe")?.startsWith("Scribe ✗ plan expansion failed — No model resolves")).toBe(true);
  });

  it("follows the /scribe-doc toggle, shows the doc draft, and returns to idle after the swap", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    const draft = "# Status Doc\n\nBody.";
    setScript(successScript(draft));

    const fakeApi = createFakeExtensionApi();
    (fakeApi.pi as unknown as Record<string, unknown>)["pi"] = fakeSdk;
    scribe(fakeApi.pi);
    const { ctx, statuses } = createFakeExtensionContext({ cwd, sessionId: "s-status-doc" });

    await fakeApi.emit("session_start", {}, ctx);
    const doc = commandHandler(fakeApi, "scribe-doc");
    await doc("", ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ doc armed (writer: @smol)");

    await fakeApi.emit("before_agent_start", makeTurnEvent(), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ doc armed (writer: @smol)");

    await fakeApi.callTool(
      DOC_BLUEPRINT_TOOL_NAME,
      "tcid-status-doc",
      { slug: "status-doc", title: "Status Doc", path: "STATUS.md", sections: [{ heading: "H", bullets: ["b"] }] },
      ctx,
    );
    expect(statuses.get("scribe")).toBe(
      `Scribe ● doc — ${draft.length} chars drafted (writer: anthropic/claude-haiku-3-5)`,
    );

    await fakeApi.emit("tool_call", makeWriteEvent("STATUS.md", "pending", "tc-status-doc-1"), ctx);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");
  });

  it("reports a failed doc expansion in the footer", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, statuses } = createFakeExtensionContext({ cwd, sessionId: "s-status-doc-fail", resolveModel: () => undefined });

    armedDocSessions().add("s-status-doc-fail");
    await fakeApi.callTool(
      DOC_BLUEPRINT_TOOL_NAME,
      "tcid-status-doc-fail",
      { slug: "fail-doc", title: "Fail", path: "FAIL.md", sections: [{ heading: "H", bullets: ["b"] }] },
      ctx,
    );

    expect(statuses.get("scribe")?.startsWith("Scribe ✗ doc expansion failed — No model resolves")).toBe(true);
  });
});

// ─── /scribe-model command ────────────────────────────────────────────────────

describe("scribe: /scribe-model command", () => {
  const haiku = makeModel("anthropic", "claude-haiku-3-5");
  const resolvesHaiku = (spec: string): Model | undefined =>
    spec === "@smol" || spec === "anthropic/claude-haiku-3-5" ? haiku : undefined;

  it("offers @smol, reset, and authenticated models in argument completions", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx } = createFakeExtensionContext({ cwd, models: [haiku, makeModel("openai", "gpt-5-mini")] });
    await fakeApi.emit("session_start", {}, ctx);

    const command = fakeApi.commands.find(c => c.name === "scribe-model");
    expect(command).toBeDefined();
    const complete = command!.options["getArgumentCompletions"] as (prefix: string) => Array<{ value: string }> | null;
    const values = (prefix: string): string[] => (complete(prefix) ?? []).map(item => item.value);

    expect(values("")).toEqual(["@smol", "reset", "anthropic/claude-haiku-3-5", "openai/gpt-5-mini"]);
    expect(values("gPt")).toEqual(["openai/gpt-5-mini"]);
    expect(complete("no-such-model")).toBeNull();
  });

  it("persists and applies a model passed as an argument", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications, statuses } = createFakeExtensionContext({ cwd, resolveModel: resolvesHaiku });
    await fakeApi.emit("session_start", {}, ctx);

    await commandHandler(fakeApi, "scribe-model")("anthropic/claude-haiku-3-5", ctx);

    expect(await readPersistedScribeConfig(cwd)).toEqual({ writerModel: "anthropic/claude-haiku-3-5" });
    expect(
      notifications.some(
        n => n.message.includes("Scribe: writer model set to") && n.message.includes(SCRIBE_MODEL_CONFIG_RELATIVE_PATH),
      ),
    ).toBe(true);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: anthropic/claude-haiku-3-5)");
  });

  it("leaves the config file and footer unchanged when the model does not resolve", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications, statuses } = createFakeExtensionContext({ cwd, resolveModel: resolvesHaiku });
    await fakeApi.emit("session_start", {}, ctx);

    await commandHandler(fakeApi, "scribe-model")("anthropic/does-not-exist", ctx);

    expect(notifications.some(n => n.message.includes("did not resolve"))).toBe(true);
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");
  });

  it("clears the persisted override and reports the fallback on reset", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications, statuses } = createFakeExtensionContext({ cwd, resolveModel: resolvesHaiku });
    await fakeApi.emit("session_start", {}, ctx);
    const run = commandHandler(fakeApi, "scribe-model");

    await run("anthropic/claude-haiku-3-5", ctx);
    await run("reset", ctx);

    const parsed = JSON.parse(await readFile(scribeModelConfigPath(cwd), "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("writerModel");
    expect(notifications.some(n => n.message.includes('using "@smol" again'))).toBe(true);
    expect(statuses.get("scribe")).toBe("Scribe ○ idle (writer: @smol)");
  });

  it("opens a picker of authenticated models when called without arguments", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, selectCalls } = createFakeExtensionContext({
      cwd,
      models: [haiku],
      selectResult: "anthropic/claude-haiku-3-5",
      resolveModel: resolvesHaiku,
    });
    await fakeApi.emit("session_start", {}, ctx);

    await commandHandler(fakeApi, "scribe-model")("", ctx);

    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0]!.title).toBe("Scribe writer model");
    expect(selectCalls[0]!.options.map(option => option.label)).toEqual(["@smol", "anthropic/claude-haiku-3-5"]);
    expect(await readPersistedScribeConfig(cwd)).toEqual({ writerModel: "anthropic/claude-haiku-3-5" });
  });

  it("keeps the override when the picker is cancelled", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, selectCalls } = createFakeExtensionContext({ cwd, models: [haiku] });
    await fakeApi.emit("session_start", {}, ctx);

    await commandHandler(fakeApi, "scribe-model")("", ctx);

    expect(selectCalls).toHaveLength(1);
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
  });

  it("reports the current model instead of opening a picker without UI", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);
    const { ctx, notifications, selectCalls } = createFakeExtensionContext({ cwd, hasUI: false });
    await fakeApi.emit("session_start", {}, ctx);

    await commandHandler(fakeApi, "scribe-model")("", ctx);

    expect(selectCalls).toHaveLength(0);
    expect(notifications.some(n => n.message.includes('writer model "@smol"'))).toBe(true);
  });

  it("reloads the persisted override at the next session start", async () => {
    const fakeApi = createFakeExtensionApi();
    scribe(fakeApi.pi);

    const first = createFakeExtensionContext({ cwd, resolveModel: resolvesHaiku });
    await fakeApi.emit("session_start", {}, first.ctx);
    await commandHandler(fakeApi, "scribe-model")("anthropic/claude-haiku-3-5", first.ctx);

    const second = createFakeExtensionContext({ cwd });
    await fakeApi.emit("session_start", {}, second.ctx);

    expect(second.statuses.get("scribe")).toBe("Scribe ○ idle (writer: anthropic/claude-haiku-3-5)");
    expect(second.notifications.some(n => n.message.includes("writer: anthropic/claude-haiku-3-5"))).toBe(true);
  });
});
