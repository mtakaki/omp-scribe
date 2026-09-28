/**
 * Token-budget tests for everything the expensive planner reads before it
 * writes a line of Markdown: the plan-mode directive, the three tool schemas,
 * and the writer system prompts — plus the wire-format ratio the tuple IR has
 * to justify.
 *
 * Every budget is expressed in the fixture's own encoding (`deepseek-v3`, the
 * fixture plan's `Model.tokenizer`) and counted with the host's native
 * tokenizer, so a number here is comparable with the host's own context
 * accounting. The ceilings are `ceil`ings, never pinned counts: a tokenizer
 * upgrade may move a number without breaking the contract, but growth past a
 * ceiling is a regression. Where no native tokenizer resolves — a platform
 * whose optional addon is missing — every assertion here skips with a stated
 * reason instead of failing on an estimate.
 */
import { describe, expect, it } from "bun:test";
import { createFakeExtensionApi, createFakeExtensionContext, modeChangeEntry } from "./support/fake-extension-api";
import { resolveTokenCounter } from "../src/token-accounting";
import { DOC_WRITER_SYSTEM_PROMPT, PLAN_UPDATE_WRITER_SYSTEM_PROMPT, WRITER_SYSTEM_PROMPT } from "../src/writer-session";
import { loadTokenFixture, renderProseEquivalent, tupleJson } from "./support/token-fixture";
import scribe from "../src/index";

/** Encoding every ceiling below is stated in. */
const ENCODING = "deepseek-v3";

const counter = await resolveTokenCounter({ tokenizer: "deepseek-v3" });
const skipReason =
  counter.exact === true
    ? undefined
    : `no exact native tokenizer resolved for ${ENCODING}: @oh-my-pi/pi-natives did not load, so the token budgets cannot be measured.`;
if (skipReason !== undefined) console.warn(`token-economics: ${skipReason}`);
const tokenIt = skipReason === undefined ? it : it.skip;

/** Counts `text` in the budget encoding. */
const tokens = (text: string): number => counter.count(text);

/** Ceilings, in `deepseek-v3` tokens, for the three registered tool schemas
 *  (description plus every parameter name and `describe`, deduplicated). Each is
 *  70% of the pre-change measurement recorded beside it, taken from the same
 *  extraction at the commit this budget was introduced. */
const TOOL_TEXT_BUDGETS: Readonly<Record<string, { ceiling: number; before: number }>> = {
  propose_plan_blueprint: { ceiling: 412, before: 589 },
  propose_plan_update: { ceiling: 326, before: 466 },
  propose_doc_blueprint: { ceiling: 184, before: 263 },
};

/** Ceilings for the writer system prompts: 75% of the pre-change measurement,
 *  plus the fixed ceiling the plan contract names for the plan writer. */
const WRITER_PROMPT_BUDGETS: ReadonlyArray<{ label: string; text: () => string; ceiling: number; before: number }> = [
  { label: "WRITER_SYSTEM_PROMPT", text: () => WRITER_SYSTEM_PROMPT, ceiling: 620, before: 796 },
  { label: "PLAN_UPDATE_WRITER_SYSTEM_PROMPT", text: () => PLAN_UPDATE_WRITER_SYSTEM_PROMPT, ceiling: 538, before: 717 },
  { label: "DOC_WRITER_SYSTEM_PROMPT", text: () => DOC_WRITER_SYSTEM_PROMPT, ceiling: 167, before: 223 },
];

/** The directive's ceiling: 60% of the pre-change 1030-token directive. The
 *  plan contract names 700, which this keeps a margin under. */
const DIRECTIVE_CEILING = 618;

/** Instructions the plan-mode directive must still carry after compression. */
const DIRECTIVE_KEYWORDS: readonly string[] = [
  "propose_plan_blueprint",
  "propose_plan_update",
  "[[<id>]]",
  "pending",
  "xd://propose",
  "local://",
  "never compose",
  "write the plan Markdown yourself",
];

/** Every tuple position, bound, and operation char each tool schema must spell
 *  out after compression. */
const TOOL_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  propose_plan_blueprint: [
    "slug",
    "title",
    "context",
    "literals",
    "files",
    "steps",
    "verification",
    "assumptions",
    "2-element [id, value]",
    "3-element [id, path, reason]",
    "6-element [fileId, operation, range|null, intent, preserve[], doNot[]]",
    '"+" add',
    '"!" delete',
    '"~" modify',
    "[A-Za-z][A-Za-z0-9_-]{0,15}",
    "1000",
  ],
  propose_plan_update: [
    "slug",
    "literals",
    "context",
    "files",
    "steps",
    "verification",
    "assumptions",
    "drop",
    "3-element [id, path, reason]",
    "6-element [fileId, operation, range|null, intent, preserve[], doNot[]]",
    "[A-Za-z][A-Za-z0-9_-]{0,15}",
    "1000",
    "requires files",
  ],
  propose_doc_blueprint: [
    "slug",
    "title",
    "path",
    "sections",
    "Section heading (H2)",
    "literals",
    "2-element [id, value]",
    "[A-Za-z][A-Za-z0-9_-]{0,15}",
    "1000",
  ],
};

