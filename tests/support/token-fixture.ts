/**
 * The checked-in token-economics fixture: one representative plan plus the
 * source files its steps reference.
 *
 * Everything here loads through the extension's own path — `resolveScribeSteps`
 * → `hydrateScribeStep` → `buildPlanPromptText` — so a measurement of `brief`
 * is a measurement of the payload the writer model actually receives, not of a
 * hand-written approximation. The two alternative renderings exist only to
 * price the wire formats that were considered and rejected.
 *
 * The fixture's own files must never be named `*.test.ts` / `*.spec.ts`:
 * `bun test` discovers by name anywhere in the tree, and a fixture file is data
 * for the tokenizer, not a suite. `fixtures/` is also outside both tsconfig
 * `include` lists, so fixture sources are never compiled.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanBlueprint, ScribeLiteral, ScribeStep } from "../../src/types";
import { hydrateScribeStep, resolveScribeSteps, type HydratedScribeStep } from "../../src/scribe-ir";
import { buildPlanPromptText } from "../../src/writer-session";

/** Root of the fixture: the plan JSON and the project-relative paths it names. */
export const TOKEN_FIXTURE_ROOT = fileURLToPath(new URL("../../fixtures/token-economics/", import.meta.url));

/** The fixture plan as the blueprint tool would receive it. */
export async function readTokenFixturePlan(): Promise<PlanBlueprint> {
  const raw = await readFile(join(TOKEN_FIXTURE_ROOT, "plan.json"), "utf8");
  return JSON.parse(raw) as PlanBlueprint;
}

export interface LoadedTokenFixture {
  plan: PlanBlueprint;
  hydrated: HydratedScribeStep[];
  /** The writer brief, exactly as `expandBlueprintToMarkdown` builds it. */
  brief: string;
  /** The concatenated hydrated `source:` blocks inside `brief`. */
  snippetText: string;
}

async function hydratePlan(plan: PlanBlueprint): Promise<LoadedTokenFixture> {
  const hydrated = await Promise.all(
    resolveScribeSteps(plan).map(step => hydrateScribeStep(TOKEN_FIXTURE_ROOT, step)),
  );
  return {
    plan,
    hydrated,
    brief: buildPlanPromptText(plan, hydrated),
    snippetText: hydrated.map(entry => entry.snippet).join("\n"),
  };
}

export async function loadTokenFixture(): Promise<LoadedTokenFixture> {
  return hydratePlan(await readTokenFixturePlan());
}

/** Source lines in one project-relative fixture file, counted the way
 *  `hydrateScribeStep` counts them (a trailing newline adds no line). */
async function fixtureLineCount(path: string): Promise<number> {
  const lines = (await readFile(join(TOKEN_FIXTURE_ROOT, path), "utf8")).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * The payload the same fixture produced before the unranged add-step cap:
 * every unranged `+` step is re-hydrated with an explicit range covering its
 * whole file, which is exactly what `MAX_SNIPPET_LINES` alone emitted. Ranged
 * steps are untouched, so the two payloads differ only by the cap.
 */
export async function loadTokenFixtureWithUncappedSnippets(): Promise<LoadedTokenFixture> {
  const plan = await readTokenFixturePlan();
  const steps = await Promise.all(
    plan.steps.map(async (step: ScribeStep): Promise<ScribeStep> => {
      const [fileId, operation, range, intent, preserve, doNot] = step;
      if (operation !== "+" || range !== null) return step;
      const path = plan.files.find(([id]) => id === fileId)?.[1];
      if (path === undefined) return step;
      return [fileId, operation, [1, await fixtureLineCount(path)], intent, preserve, doNot];
    }),
  );
  return hydratePlan({ ...plan, steps });
}

/** The plan's tuple JSON exactly as the blueprint tool receives it. */
export function tupleJson(plan: PlanBlueprint): string {
  return JSON.stringify(plan);
}

/** Replaces every `[[id]]` marker with the literal value it stands for, so a
 *  rendering can carry the same content the tuple IR does without repeating the
 *  declaration table. */
function expandMarkers(text: string, literals: readonly ScribeLiteral[] | undefined): string {
  const values = new Map((literals ?? []).map(([id, value]) => [id.toLowerCase(), value] as const));
  return text.replace(/\[\[([^\]]+)\]\]/g, (_match, id: string) => values.get(id.trim().toLowerCase()) ?? `[[${id}]]`);
}

const OPERATION_LABELS: Record<string, string> = { "+": "add", "!": "delete", "~": "modify" };

/**
 * A concise prose rendering of the same plan: the same paths, ranges, intents,
 * constraints, and declared literal values, with none of the tuple IR's JSON
 * punctuation. This is the comparison the wire-format decision rests on — a
 * compact encoding only pays for its validator and compliance risk if the
 * planner's own output is substantially smaller than the prose it replaces.
 */
export function renderProseEquivalent(plan: PlanBlueprint): string {
  const expand = (text: string): string => expandMarkers(text, plan.literals);
  const pathById = new Map(plan.files.map(([id, path]) => [id, path] as const));
  const lines: string[] = [plan.title, "", expand(plan.context), "", "Approach:"];

  plan.steps.forEach(([fileId, operation, range, intent, preserve, doNot], index) => {
    const where = range === null ? "new file" : `lines ${range[0]}-${range[1]}`;
    const constraints = [
      preserve.length > 0 ? `Preserve: ${preserve.map(expand).join("; ")}.` : "",
      doNot.length > 0 ? `Do not: ${doNot.map(expand).join("; ")}.` : "",
    ].filter(part => part !== "");
    lines.push(
      `${index + 1}. ${pathById.get(fileId) ?? fileId} (${OPERATION_LABELS[operation]}, ${where}): ${expand(intent)}${constraints.length > 0 ? ` ${constraints.join(" ")}` : ""}`,
    );
  });

  if (plan.files.length > 0) {
    lines.push("", "Files:");
    for (const [, path, reason] of plan.files) lines.push(`- ${path}: ${expand(reason)}`);
  }
  if (plan.verification.length > 0) {
    lines.push("", "Verification:");
    for (const item of plan.verification) lines.push(`- ${expand(item)}`);
  }
  if (plan.assumptions.length > 0) {
    lines.push("", "Assumptions:");
    for (const item of plan.assumptions) lines.push(`- ${expand(item)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The same plan in a compact line-oriented DSL — the wire format that was
 * measured and rejected. It carries the same declared literal values, so the
 * comparison against {@link tupleJson} is like for like.
 */
export function renderCompactDsl(plan: PlanBlueprint): string {
  const expand = (text: string): string => expandMarkers(text, plan.literals);
  const lines: string[] = [`# ${plan.slug} | ${plan.title}`, `c ${expand(plan.context)}`];
  for (const [id, path, reason] of plan.files) lines.push(`f ${id} ${path} | ${expand(reason)}`);
  for (const [fileId, operation, range, intent, preserve, doNot] of plan.steps) {
    const constraints = [
      preserve.length > 0 ? ` +${preserve.map(expand).join(";")}` : "",
      doNot.length > 0 ? ` -${doNot.map(expand).join(";")}` : "",
    ].join("");
    lines.push(`s ${fileId} ${operation} ${range === null ? "-" : `${range[0]}-${range[1]}`} ${expand(intent)}${constraints}`);
  }
  for (const item of plan.verification) lines.push(`v ${expand(item)}`);
  for (const item of plan.assumptions) lines.push(`a ${expand(item)}`);
  for (const [id, value] of plan.literals ?? []) lines.push(`l ${id} ${value}`);
  return `${lines.join("\n")}\n`;
}
