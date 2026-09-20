import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Tokenized Architectural Diff (TAD) — the per-step wire format of
 * `PlanBlueprint.approach`.
 *
 * One TAD line describes one ordered change step:
 *
 *     @path/to/file.ext[start-end]{+|!|~}deps(dep/a.ts,dep/b.ts)#snake_case_intent
 *
 *   `@path`       project-relative target of the edit
 *   `[start-end]` inclusive 1-based line range; omitted for a file that does not
 *                 exist yet (a `{+}` step)
 *   `{+}` `{!}` `{~}` add / delete / modify
 *   `deps(a,b)`   project-relative files whose contract this step depends on; may
 *                 be omitted or empty
 *   `#intent`     snake_case label naming the step
 *
 * The brain model emits these lines instead of `{summary, detail}` objects: the
 * extension hydrates each referenced line range from disk and hands the raw line
 * plus its snippet to the writer model as plain text.
 */

/** The change a TAD step performs: add (`{+}`), delete (`{!}`), modify (`{~}`). */
export type TadOperation = "+" | "!" | "~";

/** One inclusive 1-based line range of a TAD step's target file. */
export interface TadLineRange {
  start: number;
  end: number;
}

/** One parsed TAD step. */
export interface TadStep {
  /** The TAD line exactly as the brain model submitted it. */
  raw: string;
  /** Project-relative target of the edit. */
  filePath: string;
  /** Lines the step edits; `undefined` for a whole-file (new-file) step. */
  lineRange: TadLineRange | undefined;
  /** Add, delete, or modify. */
  operation: TadOperation;
  /** Project-relative files whose contract this step depends on. */
  dependencies: string[];
  /** snake_case label naming the step. */
  intent: string;
}

/** The single accepted TAD line shape. Shared by `parseTadLine` and the
 *  `propose_plan_blueprint` Zod schema so a line that validates at the tool
 *  boundary always parses. Anchored without flags, so `test`/`exec` are state-free. */
export const TAD_LINE_RE =
  /^@(?<path>[A-Za-z0-9_./-]+)(?:\[(?<start>[0-9]+)-(?<end>[0-9]+)\])?\{(?<op>[+!~])\}(?:deps\((?<deps>[^)]*)\))?#(?<intent>[A-Za-z0-9_]+)$/;

/** Human-readable restatement of {@link TAD_LINE_RE}: the exact wire shape the
 *  brain model must emit and the text of every validation error. */
export const TAD_LINE_SHAPE = "@path/to/file.ext[start-end]{+|!|~}deps(dep/a.ts,dep/b.ts)#snake_case_intent";

/** Parses one TAD line into its parts, throwing a descriptive error when `line`
 *  does not match {@link TAD_LINE_RE} or carries an inverted line range. */
export function parseTadLine(line: string): TadStep {
  const match = TAD_LINE_RE.exec(line);
  if (!match?.groups) {
    throw new Error(`Malformed TAD line ${JSON.stringify(line)} — expected ${TAD_LINE_SHAPE}.`);
  }
  const { path, start, end, op, deps, intent } = match.groups;

  const lineRange: TadLineRange | undefined =
    start === undefined || end === undefined ? undefined : { start: Number(start), end: Number(end) };
  if (lineRange && lineRange.end < lineRange.start) {
    throw new Error(
      `Malformed TAD line ${JSON.stringify(line)} — line range end (${lineRange.end}) precedes start (${lineRange.start}).`,
    );
  }

  const dependencies = (deps ?? "")
    .split(",")
    .map(dependency => dependency.trim())
    .filter(dependency => dependency !== "");

  return {
    raw: line,
    filePath: path,
    lineRange,
    operation: op as TadOperation,
    dependencies,
    intent,
  };
}

/** Longest excerpt hydrated for one step, in lines. */
const MAX_SNIPPET_LINES = 200;

/** A parsed TAD step plus the file content it references. */
export interface HydratedTadStep {
  /** The parsed step. */
  step: TadStep;
  /** Numbered excerpt of the target file's lines, or a parenthesised note when
   *  nothing could be read (missing file, directory, unreadable file, or a path
   *  resolving outside the project root). */
  snippet: string;
}

/** Reads the lines a TAD step references so the writer model can ground its prose
 *  in real code. `projectRoot` is the session cwd; `step.filePath` is resolved
 *  against it and rejected when it escapes. Every read failure degrades to a note
 *  in the snippet — hydration never throws, so one bad step cannot sink a plan. */
export async function hydrateTadStep(projectRoot: string, step: TadStep): Promise<HydratedTadStep> {
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
