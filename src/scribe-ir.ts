import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { PlanBlueprint, ScribeOperation } from "./types";

/**
 * Scribe IR resolution/validation/hydration — the counterpart to the compact
 * `ScribeFile`/`ScribeStep` tuples defined in `src/types.ts`.
 *
 * The planning model emits positional tuples to hold down its own token
 * cost. This module validates that IR, resolves file IDs to paths, and
 * hydrates each step's referenced line range from disk so the writer model
 * receives semantic, human-readable steps grounded in real source — never a
 * syntax it must decode itself.
 */

export interface ScribeLineRange {
  start: number;
  end: number;
}

export interface ScribeStepResolved {
  id: string;
  filePath: string;
  operation: ScribeOperation;
  lineRange: ScribeLineRange | undefined;
  intent: string;
  preserve: readonly string[];
  doNot: readonly string[];
}

/** A resolved step plus the file content it references. */
export interface HydratedScribeStep {
  step: ScribeStepResolved;
  snippet: string;
}

/** Validates `blueprint.files`/`blueprint.steps` structurally, throwing a
 *  descriptive error naming the offending step index and file id on the
 *  first violation found. Never silently repairs malformed IR.
 *
 *  The Zod schema at the tool boundary can only assert each entry is an
 *  array of a fixed length (it has no tuple/union combinator), so this is
 *  the sole place that checks per-position types, operation membership,
 *  range ordering, and the fileId cross-reference — not just the
 *  cross-field reference the schema genuinely cannot express. */
export function validateScribeBlueprint(blueprint: PlanBlueprint): void {
  const seenIds = new Set<string>();
  blueprint.files.forEach((file, index) => {
    if (!Array.isArray(file) || file.length !== 3) {
      throw new Error(`files[${index}]: must be a 3-element [id, path, reason] tuple.`);
    }
    const [id, path, reason] = file;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`files[${index}]: file id must be a non-empty string.`);
    if (seenIds.has(id)) throw new Error(`files[${index}]: duplicate file id ${JSON.stringify(id)}.`);
    seenIds.add(id);
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(`files[${index}] (id ${JSON.stringify(id)}): path must be a non-empty string.`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`files[${index}] (id ${JSON.stringify(id)}): reason must be a non-empty string.`);
    }
  });

  if (blueprint.steps.length === 0) throw new Error("steps must contain at least one step.");

  blueprint.steps.forEach((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 6) {
      throw new Error(`steps[${index}]: must be a 6-element [fileId, operation, range, intent, preserve, doNot] tuple.`);
    }
    const [fileId, operation, range, intent, preserve, doNot] = entry;
    if (typeof fileId !== "string" || !seenIds.has(fileId)) {
      throw new Error(`steps[${index}]: references unknown file id ${JSON.stringify(fileId)}.`);
    }
    if (operation !== "+" && operation !== "!" && operation !== "~") {
      throw new Error(
        `steps[${index}] (file ${JSON.stringify(fileId)}): invalid operation ${JSON.stringify(operation)}; expected "+", "!", or "~".`,
      );
    }
    if (range !== null) {
      if (!Array.isArray(range) || range.length !== 2) {
        throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): range must be [start, end] or null.`);
      }
      const [start, end] = range;
      if (!Number.isInteger(start) || start < 1) {
        throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): range start must be a positive integer, got ${start}.`);
      }
      if (!Number.isInteger(end) || end < start) {
        throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): range end (${end}) must be >= start (${start}).`);
      }
    }
    if (typeof intent !== "string" || intent.trim() === "") {
      throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): intent must be a non-empty string.`);
    }
    ([["preserve", preserve], ["doNot", doNot]] as const).forEach(([label, items]) => {
      if (!Array.isArray(items)) {
        throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): ${label} must be an array of strings.`);
      }
      items.forEach((item, itemIndex) => {
        if (typeof item !== "string" || item.trim() === "") {
          throw new Error(`steps[${index}] (file ${JSON.stringify(fileId)}): ${label}[${itemIndex}] must be a non-empty string.`);
        }
      });
    });
  });
}

/** Resolves file IDs to paths and assigns each step a stable `S<n>` id.
 *  Call only after {@link validateScribeBlueprint} has passed. */
export function resolveScribeSteps(blueprint: PlanBlueprint): ScribeStepResolved[] {
  const pathById = new Map(blueprint.files.map(([id, path]) => [id, path] as const));
  return blueprint.steps.map(([fileId, operation, range, intent, preserve, doNot], index) => {
    const filePath = pathById.get(fileId);
    if (filePath === undefined) throw new Error(`steps[${index}]: references unknown file id ${JSON.stringify(fileId)}.`);
    return {
      id: `S${index + 1}`,
      filePath,
      operation,
      lineRange: range ? { start: range[0], end: range[1] } : undefined,
      intent,
      preserve,
      doNot,
    };
  });
}

/** Longest excerpt hydrated for one step, in lines. */
const MAX_SNIPPET_LINES = 200;

/** Reads the lines a step references so the writer model can ground its prose
 *  in real code. `projectRoot` is the session cwd; `step.filePath` is resolved
 *  against it and rejected when it escapes. Every read failure degrades to a
 *  note in the snippet — hydration never throws, so one bad step cannot sink
 *  a plan. Ported near-verbatim from the deleted `hydrateTadStep`. */
export async function hydrateScribeStep(projectRoot: string, step: ScribeStepResolved): Promise<HydratedScribeStep> {
  const root = resolve(projectRoot);
  const target = resolve(root, step.filePath);
  if (target !== root && !target.startsWith(root + sep)) {
    return { step, snippet: `(no snippet: ${step.filePath} resolves outside the project root)` };
  }

  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "does not exist yet — treat this step as authoring it from scratch"
        : code === "EISDIR"
          ? "is a directory, not a file"
          : `could not be read (${code ?? (error instanceof Error ? error.message : String(error))})`;
    return { step, snippet: `(no snippet: ${step.filePath} ${reason})` };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const from = step.lineRange?.start ?? 1;
  const to = step.lineRange?.end ?? lines.length;
  if (from > lines.length) {
    return {
      step,
      snippet: `(no snippet: ${step.filePath} has only ${lines.length} lines, but lines ${from}-${to} were requested)`,
    };
  }

  const available = Math.min(to, lines.length);
  const emitTo = Math.min(available, from + MAX_SNIPPET_LINES - 1);
  const excerpt: string[] = [];
  for (let n = from; n <= emitTo; n++) excerpt.push(`${String(n).padStart(5)}| ${lines[n - 1]}`);

  const notes: string[] = [];
  if (to > lines.length) notes.push(`lines ${lines.length + 1}-${to} were requested but ${step.filePath} ends at line ${lines.length}`);
  if (available > emitTo) notes.push(`${available - emitTo} further lines omitted`);
  return { step, snippet: notes.length === 0 ? excerpt.join("\n") : `${excerpt.join("\n")}\n(${notes.join("; ")})` };
}
