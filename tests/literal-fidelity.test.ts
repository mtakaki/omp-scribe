/**
 * Unit tests for the literal-fidelity engine: mining the load-bearing literals
 * out of a brief, matching them against a rendered draft, reporting which
 * sections lost one, and rendering the repair brief that asks the writer to put
 * them back verbatim.
 */
import { describe, expect, it } from "bun:test";
import { PLAN_SECTIONS, type PlanSection } from "../src/plan-sections";
import {
  PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
  buildRepairPromptText,
  checkFidelity,
  extractLiterals,
  findMissingLiterals,
  literalDumpLines,
  normalizeForMatch,
  removeLiteralDumpLines,
  type FidelityGap,
  type FidelityTarget,
  type RepairTarget,
} from "../src/literal-fidelity";

describe("extractLiterals", () => {
  it("extracts the four literal shapes of a step intent in reading order", () => {
    const intent =
      "Update `deriveVariantKey` to build `${dir}${variant}-${base}.webp` for db.artwork.count({ where }) in backend/src/routes/public.ts";

    expect(extractLiterals(intent)).toEqual([
      "deriveVariantKey",
      "${dir}${variant}-${base}.webp",
      "db.artwork.count({ where })",
      "backend/src/routes/public.ts",
    ]);
  });

  it("keeps a backticked command whole rather than splitting off the path it contains", () => {
    expect(extractLiterals("- `bun test tests/auth-refresh.test.ts` passes")).toEqual([
      "bun test tests/auth-refresh.test.ts",
    ]);
  });

  it("keeps a local:// reference whole rather than its file-name tail", () => {
    expect(extractLiterals("write to local://auth-refresh-plan.md next")).toEqual(["local://auth-refresh-plan.md"]);
  });

  it("keeps a SCREAMING_SNAKE constant and a quoted identifier", () => {
    expect(extractLiterals('bump SCRIBE_MODEL_CONFIG_RELATIVE_PATH and rename "deriveVariantKey"')).toEqual([
      "SCRIBE_MODEL_CONFIG_RELATIVE_PATH",
      "deriveVariantKey",
    ]);
  });

  it("keeps only the real literal when a nested backtick splits a span", () => {
    expect(
      extractLiterals("return `NextResponse.redirect(new URL(`/?p`, request.url), 307)` and log `deriveVariantKey`"),
    ).toEqual(["deriveVariantKey"]);
  });

  it("unwraps a backticked span that is one quoted string", () => {
    expect(extractLiterals('(target `"artistas"`)')).toEqual(["artistas"]);
    expect(findMissingLiterals("see /artistas for the directory", ["artistas"])).toEqual([]);
  });

  it("extracts nothing from prose, a two-character span, a bare number, or a word-internal apostrophe", () => {
    expect(extractLiterals("add/remove the helper")).toEqual([]);
    expect(extractLiterals("set the limit to 42")).toEqual([]);
    expect(extractLiterals("set the limit to `42`")).toEqual([]);
    expect(extractLiterals("`ab` is too short to be a literal")).toEqual([]);
    expect(extractLiterals("rewrite the writer's output")).toEqual([]);
    expect(extractLiterals('he said "the plan should stay short" today')).toEqual([]);
  });

  it("returns nothing for an absent or empty string", () => {
    expect(extractLiterals(undefined)).toEqual([]);
    expect(extractLiterals("")).toEqual([]);
  });
});

describe("normalizeForMatch / findMissingLiterals", () => {
  it("normalizes re-wrapped whitespace and trims the ends", () => {
    expect(normalizeForMatch("  a\n\tb  ")).toBe("a b");
  });

  it("matches a literal the draft re-wrapped across lines or stripped of backticks", () => {
    expect(findMissingLiterals("a\nb", ["a b"])).toEqual([]);
    expect(findMissingLiterals("- bun test tests/auth.test.ts passes", ["bun test\ntests/auth.test.ts"])).toEqual([]);
  });

  it("reports a literal the text does not contain", () => {
    expect(findMissingLiterals("a b", ["c"])).toEqual(["c"]);
  });

  it("reports every literal when there is no text to search", () => {
    expect(findMissingLiterals(undefined, ["a b", "c"])).toEqual(["a b", "c"]);
  });
});

const SECTIONS: PlanSection[] = [
  { heading: "Context", text: "## Context\n\nRefresh the auth flow.\n\n" },
  { heading: "Approach", text: "## Approach\n\n- Modify `src/auth.ts` lines 42-67 to issue `refresh_token`.\n\n" },
];

