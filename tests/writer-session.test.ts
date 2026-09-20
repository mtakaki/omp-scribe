import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocBlueprint, PlanBlueprint } from "../src/types";
import { DOC_WRITER_SYSTEM_PROMPT, expandBlueprintToMarkdown, expandDocBlueprintToMarkdown } from "../src/writer-session";
import { createFakeExtensionContext, createFakeExtensionApi, injectSdk } from "./support/fake-extension-api";
import { createFakeSdk, type FakeAgentSession, type FakeSdk, type FakeSessionEvent } from "./support/fake-agent-session";

const BLUEPRINT: PlanBlueprint = {
  slug: "test-plan",
  title: "Test Plan",
  context: "A short context sentence.",
  approach: ["@src/example.ts[1-2]{~}deps()#example_intent"],
  criticalFiles: [],
  verification: ["bun test passes"],
  assumptions: [],
};

function successScript(text: string): FakeSessionEvent[] {
  return [
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } },
    {
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cost: { input: 0.003, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.009 } }, provider: "anthropic", model: "claude-haiku-3-5" },
    },
    { type: "agent_end", isTerminal: true },
  ];
}

/** Wires up a fake SDK and returns the ExtensionAPI and injection helper. */
function makeApiWithSdk(fakeSdk: FakeSdk) {
  const fakeApi = createFakeExtensionApi();
  injectSdk(fakeApi, fakeSdk);
  return fakeApi.pi;
}

describe("expandBlueprintToMarkdown", () => {
  it("returns markdown and usage on success", async () => {
    const { fakeSdk, setScript, lastSessionDisposed } = createFakeSdk();
    setScript(successScript("# Test Plan\n\nContent here."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);

    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Test Plan\n\nContent here.");
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("claude-haiku-3-5");
    expect(result.usage.input).toBe(100);
    expect(result.usage.output).toBe(50);
    expect(result.costUsd).toBeCloseTo(0.009, 8);

    // Session always disposed (finally block)
    expect(lastSessionDisposed()).toBe(true);
  });

  it("accumulates delta chunks across multiple message_update events", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "World" } },
      {
        type: "message_end",
        message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" },
      },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");
    expect(result.markdown).toBe("Hello World");
  });

  it("returns error when writer model spec does not resolve and @smol also fails", async () => {
    const fakeApi = createFakeExtensionApi();
    const { ctx } = createFakeExtensionContext({
      resolveModel: () => undefined, // nothing resolves
    });

    const result = await expandBlueprintToMarkdown(fakeApi.pi, ctx, "nonexistent/model", BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("nonexistent/model");
  });

  it("returns error when writer model returns empty response", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    // Only whitespace delta — should produce empty after trim()
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "   \n  " } },
      {
        type: "message_end",
        message: { role: "assistant", usage: { input: 10, output: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" },
      },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("empty response");
  });

  it("returns error when prompt() rejects", async () => {
    const { fakeSdk } = createFakeSdk();
    // Override createAgentSession to return a session whose prompt() rejects
    fakeSdk.createAgentSession = async (_opts: unknown): Promise<{ session: FakeAgentSession }> => ({
      session: {
        subscribe(_listener: (evt: FakeSessionEvent) => void) {
          return () => {};
        },
        async prompt(_text: string): Promise<void> {
          throw new Error("Network timeout");
        },
        async dispose() {},
        lastPrompt: undefined,
        disposed: false,
      },
    });

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("Network timeout");
  });

  it("always disposes the session, even on error", async () => {
    const { fakeSdk, setScript, lastSessionDisposed } = createFakeSdk();
    // No text delta → empty response error after agent_end
    setScript([
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect(lastSessionDisposed()).toBe(true);
  });

  it("sends a UI notification when ctx.hasUI is true", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Test Plan\n\nSome content."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx, notifications } = createFakeExtensionContext({ hasUI: true });

    await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect(notifications.some(n => n.message.includes("delegating"))).toBe(true);
  });

  it("sends no UI notification when ctx.hasUI is false", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript(successScript("# Test Plan\n\nContent."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx, notifications } = createFakeExtensionContext({ hasUI: false });

    await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect(notifications).toHaveLength(0);
  });

  it("hydrates each step's line range into the labelled brief sent to prompt()", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scribe-writer-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "example.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "utf8");

      const { fakeSdk, setScript, lastSession } = createFakeSdk();
      setScript(successScript("# Test Plan\n\nOK."));

      const pi = makeApiWithSdk(fakeSdk);
      const { ctx } = createFakeExtensionContext({ hasUI: false, cwd: dir });

      await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
      const session = lastSession();
      expect(session).toBeDefined();
      const prompt = session!.lastPrompt!;
      expect(prompt).toContain("TITLE\nTest Plan");
      expect(prompt).toContain(BLUEPRINT.approach[0]!);
      // Only the step's requested range is hydrated, numbered 1-based from the file.
      expect(prompt).toContain("snippet of src/example.ts:\n    1| export const a = 1;\n    2| export const b = 2;");
      expect(prompt).not.toContain("export const c = 3;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve if agent_end has isTerminal:false", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    // isTerminal:false should be ignored; only the terminal agent_end resolves the promise.
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Part1 " } },
      { type: "agent_end", isTerminal: false },   // should NOT resolve the promise
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Part2" } },
      {
        type: "message_end",
        message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" },
      },
      { type: "agent_end", isTerminal: true },    // resolves
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");
    // Both deltas should be accumulated (fake runs all events synchronously in prompt())
    expect(result.markdown).toBe("Part1 Part2");
  });
});

