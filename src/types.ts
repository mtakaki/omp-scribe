/** One critical-file pointer in the compact blueprint. */
export interface PlanBlueprintFile {
  path: string;
  reason: string;
}

/** The compact JSON blueprint the expensive model submits instead of Markdown prose.
 *  Field names mirror the plan-document contract (Context/Approach/Critical files/
 *  Verification/Assumptions) already used by native plan mode. */
export interface PlanBlueprint {
  slug: string;
  title: string;
  context: string;
  /** Ordered load-bearing steps, each a Tokenized Architectural Diff (TAD) line —
   *  `@path/to/file.ext[start-end]{+|!|~}deps(dep/a.ts,dep/b.ts)#snake_case_intent`
   *  (see `src/tad.ts`). The line range is omitted for a file that does not exist
   *  yet. The extension hydrates each referenced range from disk before delegating the
   *  Markdown expansion, so the brain model never restates file content. */
  approach: string[];
  criticalFiles: PlanBlueprintFile[];
  verification: string[];
  assumptions: string[];
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
