import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  consumedWriteSwaps,
  DEFAULT_WRITER_MODEL,
  formatScribeStatus,
  isPlanModeActive,
  isPlanModeBranch,
  pendingMarkdownStore,
  pendingPlanEntry,
  planFileTarget,
  readPersistedScribeConfig,
  readScribeConfig,
  registerScribeFlags,
  resolveWriterModel,
  sameModel,
  SCRIBE_MODEL_CONFIG_RELATIVE_PATH,
  scribeModelConfigPath,
  writePersistedScribeConfig,
  type PendingBlueprint,
  type ScribeConfig,
  type ScribeStatusState,
} from "../src/config";
import { createFakeExtensionApi, createFakeExtensionContext, customMessageEntry, makeModel, modeChangeEntry } from "./support/fake-extension-api";

// ─── Singleton store isolation + per-test project directory ───────────────────

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `scribe-cfg-test-${randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  pendingMarkdownStore().clear();
  consumedWriteSwaps().clear();
});

afterEach(async () => {
  pendingMarkdownStore().clear();
  consumedWriteSwaps().clear();
  await rm(cwd, { recursive: true, force: true });
});

// ─── isPlanModeBranch / isPlanModeActive ─────────────────────────────────────

describe("isPlanModeBranch", () => {
  it("reports plan mode active when the newest mode_change is plan", () => {
    expect(isPlanModeBranch([modeChangeEntry("plan")])).toBe(true);
  });

  it("reports inactive once plan mode is left", () => {
    expect(isPlanModeBranch([modeChangeEntry("plan"), modeChangeEntry("none")])).toBe(false);
  });

  it("reports inactive when plan mode is paused", () => {
    expect(isPlanModeBranch([modeChangeEntry("plan_paused")])).toBe(false);
  });

  it("ignores non-plan modes", () => {
    expect(isPlanModeBranch([modeChangeEntry("goal")])).toBe(false);
    expect(isPlanModeBranch([modeChangeEntry("vibe")])).toBe(false);
  });

  it("reports inactive for an empty branch", () => {
    expect(isPlanModeBranch([])).toBe(false);
  });

  it("skips unrelated entries below the newest mode signal", () => {
    const branch = [
      modeChangeEntry("none"),
      { type: "message", message: { role: "user" } },
      modeChangeEntry("plan"),
      { type: "custom", customType: "tool_execution_start" },
    ];
    expect(isPlanModeBranch(branch)).toBe(true);
  });

  it("detects plan mode from the plan-mode-context message when no mode_change exists", () => {
    // --plan-yolo arms plan mode in-session without persisting a mode_change.
    expect(isPlanModeBranch([customMessageEntry("plan-mode-context")])).toBe(true);
  });

  it("treats a later plan-yolo-handoff as leaving plan mode", () => {
    const branch = [customMessageEntry("plan-mode-context"), customMessageEntry("plan-yolo-handoff")];
    expect(isPlanModeBranch(branch)).toBe(false);
  });

  it("prefers a mode_change over an older plan-mode-context message", () => {
    const branch = [customMessageEntry("plan-mode-context"), modeChangeEntry("none")];
    expect(isPlanModeBranch(branch)).toBe(false);
  });

  it("tolerates malformed entries", () => {
    expect(isPlanModeBranch([null, 42, "mode_change", { customType: "plan-mode-context" }])).toBe(false);
  });
});

describe("isPlanModeActive", () => {
  it("reads the live session branch", () => {
    const { ctx } = createFakeExtensionContext({ branch: [modeChangeEntry("plan")] });
    expect(isPlanModeActive(ctx)).toBe(true);
  });

  it("returns false when the context exposes no branch", () => {
    const { ctx } = createFakeExtensionContext();
    delete (ctx.sessionManager as unknown as Record<string, unknown>)["getBranch"];
    expect(isPlanModeActive(ctx)).toBe(false);
  });
});

// ─── planFileTarget ──────────────────────────────────────────────────────────

describe("planFileTarget", () => {
  it("extracts the slug from the canonical local:// plan path", () => {
    expect(planFileTarget("local://my-plan-slug-plan.md")).toEqual({ stem: "my-plan-slug-plan", slug: "my-plan-slug" });
  });

  it("handles slugs with digits", () => {
    expect(planFileTarget("local://add-unit-tests-2-plan.md")?.slug).toBe("add-unit-tests-2");
  });

  it("handles underscore slugs, which the host allows", () => {
    expect(planFileTarget("local://my_slug-plan.md")?.slug).toBe("my_slug");
  });

  it("names the host's default local://PLAN.md without inventing a slug", () => {
    expect(planFileTarget("local://PLAN.md")).toEqual({ stem: "PLAN", slug: undefined });
  });

  it("matches any lower/upper-case *plan.md artifact", () => {
    expect(planFileTarget("local://MyPlan.md")?.stem).toBe("MyPlan");
  });

  it("returns undefined for non-plan local:// paths", () => {
    expect(planFileTarget("local://notes.md")).toBeUndefined();
    expect(planFileTarget("local://other-file.txt")).toBeUndefined();
  });

  it("returns undefined for filesystem paths and non-strings", () => {
    expect(planFileTarget("/path/to/file.md")).toBeUndefined();
    expect(planFileTarget(42)).toBeUndefined();
    expect(planFileTarget(null)).toBeUndefined();
    expect(planFileTarget(undefined)).toBeUndefined();
  });
});

// ─── pendingPlanEntry ────────────────────────────────────────────────────────

function draft(sessionKey: string, markdown = "# Draft"): PendingBlueprint {
  return {
    sessionKey,
    markdown,
    writerModel: { provider: "anthropic", id: "haiku" },
    writerUsage: { input: 1, output: 1 },
    writerCostUsd: 0,
  };
}

describe("pendingPlanEntry", () => {
  it("resolves the canonical <slug>-plan.md write to its draft", () => {
    const store = new Map([["auth-refresh", draft("s1")]]);
    const target = planFileTarget("local://auth-refresh-plan.md")!;
    expect(pendingPlanEntry(store, "s1", target)?.key).toBe("auth-refresh");
  });

  it("matches slugs case-insensitively", () => {
    const store = new Map([["auth-refresh", draft("s1")]]);
    const target = planFileTarget("local://Auth-Refresh-plan.md")!;
    expect(pendingPlanEntry(store, "s1", target)?.key).toBe("auth-refresh");
  });

  it("resolves local://PLAN.md to the session's only draft", () => {
    const store = new Map([["auth-refresh", draft("s1")]]);
    const target = planFileTarget("local://PLAN.md")!;
    expect(pendingPlanEntry(store, "s1", target)?.key).toBe("auth-refresh");
  });

  it("does not guess when several drafts are pending for the session", () => {
    const store = new Map([
      ["first", draft("s1")],
      ["second", draft("s1")],
    ]);
    const target = planFileTarget("local://PLAN.md")!;
    expect(pendingPlanEntry(store, "s1", target)).toBeUndefined();
  });

  it("ignores drafts owned by other sessions", () => {
    const store = new Map([["auth-refresh", draft("other-session")]]);
    const target = planFileTarget("local://auth-refresh-plan.md")!;
    expect(pendingPlanEntry(store, "s1", target)).toBeUndefined();
  });
});

// ─── sameModel ───────────────────────────────────────────────────────────────

describe("sameModel", () => {
  it("returns true when provider and id match", () => {
    const a = makeModel("anthropic", "claude-opus-4-5");
    const b = makeModel("anthropic", "claude-opus-4-5");
    expect(sameModel(a, b)).toBe(true);
  });

  it("returns false when ids differ", () => {
    expect(sameModel(makeModel("anthropic", "opus"), makeModel("anthropic", "haiku"))).toBe(false);
  });

  it("returns false when providers differ", () => {
    expect(sameModel(makeModel("anthropic", "opus"), makeModel("openai", "opus"))).toBe(false);
  });

  it("returns false when current is undefined", () => {
    expect(sameModel(makeModel("anthropic", "opus"), undefined)).toBe(false);
  });
});

// ─── resolveWriterModel ───────────────────────────────────────────────────────

describe("resolveWriterModel", () => {
  it("returns the resolved model when spec resolves directly", () => {
    const { ctx } = createFakeExtensionContext({
      resolveModel: (spec) => (spec === "anthropic/claude-haiku-3-5" ? makeModel("anthropic", "claude-haiku-3-5") : undefined),
    });
    const result = resolveWriterModel(ctx, "anthropic/claude-haiku-3-5");
    expect(result).toEqual(makeModel("anthropic", "claude-haiku-3-5"));
  });

  it("falls back to @smol when primary spec does not resolve", () => {
    const { ctx } = createFakeExtensionContext({
      resolveModel: (spec) => (spec === "@smol" ? makeModel("anthropic", "smol-model") : undefined),
    });
    const result = resolveWriterModel(ctx, "nonexistent/model");
    expect(result).toEqual(makeModel("anthropic", "smol-model"));
  });

  it("returns undefined when neither spec nor @smol resolves", () => {
    const { ctx } = createFakeExtensionContext({
      resolveModel: () => undefined,
    });
    expect(resolveWriterModel(ctx, "@smol")).toBeUndefined();
  });
});

// ─── registerScribeFlags ──────────────────────────────────────────────────────

describe("registerScribeFlags", () => {
  it("registers exactly two flags with the expected names", () => {
    const { pi, flags } = createFakeExtensionApi();
    registerScribeFlags(pi);
    const names = flags.map(f => f.name);
    expect(names).toContain("scribe-brain-model");
    expect(names).toContain("scribe-writer-model");
    expect(flags).toHaveLength(2);
  });

  it("scribe-writer-model has default '@smol'", () => {
    const { pi, flags } = createFakeExtensionApi();
    registerScribeFlags(pi);
    const writerFlag = flags.find(f => f.name === "scribe-writer-model");
    expect(writerFlag?.options["default"]).toBe("@smol");
  });
});

// ─── readScribeConfig ─────────────────────────────────────────────────────────

describe("readScribeConfig", () => {
  it("returns defaults when no flag and no persisted override exist", async () => {
    const { pi } = createFakeExtensionApi();
    registerScribeFlags(pi);
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.brainModel).toBeUndefined();
    expect(cfg.writerModel).toBe(DEFAULT_WRITER_MODEL);
  });

  it("trims whitespace from brainModel", async () => {
    const { pi, flagValues } = createFakeExtensionApi();
    registerScribeFlags(pi);
    flagValues.set("scribe-brain-model", "  anthropic/claude-opus-4-5  ");
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.brainModel).toBe("anthropic/claude-opus-4-5");
  });

  it("sets brainModel to undefined when value is whitespace-only", async () => {
    const { pi, flagValues } = createFakeExtensionApi();
    registerScribeFlags(pi);
    flagValues.set("scribe-brain-model", "   ");
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.brainModel).toBeUndefined();
  });

  it("trims whitespace from a non-default writer flag", async () => {
    const { pi, flagValues } = createFakeExtensionApi();
    registerScribeFlags(pi);
    flagValues.set("scribe-writer-model", "  anthropic/claude-haiku-3-5  ");
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.writerModel).toBe("anthropic/claude-haiku-3-5");
  });

  it("falls back to the default when the writer flag is whitespace-only", async () => {
    const { pi, flagValues } = createFakeExtensionApi();
    registerScribeFlags(pi);
    flagValues.set("scribe-writer-model", "   ");
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.writerModel).toBe(DEFAULT_WRITER_MODEL);
  });

  it("prefers a non-default CLI flag over the persisted override", async () => {
    const { pi, flagValues } = createFakeExtensionApi();
    registerScribeFlags(pi);
    flagValues.set("scribe-writer-model", "openai/gpt-5-mini");
    await writePersistedScribeConfig(cwd, { writerModel: "anthropic/claude-haiku-3-5" });
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.writerModel).toBe("openai/gpt-5-mini");
  });

  it("prefers the persisted override over the flag's default value", async () => {
    // The registered default is indistinguishable from an unset flag, so a
    // session must not reset the user's `/scribe-model` pick back to @smol.
    const { pi } = createFakeExtensionApi();
    registerScribeFlags(pi);
    await writePersistedScribeConfig(cwd, { writerModel: "anthropic/claude-haiku-3-5" });
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.writerModel).toBe("anthropic/claude-haiku-3-5");
  });

  it("drops back to the default once the override is cleared", async () => {
    const { pi } = createFakeExtensionApi();
    registerScribeFlags(pi);
    await writePersistedScribeConfig(cwd, { writerModel: "anthropic/claude-haiku-3-5" });
    await writePersistedScribeConfig(cwd, { writerModel: undefined });
    const cfg = await readScribeConfig(pi, cwd);
    expect(cfg.writerModel).toBe(DEFAULT_WRITER_MODEL);
  });
});

// ─── Persisted per-project writer model ──────────────────────────────────────

describe("readPersistedScribeConfig", () => {
  it("writes to the documented project-relative path", () => {
    expect(SCRIBE_MODEL_CONFIG_RELATIVE_PATH).toBe(".claude/plans/scribe_config.json");
    expect(scribeModelConfigPath(cwd)).toBe(join(cwd, SCRIBE_MODEL_CONFIG_RELATIVE_PATH));
  });

  it("returns an empty config when the file does not exist (ENOENT self-heal)", async () => {
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
  });

  it("returns an empty config for malformed JSON (self-heal)", async () => {
    await mkdir(join(cwd, ".claude", "plans"), { recursive: true });
    await Bun.write(scribeModelConfigPath(cwd), "{ not json {{");
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
  });

  it("returns an empty config when writerModel has the wrong type (self-heal)", async () => {
    await mkdir(join(cwd, ".claude", "plans"), { recursive: true });
    await Bun.write(scribeModelConfigPath(cwd), JSON.stringify({ writerModel: { provider: "anthropic" } }));
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
  });

  it("treats a whitespace-only writerModel as no override", async () => {
    await mkdir(join(cwd, ".claude", "plans"), { recursive: true });
    await Bun.write(scribeModelConfigPath(cwd), JSON.stringify({ writerModel: "   " }));
    expect(await readPersistedScribeConfig(cwd)).toEqual({});
  });

  it("reads back a persisted writer model", async () => {
    await writePersistedScribeConfig(cwd, { writerModel: "anthropic/claude-haiku-3-5" });
    expect(await readPersistedScribeConfig(cwd)).toEqual({ writerModel: "anthropic/claude-haiku-3-5" });
  });
});

describe("writePersistedScribeConfig", () => {
  it("creates .claude/plans and leaves no temp sibling behind", async () => {
    const written = await writePersistedScribeConfig(cwd, { writerModel: "openai/gpt-5-mini" });
    expect(written).toEqual({ writerModel: "openai/gpt-5-mini" });

    const raw = await readFile(scribeModelConfigPath(cwd), "utf8");
    expect(JSON.parse(raw)).toEqual({ writerModel: "openai/gpt-5-mini" });
    expect(await readdir(join(cwd, ".claude", "plans"))).toEqual(["scribe_config.json"]);
  });

  it("removes the writerModel key when the patch clears it", async () => {
    await writePersistedScribeConfig(cwd, { writerModel: "anthropic/claude-haiku-3-5" });
    const cleared = await writePersistedScribeConfig(cwd, { writerModel: undefined });

    expect(cleared).toEqual({});
    const parsed = JSON.parse(await readFile(scribeModelConfigPath(cwd), "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("writerModel");
  });
});

// ─── formatScribeStatus ──────────────────────────────────────────────────────

describe("formatScribeStatus", () => {
  const cfg: ScribeConfig = { brainModel: undefined, writerModel: DEFAULT_WRITER_MODEL };
  const custom: ScribeConfig = { brainModel: undefined, writerModel: "anthropic/claude-haiku-3-5" };

  it("renders the idle line with the configured writer spec", () => {
    expect(formatScribeStatus(cfg, { kind: "idle" })).toBe("Scribe ○ idle (writer: @smol)");
  });

  it("renders the armed doc line", () => {
    expect(formatScribeStatus(cfg, { kind: "doc-armed" })).toBe("Scribe ○ doc armed (writer: @smol)");
  });

  it("renders the active plan line", () => {
    expect(formatScribeStatus(cfg, { kind: "plan" })).toBe("Scribe ● plan (writer: @smol)");
  });

  it("names the resolved model and draft size once a plan draft exists", () => {
    const state: ScribeStatusState = { kind: "plan", draft: { model: "anthropic/claude-haiku-3-5", chars: 4318 } };
    expect(formatScribeStatus(cfg, state)).toBe(
      "Scribe ● plan — 4318 chars drafted (writer: anthropic/claude-haiku-3-5)",
    );
  });

  it("renders the active doc line with its draft", () => {
    const state: ScribeStatusState = { kind: "doc", draft: { model: "anthropic/claude-haiku-3-5", chars: 1204 } };
    expect(formatScribeStatus(cfg, state)).toBe(
      "Scribe ● doc — 1204 chars drafted (writer: anthropic/claude-haiku-3-5)",
    );
  });

  it("reports the configured override while idle", () => {
    expect(formatScribeStatus(custom, { kind: "idle" })).toBe("Scribe ○ idle (writer: anthropic/claude-haiku-3-5)");
  });

  it("folds a multi-line failure reason into one bounded line", () => {
    const state: ScribeStatusState = { kind: "failed", mode: "plan", message: `boom\n${"x".repeat(200)}` };
    const line = formatScribeStatus(cfg, state);
    expect(line.startsWith("Scribe ✗ plan expansion failed — boom ")).toBe(true);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(110);
  });
});

// ─── Singleton store identity ─────────────────────────────────────────────────

describe("pendingMarkdownStore", () => {
  it("returns the same Map instance on successive calls", () => {
    expect(pendingMarkdownStore()).toBe(pendingMarkdownStore());
  });

  it("mutations are visible across calls", () => {
    pendingMarkdownStore().set("slug-a", {
      sessionKey: "s",
      markdown: "# Hello",
      writerModel: { provider: "anthropic", id: "haiku" },
      writerUsage: { input: 1, output: 1 },
      writerCostUsd: 0,
    });
    expect(pendingMarkdownStore().has("slug-a")).toBe(true);
  });
});

describe("consumedWriteSwaps", () => {
  it("returns the same Map instance on successive calls", () => {
    expect(consumedWriteSwaps()).toBe(consumedWriteSwaps());
  });

  it("mutations are visible across calls", () => {
    consumedWriteSwaps().set("call-id-1", { sessionKey: "s", input: { path: "x", content: "y" } });
    expect(consumedWriteSwaps().has("call-id-1")).toBe(true);
  });
});