// ─── expandDocBlueprintToMarkdown ─────────────────────────────────────────────

const DOC_BLUEPRINT: DocBlueprint = {
  slug: "test-readme",
  title: "Test README",
  path: "README.md",
  sections: [
    { heading: "Overview", bullets: ["This project does X.", "It also does Y."] },
    { heading: "Usage", bullets: ["Run `bun start`."] },
  ],
};

describe("expandDocBlueprintToMarkdown", () => {
  it("returns markdown and usage on success", async () => {
    const { fakeSdk, setScript, lastSessionDisposed } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "# Test README\n\n## Overview\n\nContent." } },
      {
        type: "message_end",
        message: { role: "assistant", usage: { input: 80, output: 60, cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 } }, provider: "anthropic", model: "claude-haiku-3-5" },
      },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);

    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Test README\n\n## Overview\n\nContent.");
    expect(result.model.provider).toBe("anthropic");
    expect(result.usage.input).toBe(80);
    expect(result.usage.output).toBe(60);
    expect(result.costUsd).toBeCloseTo(0.006, 8);
    expect(lastSessionDisposed()).toBe(true);
  });

  it("sends a UI notification mentioning doc-Markdown when ctx.hasUI is true", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "# Doc" } },
      { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" } },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx, notifications } = createFakeExtensionContext({ hasUI: true });

    await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    expect(notifications.some(n => n.message.includes("doc-Markdown"))).toBe(true);
  });

  it("sends no UI notification when ctx.hasUI is false", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "# Doc" } },
      { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" } },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx, notifications } = createFakeExtensionContext({ hasUI: false });

    await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    expect(notifications).toHaveLength(0);
  });

  it("returns error when writer model spec does not resolve", async () => {
    const fakeApi = createFakeExtensionApi();
    const { ctx } = createFakeExtensionContext({ resolveModel: () => undefined });

    const result = await expandDocBlueprintToMarkdown(fakeApi.pi, ctx, "nonexistent/model", DOC_BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("nonexistent/model");
  });

  it("returns error when writer model returns empty response", async () => {
    const { fakeSdk, setScript } = createFakeSdk();
    setScript([
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("empty response");
  });

  it("sends only title and sections to prompt (omits slug and path)", async () => {
    const { fakeSdk, setScript, lastSession } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "# Doc" } },
      { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, provider: "anthropic", model: "claude-haiku-3-5" } },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    const session = lastSession();
    expect(session).toBeDefined();
    const parsed = JSON.parse(session!.lastPrompt!) as Record<string, unknown>;
    // Payload must carry title and sections
    expect(parsed["title"]).toBe("Test README");
    expect(Array.isArray(parsed["sections"])).toBe(true);
    // Must NOT carry slug or path (metadata only, not needed by writer)
    expect("slug" in parsed).toBe(false);
    expect("path" in parsed).toBe(false);
  });

  it("uses DOC_WRITER_SYSTEM_PROMPT (exported constant is non-empty)", () => {
    expect(typeof DOC_WRITER_SYSTEM_PROMPT).toBe("string");
    expect(DOC_WRITER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(DOC_WRITER_SYSTEM_PROMPT).toContain("sections");
  });
});
