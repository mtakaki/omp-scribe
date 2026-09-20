/**
 * Scribe IR intentionally uses positional tuples rather than repeated
 * object keys. The blueprint is emitted by the expensive planning model,
 * so structural repetition costs tokens. Semantic content remains explicit
 * in `intent`, `preserve`, and `doNot`.
 */
export type ScribeOperation = "+" | "!" | "~";

/** [id, path, reason] — a file the plan touches. `id` is a short label the
 *  `steps` array references; `path` is project-relative; `reason` is a
 *  one-line note on why the file matters. */
export type ScribeFile = readonly [id: string, path: string, reason: string];

/** [start, end] — an inclusive 1-based line range. */
export type ScribeRange = readonly [start: number, end: number];

/**
 * [fileId, operation, range, intent, preserve, doNot] — one ordered change
 * step. `range` is `null` when no existing range applies (e.g. a new file).
 * `intent` is a concise natural-language sentence, never an abbreviation.
 * `preserve`/`doNot` may be empty arrays.
 */
export type ScribeStep = readonly [
  fileId: string,
  operation: ScribeOperation,
  range: ScribeRange | null,
  intent: string,
  preserve: readonly string[],
  doNot: readonly string[],
];

/** The compact JSON blueprint the expensive model submits instead of Markdown prose.
 *  Field names mirror the plan-document contract (Context/Approach/Critical files/
 *  Verification/Assumptions) already used by native plan mode. `files` and `steps`
 *  are the Scribe IR (see `src/scribe-ir.ts`); the extension validates, resolves,
 *  and hydrates them from disk before delegating Markdown expansion, so the brain
 *  model never restates file content or TAD syntax. */
export interface PlanBlueprint {
  slug: string;
  title: string;
  context: string;
  files: readonly ScribeFile[];
  steps: readonly ScribeStep[];
  verification: readonly string[];
  assumptions: readonly string[];
}

/** One section in the compact document blueprint. */
export interface DocBlueprintSection {
  heading: string;
  bullets: string[];
}

/** The compact JSON blueprint the expensive model submits instead of Markdown prose
*  for standalone long-form documents (README, ARCHITECTURE, CHANGELOG entries,
*  ADRs, design docs, PR/issue descriptions). Unlike PlanBlueprint's plan-specific
*  fields, sections is an ordered outline of headings-and-bullets covering any doc type.
*  `path` is the exact write target declared up front (e.g. "README.md"). */
export interface DocBlueprint {
  slug: string;
  title: string;
  /** Exact write target declared up front, e.g. "README.md" or "docs/ARCHITECTURE.md". */
  path: string;
  sections: DocBlueprintSection[];
}