/** Section headings the plan writer prompt must keep verbatim. */
const WRITER_HEADINGS: readonly string[] = [
  "## Context",
  "## Approach",
  "## Critical files & anchors",
  "## Verification",
  "## Assumptions & contingencies",
];

/** Every parameter name and every `desc`/`expected` string a registered Zod
 *  schema carries, once each.  The omptype schema exposes its IR (`schema.ir`);
 *  `props[].key` names the parameter the model sees and its `cfg.expected`
 *  mirrors a field's `desc`, so the strings are deduplicated. */
function schemaText(schema: unknown): string {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "key" && typeof value === "string") found.push(value);
      else if ((key === "desc" || key === "expected") && typeof value === "string") found.push(value);
      else walk(value);
    }
  };
  walk((schema as { ir?: unknown }).ir);
  return [...new Set(found)].join("\n");
}

interface RegisteredToolText {
  name: string;
  description: string;
  parameters: string;
}

/** The tool texts the model actually receives, captured from the registered
 *  definitions rather than from the source file, so a schema that never reaches
 *  the model cannot satisfy a budget. */
function registeredToolTexts(): RegisteredToolText[] {
  const fake = createFakeExtensionApi();
  scribe(fake.pi);
  return fake.tools.map(tool => ({
    name: tool.name,
    description: String(tool.definition["description"] ?? ""),
    parameters: schemaText(tool.definition["parameters"]),
  }));
}

/** The `<scribe>` directive the extension injects on a plan turn, captured from
 *  the registered `before_agent_start` handler. */
async function capturePlanDirective(): Promise<string> {
  const fake = createFakeExtensionApi();
  scribe(fake.pi);
  const { ctx } = createFakeExtensionContext({ branch: [modeChangeEntry("plan")] });
  const result = (await fake.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: [] },
    ctx,
  )) as { systemPrompt?: string[] } | undefined;
  return (result?.systemPrompt ?? []).join("\n");
}

describe("plan-mode directive budget", () => {
  tokenIt(`stays within ${DIRECTIVE_CEILING} ${ENCODING} tokens and keeps every instruction keyword`, async () => {
    const directive = await capturePlanDirective();
    expect(directive).toContain("</scribe>");
    expect(tokens(directive)).toBeLessThanOrEqual(DIRECTIVE_CEILING);
    for (const keyword of DIRECTIVE_KEYWORDS) expect(directive).toContain(keyword);
  });
});

describe("tool schema budget", () => {
  const texts = registeredToolTexts();

  for (const text of texts) {
    const budget = TOOL_TEXT_BUDGETS[text.name];
    tokenIt(`${text.name} stays within 70% of its recorded ${budget?.before ?? 0}-token text`, () => {
      expect(budget).toBeDefined();
      const total = tokens(`${text.description}\n${text.parameters}`);
      expect(total).toBeLessThanOrEqual(budget!.ceiling);
      for (const keyword of TOOL_KEYWORDS[text.name] ?? []) expect(`${text.description}\n${text.parameters}`).toContain(keyword);
    });
  }
});

describe("writer system prompt budget", () => {
  for (const prompt of WRITER_PROMPT_BUDGETS) {
    tokenIt(`${prompt.label} stays within 75% of its recorded ${prompt.before}-token prompt`, () => {
      expect(tokens(prompt.text())).toBeLessThanOrEqual(prompt.ceiling);
    });
  }

  tokenIt("keeps every plan section heading and the renderer rule verbatim", () => {
    expect(WRITER_SYSTEM_PROMPT).toContain("You are a renderer, not a planner.");
    for (const heading of WRITER_HEADINGS) expect(WRITER_SYSTEM_PROMPT).toContain(heading);
  });

  tokenIt("keeps the marker-emission rules in all three writer prompts", () => {
    for (const prompt of [WRITER_SYSTEM_PROMPT, PLAN_UPDATE_WRITER_SYSTEM_PROMPT, DOC_WRITER_SYSTEM_PROMPT]) {
      expect(prompt).toContain("[[<id>]]");
      expect(prompt).toMatch(/marker.*verbatim|verbatim.*marker/s);
    }
  });
});

describe("planner wire format", () => {
  tokenIt("keeps the tuple IR cheaper than a prose rendering of the same fixture plan", async () => {
    const fixture = await loadTokenFixture();
    // Guards: a fixture that stopped hydrating would make the ratio below pass
    // on an empty brief.
    expect(fixture.brief).toContain("APPROACH STEPS");
    expect(fixture.snippetText.length).toBeGreaterThan(0);

    const json = tokens(tupleJson(fixture.plan));
    const prose = tokens(renderProseEquivalent(fixture.plan));
    expect(prose).toBeGreaterThan(0);
    expect(json).toBeLessThanOrEqual(Math.ceil(prose * 1.15));
  });
});