describe("checkFidelity", () => {
  it("reports the gap for a section that lost a literal and counts what it checked", () => {
    const targets: FidelityTarget[] = [
      { heading: "Context", literals: ["refresh_token"] },
      { heading: "Approach", literals: ["src/auth.ts", "refresh_token"] },
    ];

    const report = checkFidelity(targets, SECTIONS);

    expect(report.gaps).toEqual([{ heading: "Context", missing: ["refresh_token"] }]);
    expect(report.missing).toEqual(["refresh_token"]);
    expect(report.checked).toBe(2);
    expect(report.repaired).toBe(false);
  });

  it("tracks a target section the draft never emitted without calling it a gap", () => {
    const targets: FidelityTarget[] = [
      { heading: PLAN_SECTIONS.files, literals: ["src/auth.ts"] },
      { heading: "Approach", literals: ["src/auth.ts"] },
    ];

    const report = checkFidelity(targets, SECTIONS);

    expect(report.missingSections).toEqual([PLAN_SECTIONS.files]);
    expect(report.gaps).toEqual([]);
    expect(report.missing).toEqual([]);
    // Only the literals of a section the draft carries were compared.
    expect(report.checked).toBe(1);
  });

  it("de-duplicates a literal two target sections both lost", () => {
    const targets: FidelityTarget[] = [
      { heading: "Context", literals: ["derive_variant_key"] },
      { heading: "Approach", literals: ["derive_variant_key"] },
    ];

    const report = checkFidelity(targets, SECTIONS);

    expect(report.gaps).toHaveLength(2);
    expect(report.missing).toEqual(["derive_variant_key"]);
    expect(report.checked).toBe(1);
  });
});

describe("buildRepairPromptText", () => {
  const gaps: FidelityGap[] = [{ heading: "Approach", missing: ["src/auth.ts", "refresh_token"] }];
  const targets: RepairTarget[] = [
    { heading: "Context", literals: ["x"], supplied: "Refresh the auth flow." },
    { heading: "Approach", literals: ["src/auth.ts"], supplied: "1. src/auth.ts\n   intent: issue `refresh_token`" },
  ];

  it("lists the sections to re-emit, then per section its literals, current text, and supplied content", () => {
    const brief = buildRepairPromptText(gaps, targets, SECTIONS);

    expect(brief).toContain("SECTIONS TO RE-EMIT");
    expect(brief).toContain("1. Approach");
    expect(brief).toContain("=== SECTION 1: Approach ===");
    expect(brief).toContain("MISSING LITERALS");
    expect(brief).toContain("- `src/auth.ts`");
    expect(brief).toContain("- `refresh_token`");
    expect(brief).toContain("CURRENT");
    expect(brief).toContain("## Approach\n\n- Modify `src/auth.ts` lines 42-67 to issue `refresh_token`.");
    expect(brief).toContain("SUPPLIED CONTENT");
    expect(brief).toContain("intent: issue `refresh_token`");
    // A heading the gate did not flag is never mentioned.
    expect(brief).not.toContain("=== SECTION 2");
    expect(brief).not.toContain("Refresh the auth flow.");
  });

  it("reports (missing) for a gapped section the draft does not carry", () => {
    const brief = buildRepairPromptText([{ heading: "Verification", missing: ["bun test"] }], targets, SECTIONS);

    expect(brief).toContain("(missing)");
    expect(brief).toContain("SUPPLIED CONTENT\n(none)");
  });

  it("names the four brief labels in the repair system prompt", () => {
    for (const label of ["SECTIONS TO RE-EMIT", "MISSING LITERALS", "CURRENT", "SUPPLIED CONTENT"]) {
      expect(PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT).toContain(label);
    }
    expect(PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT).toContain("verbatim");
  });
});

describe("literalDumpLines", () => {
  /** A section that states one sentence and then lists two literals instead of
   *  folding them into it — the shape the gate must strip and refuse. */
  const DUMPED_SECTION = `## Context

The taxonomy API is being renamed.

- \`https://api.example.com/api/taxonomy/terms\`
- \`"artistas"\`, \`"obras"\``;

  it("reports the lines that are nothing but literals", () => {
    expect(literalDumpLines(DUMPED_SECTION)).toEqual([
      "- `https://api.example.com/api/taxonomy/terms`",
      '- `"artistas"`, `"obras"`',
    ]);
  });

  it("keeps prose, a blank line, and a fence out of the residue", () => {
    expect(
      literalDumpLines(`- Rename the helper to \`deriveVariantKey\` in src/lossy.ts.

\`\`\``),
    ).toEqual([]);
  });

  it("drops exactly those lines and leaves the prose byte-identical", () => {
    expect(removeLiteralDumpLines(DUMPED_SECTION)).toBe("## Context\n\nThe taxonomy API is being renamed.\n");
  });
});
