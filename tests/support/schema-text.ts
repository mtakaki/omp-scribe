/**
 * Shared planner-surface extraction for the token budgets.
 *
 * `schemaText` pulls every parameter name and every `desc`/`expected` string a
 * registered omptype schema carries, once each; `registeredToolTexts` and
 * `capturePlanDirective` capture exactly the text the expensive planner reads,
 * taken from the registered definitions rather than from the source file, so a
 * schema that never reaches the model cannot satisfy a budget.
 *
 * The budget test (`tests/token-economics.test.ts`) and the `measure` harness
 * (`scripts/measure-tokens.ts`) both count this text, so both must derive it
 * with this one implementation.
 */
import { createFakeExtensionApi, createFakeExtensionContext, modeChangeEntry } from "./fake-extension-api";
import scribe from "../../src/index";

/** Every parameter name and every `desc`/`expected` string a registered Zod
 *  schema carries, once each.  The omptype schema exposes its IR (`schema.ir`);
 *  `props[].key` names the parameter the model sees and its `cfg.expected`
 *  mirrors a field's `desc`, so the strings are deduplicated. */
export function schemaText(schema: unknown): string {
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

export interface RegisteredToolText {
  name: string;
  description: string;
  parameters: string;
}

/** The tool texts the model actually receives, captured from the registered
 *  definitions. */
export function registeredToolTexts(): RegisteredToolText[] {
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
export async function capturePlanDirective(): Promise<string> {
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
