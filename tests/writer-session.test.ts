import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocBlueprint, PlanBlueprint } from "../src/types";
import {
  DOC_WRITER_SYSTEM_PROMPT,
  expandBlueprintToMarkdown,
  expandDocBlueprintToMarkdown,
  expandPlanUpdateToMarkdown,
} from "../src/writer-session";
import { splitPlanSections } from "../src/plan-sections";
import { createFakeExtensionContext, createFakeExtensionApi, injectSdk } from "./support/fake-extension-api";
import { createFakeSdk, type FakeAgentSession, type FakeSdk, type FakeSessionEvent } from "./support/fake-agent-session";

const BLUEPRINT: PlanBlueprint = {
  slug: "test-plan",
  title: "Test Plan",
  context: "A short context sentence.",
  files: [["E", "src/example.ts", "example file"]],
  steps: [["E", "~", [1, 2], "Update the example export to describe the change under test.", [], []]],
  verification: ["bun test passes"],
  assumptions: [],
};

/** A blueprint whose step intent names two literals — a path and a backticked
 *  identifier — so the drafts below can drop one and give the gate something to
 *  repair. */
const LOSSY_BLUEPRINT: PlanBlueprint = {
  slug: "lossy-plan",
  title: "Lossy Plan",
  context: "A lossy context sentence.",
  files: [["L", "src/lossy.ts", "lossy file"]],
  steps: [["L", "~", [1, 2], "Rename the helper to `deriveVariantKey` in src/lossy.ts.", [], []]],
  verification: [],
  assumptions: [],
};

/** The draft a paraphrasing writer returns for {@link LOSSY_BLUEPRINT}: it
 *  keeps the path and loses the identifier.  `## Context` follows `## Approach`
 *  so each section's raw slice ends with the blank line a splice reproduces
 *  byte-for-byte — which is what makes "the untouched section is untouched"
 *  testable. */
const LOSSY_DRAFT = `# Lossy Plan

## Context

A lossy context sentence.

## Approach

- Update src/lossy.ts to rename the helper.

## Verification

- \`bun test\` passes.
`;

/** The repair response that restores the dropped identifier. */
const REPAIRED_APPROACH = `## Approach

- Rename the helper to \`deriveVariantKey\` in src/lossy.ts.
`;

/** {@link LOSSY_DRAFT} with the dropped identifier appended as a literal-only
 *  line — the shape that satisfies a literal check without stating anything,
 *  which the gate must strip from a draft and refuse from a repair. */
const DUMPED_DRAFT = LOSSY_DRAFT.replace(
  "- Update src/lossy.ts to rename the helper.\n",
  "- Update src/lossy.ts to rename the helper.\n- `deriveVariantKey`\n",
);

/** The `## Verification` section a compliant update writer returns for the delta
 *  used in the update-path case below: the delta's bullet, plus the one already
 *  on the plan. */
const REPAIRED_VERIFICATION = `## Verification

- \`bun test tests/auth.test.ts\` passes
- \`bun test tests/auth-refresh.test.ts\` passes
`;

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

  it("recovers markdown from a whole message_end.message.content when no text_delta events fire", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
    setScript([
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "# Recovered\n\nBody." }],
          usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          provider: "anthropic",
          model: "claude-haiku-3-5",
        },
      },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Recovered\n\nBody.");
    expect(sessionCount()).toBe(1);
  });

  it("prefers the message_end content text over streamed deltas instead of concatenating both", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
    setScript([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "   \n  " } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "# Same\n\nText." }],
          usage: { input: 10, output: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          provider: "anthropic",
          model: "claude-haiku-3-5",
        },
      },
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Same\n\nText.");
    expect(sessionCount()).toBe(1);
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

  it("returns error when writer model returns empty response, after retrying once", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
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
    // The empty script applies to every created session, so both the first
    // attempt and the retry fail; the retry still fired a second session.
    expect(sessionCount()).toBe(2);
  });

  it("retries once and returns markdown when the first attempt returns an empty response", async () => {
    const { fakeSdk, queueScripts, sessionCount, allSessions } = createFakeSdk();
    queueScripts([{ type: "agent_end", isTerminal: true }], successScript("# Test Plan\n\nRecovered."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Test Plan\n\nRecovered.");
    expect(sessionCount()).toBe(2);
    for (const session of allSessions()) {
      expect(session.disposed).toBe(true);
    }
  });

  it("passes thinkingLevel off to the nested writer session", async () => {
    const { fakeSdk, setScript, lastOptions } = createFakeSdk();
    setScript(successScript("# Test Plan\n\nContent here."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    await expandBlueprintToMarkdown(pi, ctx, "@smol", BLUEPRINT);
    // Fake SDK options are opaque `unknown`; we control the fake and know this shape.
    const capturedOptions = lastOptions() as { thinkingLevel?: string };
    expect(capturedOptions.thinkingLevel).toBe("off");
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
      expect(prompt).toContain("1. src/example.ts");
      expect(prompt).toContain("operation: modify");
      expect(prompt).toContain("lines: 1-2");
      expect(prompt).toContain("intent: Update the example export to describe the change under test.");
      // Only the step's requested range is hydrated, numbered 1-based from the file, indented under "source:".
      expect(prompt).toContain("source:\n          1| export const a = 1;\n          2| export const b = 2;");
      expect(prompt).not.toContain("export const c = 3;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prints each file's operation in the FILES block, from the steps that reference it", async () => {
    const { fakeSdk, setScript, lastSession } = createFakeSdk();
    setScript(successScript("# Operation Plan\n\nOK."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const blueprint: PlanBlueprint = {
      slug: "operation-plan",
      title: "Operation Plan",
      context: "Touch two files and name a third.",
      files: [
        ["E", "src/example.ts", "modified file"],
        ["N", "src/new.ts", "brand-new module"],
        ["P", "src/plain.ts", "referenced by no step"],
      ],
      steps: [
        ["E", "~", [1, 2], "Update the example export.", [], []],
        ["N", "+", null, "Author the new module.", [], []],
      ],
      verification: [],
      assumptions: [],
    };

    await expandBlueprintToMarkdown(pi, ctx, "@smol", blueprint);
    const prompt = lastSession()!.lastPrompt ?? "";

    expect(prompt).toContain("- src/example.ts — modify — modified file");
    expect(prompt).toContain("- src/new.ts — add (new file) — brand-new module");
    // A file no step references has no operation to state.
    expect(prompt).toContain("- src/plain.ts — referenced by no step");
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

// ─── Literal fidelity ─────────────────────────────────────────────────────────

describe("literal fidelity", () => {
  it("repairs a lossy draft, splices only the flagged section, and accumulates usage", async () => {
    const { fakeSdk, queueScripts, setScript, sessionCount } = createFakeSdk();
    // The shared script is the compliant one, so a third session (which would
    // mean the gate ran a round it should not have) cannot hang the test.
    setScript(successScript(REPAIRED_APPROACH));
    queueScripts(successScript(LOSSY_DRAFT), successScript(REPAIRED_APPROACH));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");

    expect(result.fidelity?.repaired).toBe(true);
    expect(result.fidelity?.missing).toEqual([]);
    expect(result.fidelity?.checked).toBe(2);
    expect(result.markdown).toContain("`deriveVariantKey`");
    // The gate only splices what it flagged: every other section keeps its bytes.
    const [draftContext, repairedContext] = [LOSSY_DRAFT, result.markdown].map(
      text => splitPlanSections(text).sections.find(section => section.heading === "Context")?.text,
    );
    expect(repairedContext).toBe(draftContext);
    // The repair session's tokens and dollars are added, never reset.
    expect(result.usage.input).toBe(200);
    expect(result.usage.output).toBe(100);
    expect(result.costUsd).toBeCloseTo(0.018, 8);
    expect(sessionCount()).toBe(2);
  });

  it("strips a literal-only line from the draft before judging it", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
    // The dump is what every session returns, so the repair cannot close the gap.
    setScript(successScript(DUMPED_DRAFT));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");

    // The chip is gone, so the identifier counts as lost rather than carried.
    expect(result.markdown).not.toContain("- `deriveVariantKey`");
    expect(result.markdown).toContain("- Update src/lossy.ts to rename the helper.");
    expect(result.fidelity?.missing).toEqual(["deriveVariantKey"]);
    expect(result.fidelity?.repaired).toBe(true);
    expect(sessionCount()).toBe(2);
  });

  it("refuses a repair that answers with a literal-only line", async () => {
    const { fakeSdk, queueScripts, setScript, sessionCount } = createFakeSdk();
    setScript(successScript(DUMPED_DRAFT));
    queueScripts(successScript(LOSSY_DRAFT), successScript(DUMPED_DRAFT));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");

    // The dump is never spliced: the plan keeps the draft's own prose, and the
    // round that changed nothing ends the loop.
    expect(result.markdown).toBe(LOSSY_DRAFT.trimEnd());
    expect(result.fidelity?.missing).toEqual(["deriveVariantKey"]);
    expect(result.fidelity?.repaired).toBe(true);
    expect(sessionCount()).toBe(2);
  });

  it("reports the repair outcome once, after the last round", async () => {
    const { fakeSdk, queueScripts, setScript } = createFakeSdk();
    setScript(successScript(REPAIRED_APPROACH));
    queueScripts(successScript(LOSSY_DRAFT), successScript(REPAIRED_APPROACH));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx, notifications } = createFakeExtensionContext({ hasUI: true });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");

    expect(result.fidelity?.missing).toEqual([]);
    const restored = notifications.filter(n => n.message.includes("restored them verbatim"));
    expect(restored).toHaveLength(1);
    expect(restored[0]!.message).toContain("dropped 1 load-bearing literal");
    // The pre-repair warning is gone: the gate reports the outcome, not a plan.
    expect(notifications.some(n => n.message.includes("paraphrased"))).toBe(false);
  });

  it("reports the residue and keeps the draft when the repair rounds stay lossy", async () => {
    const { fakeSdk, queueScripts, setScript, sessionCount } = createFakeSdk();
    const lossy = successScript(LOSSY_DRAFT);
    setScript(lossy);
    // One initial draft plus one repair that splices its own unchanged section,
    // which is what ends the loop.
    queueScripts(lossy, lossy);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");

    expect(result.fidelity?.repaired).toBe(true);
    expect(result.fidelity?.missing).toEqual(["deriveVariantKey"]);
    // The writer's response is trimmed before use, so the draft under discussion
    // is the trimmed text; the section the gate could not fix is still byte-for-
    // byte the section it started with.
    expect(result.markdown).toBe(LOSSY_DRAFT.trimEnd());
    expect(sessionCount()).toBe(2);
  });

  it("spends no repair session when the draft keeps every literal", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
    setScript(successScript(LOSSY_DRAFT.replace("- Update src/lossy.ts to rename the helper.", "- Rename the helper to `deriveVariantKey` in src/lossy.ts.")));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandBlueprintToMarkdown(pi, ctx, "@smol", LOSSY_BLUEPRINT);
    if (!("markdown" in result)) throw new Error("Expected markdown");

    expect(result.fidelity?.checked).toBeGreaterThan(0);
    expect(result.fidelity?.missing).toEqual([]);
    expect(result.fidelity?.repaired).toBe(false);
    expect(result.fidelity?.missingSections).toEqual(["Critical files & anchors"]);
    expect(sessionCount()).toBe(1);
  });

  it("rewrites a delta's section again when the writer drops one of the delta's literals", async () => {
    const { fakeSdk, queueScripts, setScript, sessionCount } = createFakeSdk();
    const lossy = successScript("## Verification\n\n- The refresh tests pass.\n");
    setScript(lossy);
    queueScripts(lossy, successScript(REPAIRED_VERIFICATION));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandPlanUpdateToMarkdown(
      pi,
      ctx,
      "@smol",
      { slug: "auth-refresh", verification: ["`bun test tests/auth-refresh.test.ts` passes"] },
      splitPlanSections("## Verification\n\n- `bun test tests/auth.test.ts` passes\n"),
    );
    if (!("markdown" in result)) throw new Error("Expected markdown");

    expect(result.fidelity?.repaired).toBe(true);
    expect(result.fidelity?.missing).toEqual([]);
    expect(result.markdown).toContain("`bun test tests/auth-refresh.test.ts`");
    expect(sessionCount()).toBe(2);
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

  it("returns error when writer model returns empty response, after retrying once", async () => {
    const { fakeSdk, setScript, sessionCount } = createFakeSdk();
    setScript([
      { type: "agent_end", isTerminal: true },
    ]);

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("unreachable");
    expect(result.error).toContain("empty response");
    // The empty script applies to every created session, so both the first
    // attempt and the retry fail; the retry still fired a second session.
    expect(sessionCount()).toBe(2);
  });

  it("retries once and returns markdown when the first attempt returns an empty response", async () => {
    const { fakeSdk, queueScripts, sessionCount, allSessions } = createFakeSdk();
    queueScripts([{ type: "agent_end", isTerminal: true }], successScript("# Test README\n\nRecovered."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    const result = await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    expect("markdown" in result).toBe(true);
    if (!("markdown" in result)) throw new Error("unreachable");
    expect(result.markdown).toBe("# Test README\n\nRecovered.");
    expect(sessionCount()).toBe(2);
    for (const session of allSessions()) {
      expect(session.disposed).toBe(true);
    }
  });

  it("passes thinkingLevel off to the nested writer session", async () => {
    const { fakeSdk, setScript, lastOptions } = createFakeSdk();
    setScript(successScript("# Test README\n\nContent."));

    const pi = makeApiWithSdk(fakeSdk);
    const { ctx } = createFakeExtensionContext({ hasUI: false });

    await expandDocBlueprintToMarkdown(pi, ctx, "@smol", DOC_BLUEPRINT);
    // Fake SDK options are opaque `unknown`; we control the fake and know this shape.
    const capturedOptions = lastOptions() as { thinkingLevel?: string };
    expect(capturedOptions.thinkingLevel).toBe("off");
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
