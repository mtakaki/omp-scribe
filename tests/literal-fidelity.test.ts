/**
 * Unit tests for the literal-fidelity engine: mining the load-bearing literals
 * out of a brief, matching them against a rendered draft, reporting which
 * sections lost one, and rendering the repair brief that asks the writer to put
 * them back verbatim.
 */
import { describe, expect, it } from "bun:test";
import { PLAN_SECTIONS, type PlanSection } from "../src/plan-sections";
import type { ScribeLiteral } from "../src/types";
import {
  PLAN_FIDELITY_REPAIR_SYSTEM_PROMPT,
  absentGaps,
  buildRepairPromptText,
  checkFidelity,
  extractLiterals,
  findMissingLiterals,
  formatLiteralTable,
  gapLiterals,
  literalDumpLines,
  literalMarkers,
  mergeLiterals,
  normalizeForMatch,
  referencedLiterals,
  removeLiteralDumpLines,
  resolveLiteralPlaceholders,
  validateLiteralTable,
  validateLiteralUsage,
  type FidelityGap,
  type FidelityTarget,
  type RepairTarget,
} from "../src/literal-fidelity";

/** The table the resolution and reference tests share. */
const TABLE: ScribeLiteral[] = [
  ["L1", "/api/search-text"],
  ["L2", "relation_not_allowed_for_entity"],
];

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

describe("absentGaps / gapLiterals", () => {
  const RELOCATED: FidelityTarget[] = [
    { heading: "Context", literals: ["refresh_token"] },
    { heading: "Approach", literals: ["src/auth.ts"] },
  ];

  it("drops a gap whose literal the draft carries in another section", () => {
    // Context lost it, Approach states it — the literal was relocated, not lost.
    const report = checkFidelity(RELOCATED, SECTIONS);

    expect(report.missing).toEqual(["refresh_token"]);
    expect(absentGaps(report, SECTIONS)).toEqual([]);
    expect(gapLiterals(absentGaps(report, SECTIONS))).toEqual([]);
  });

  it("keeps a gap carrying only the literals no section states", () => {
    const report = checkFidelity([{ heading: "Context", literals: ["refresh_token", "tenant_scoped_writes"] }], SECTIONS);

    expect(report.missing).toEqual(["refresh_token", "tenant_scoped_writes"]);
    expect(absentGaps(report, SECTIONS)).toEqual([{ heading: "Context", missing: ["tenant_scoped_writes"] }]);
    // The narrowing touches gaps and missing only.
    expect(report.checked).toBe(2);
    expect(report.missingSections).toEqual([]);
  });

  it("collapses two gaps naming the same literal into one entry", () => {
    const gaps: FidelityGap[] = [
      { heading: "Context", missing: ["tenant_scoped_writes"] },
      { heading: "Approach", missing: ["tenant_scoped_writes", "src/missing.ts"] },
    ];

    expect(gapLiterals(gaps)).toEqual(["tenant_scoped_writes", "src/missing.ts"]);
  });
});

describe("buildRepairPromptText", () => {
  const gaps: FidelityGap[] = [{ heading: "Approach", missing: ["src/auth.ts", "refresh_token"] }];
  const targets: RepairTarget[] = [
    { heading: "Context", literals: ["x"], supplied: "Refresh the auth flow." },
    { heading: "Approach", literals: ["src/auth.ts"], supplied: "1. src/auth.ts\n   intent: issue `refresh_token`" },
  ];

  it("lists the sections to re-emit, then per section its literals, current text, and supplied content", () => {
    const brief = buildRepairPromptText(gaps, targets, SECTIONS, undefined);

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
    const brief = buildRepairPromptText([{ heading: "Verification", missing: ["bun test"] }], targets, SECTIONS, undefined);

    expect(brief).toContain("(missing)");
    expect(brief).toContain("SUPPLIED CONTENT\n(none)");
  });

  it("prints the LITERALS block and a declared missing literal as its marker line", () => {
    const brief = buildRepairPromptText(
      [{ heading: "Approach", missing: ["relation_not_allowed_for_entity", "src/auth.ts"] }],
      targets,
      SECTIONS,
      TABLE,
    );

    expect(brief).toContain("LITERALS (each marker below must appear in your response exactly where its value belongs");
    expect(brief).toContain('[[lit:L1]] = "/api/search-text"');
    expect(brief).toContain('[[lit:L2]] = "relation_not_allowed_for_entity"');
    // A declared value is named by its marker; an undeclared one stays backticked.
    expect(brief).toContain("- [[lit:L2]] = \"relation_not_allowed_for_entity\"");
    expect(brief).toContain("- `src/auth.ts`");
  });

  it("names the brief labels in the repair system prompt", () => {
    for (const label of ["LITERALS", "SECTIONS TO RE-EMIT", "MISSING LITERALS", "CURRENT", "SUPPLIED CONTENT"]) {
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

  it("treats a line that is nothing but [[lit:<id>]] markers as a literal-only line", () => {
    expect(literalDumpLines("- [[lit:L1]]\n- [[lit:L2]], [[lit:L3]]\nthe plan states [[lit:L1]] in prose.")).toEqual([
      "- [[lit:L1]]",
      "- [[lit:L2]], [[lit:L3]]",
    ]);
    expect(removeLiteralDumpLines("- [[lit:L1]]\nthe plan states [[lit:L1]] in prose.")).toBe(
      "the plan states [[lit:L1]] in prose.",
    );
  });

  it("keeps a line of bare double-bracket project syntax out of the residue", () => {
    expect(literalDumpLines("- [[env.staging.analytics_engine_datasets]]\n- [[routes]]")).toEqual([]);
  });
});

describe("resolveLiteralPlaceholders", () => {
  it("resolves a known marker to its exact value and counts each occurrence", () => {
    const resolution = resolveLiteralPlaceholders("Request `[[lit:L1]]` returns [[lit:L2]].", TABLE);

    expect(resolution.markdown).toBe("Request `/api/search-text` returns relation_not_allowed_for_entity.");
    expect(resolution.resolved).toBe(2);
    expect(resolution.unresolved).toEqual([]);
  });

  it("resolves every occurrence of a repeated marker", () => {
    const resolution = resolveLiteralPlaceholders("[[lit:L1]] then [[lit:L1]]", TABLE);

    expect(resolution.markdown).toBe("/api/search-text then /api/search-text");
    expect(resolution.resolved).toBe(2);
  });

  it("leaves an unknown id byte-identical and records its body once", () => {
    const resolution = resolveLiteralPlaceholders(
      "[[lit:L9]] and [[lit:L9]] and [unclosed] and [[lit:L2]]",
      TABLE,
    );

    expect(resolution.markdown).toBe(
      "[[lit:L9]] and [[lit:L9]] and [unclosed] and relation_not_allowed_for_entity",
    );
    expect(resolution.unresolved).toEqual(["L9"]);
    expect(resolution.resolved).toBe(1);
  });

  it("leaves a double-bracket span without the sentinel untouched and unrecorded", () => {
    const resolution = resolveLiteralPlaceholders(
      "see [[env.staging.analytics_engine_datasets]] and [[routes]]",
      TABLE,
    );

    expect(resolution.markdown).toBe("see [[env.staging.analytics_engine_datasets]] and [[routes]]");
    expect(resolution.resolved).toBe(0);
    expect(resolution.unresolved).toEqual([]);
  });

  it("matches an id case-insensitively and round-trips a long multi-line value", () => {
    const value = `${"x".repeat(220)}\nsecond line`;
    const resolution = resolveLiteralPlaceholders("[[lit:l1]]", [["L1", value]]);

    expect(resolution.markdown).toBe(value);
    expect(resolution.resolved).toBe(1);
    expect(resolution.unresolved).toEqual([]);
  });

  it("never re-scans a substituted value that itself contains marker syntax", () => {
    const resolution = resolveLiteralPlaceholders("[[lit:L1]]", [["L1", "[[lit:L2]]"], ["L2", "leaked"]]);

    expect(resolution.markdown).toBe("[[lit:L2]]");
    expect(resolution.resolved).toBe(1);
    expect(resolution.unresolved).toEqual([]);
  });
});

describe("literalMarkers / referencedLiterals", () => {
  it("returns trimmed marker bodies in reading order, de-duplicated case-insensitively", () => {
    expect(literalMarkers("[[lit:L1]] then [[lit: L2 ]] then [[lit:l1]]")).toEqual(["L1", "L2"]);
  });

  it("returns nothing for text with no marker span", () => {
    expect(literalMarkers("plain [brackets] and `code`")).toEqual([]);
  });

  it("ignores a double-bracket span that carries no lit: sentinel but reads the sentinel form", () => {
    const quoted = "wrangler.toml needs [[env.staging.analytics_engine_datasets]] and the route [[routes]]";

    expect(literalMarkers(quoted)).toEqual([]);
    expect(literalMarkers(`${quoted} plus [[lit:routes]]`)).toEqual(["routes"]);
  });

  it("returns the declared values a text references, in table order", () => {
    expect(referencedLiterals("use [[lit:L2]] and [[lit:L1]]", TABLE)).toEqual([
      "/api/search-text",
      "relation_not_allowed_for_entity",
    ]);
  });

  it("returns nothing for an absent or empty table", () => {
    expect(referencedLiterals("[[lit:L1]]", undefined)).toEqual([]);
    expect(referencedLiterals("[[lit:L1]]", [])).toEqual([]);
  });
});

describe("formatLiteralTable", () => {
  it("returns no lines for an absent or empty table", () => {
    expect(formatLiteralTable(undefined)).toEqual([]);
    expect(formatLiteralTable([])).toEqual([]);
  });

  it("renders a header, one [[lit:<id>]] = <json> line per entry, and a blank line", () => {
    expect(formatLiteralTable([["L1", "/api/search-text"], ["L2", 'say "hi"']])).toEqual([
      "LITERALS (each marker below must appear in your response exactly where its value belongs; Scribe substitutes the exact value afterwards — never type the value yourself)",
      '[[lit:L1]] = "/api/search-text"',
      '[[lit:L2]] = "say \\"hi\\""',
      "",
    ]);
  });
});

describe("mergeLiterals", () => {
  it("keeps reading order and drops a value an earlier kept one contains", () => {
    expect(mergeLiterals(["deriveVariantKey"], ["${dir}${base}.webp", "${dir}"])).toEqual([
      "deriveVariantKey",
      "${dir}${base}.webp",
    ]);
  });

  it("drops a duplicate across lists and trims each value", () => {
    expect(mergeLiterals(["  a b  "], ["a\nb", "c"])).toEqual(["a b", "c"]);
  });
});

describe("validateLiteralTable", () => {
  it("accepts an absent table and a well-formed one", () => {
    expect(() => validateLiteralTable(undefined)).not.toThrow();
    expect(() => validateLiteralTable([["L1", "value"], ["L-2_x", "another"]])).not.toThrow();
    expect(() => validateLiteralTable([["L1", "x".repeat(8000)]])).not.toThrow();
  });

  it("rejects a non-array table", () => {
    expect(() => validateLiteralTable("L1")).toThrow("literals: must be an array of [id, value] tuples.");
  });

  it("rejects an entry that is not a 2-element tuple", () => {
    expect(() => validateLiteralTable([["L1"]])).toThrow("literals[0]: must be a 2-element [id, value] tuple.");
  });

  it("rejects an id outside the grammar", () => {
    expect(() => validateLiteralTable([["1L", "value"]])).toThrow(
      'literals[0]: id must match [A-Za-z][A-Za-z0-9_-]{0,31} (1-32 characters), got "1L".',
    );
  });

  it("accepts a 32-character id and rejects a 33-character one", () => {
    const id32 = `T${"a".repeat(31)}`;
    expect(id32).toHaveLength(32);
    expect(() => validateLiteralTable([["TBL_ARTIST_SORTING", "value"]])).not.toThrow();
    expect(() => validateLiteralTable([[id32, "value"]])).not.toThrow();
    expect(() => validateLiteralTable([[`${id32}a`, "value"]])).toThrow(
      `literals[0]: id must match [A-Za-z][A-Za-z0-9_-]{0,31} (1-32 characters), got ${JSON.stringify(`${id32}a`)}.`,
    );
  });

  it("rejects two ids colliding under case folding", () => {
    expect(() => validateLiteralTable([["L1", "a"], ["l1", "b"]])).toThrow(
      'literals[1]: duplicate literal id "l1".',
    );
  });

  it("rejects a blank or non-string value", () => {
    expect(() => validateLiteralTable([["L1", "   "]])).toThrow(
      'literals[0] (id "L1"): value must be a non-empty string.',
    );
    expect(() => validateLiteralTable([["L1", 7]])).toThrow(
      'literals[0] (id "L1"): value must be a non-empty string.',
    );
  });

  it("rejects a value past the table bound", () => {
    expect(() => validateLiteralTable([["L1", "x".repeat(8001)]])).toThrow(
      'literals[0] (id "L1"): value is 8001 characters, exceeding the 8000-character bound.',
    );
  });

  it("reports every oversized entry in one throw, in table order", () => {
    expect(() =>
      validateLiteralTable([
        ["L1", "x".repeat(8001)],
        ["L2", "ok"],
        ["L3", "y".repeat(12000)],
      ]),
    ).toThrow(
      'literals[0] (id "L1"): value is 8001 characters, exceeding the 8000-character bound. literals[2] (id "L3"): value is 12000 characters, exceeding the 8000-character bound.',
    );
  });
});

describe("validateLiteralUsage", () => {
  it("accepts an absent or empty table, and a table whose ids are referenced", () => {
    expect(() => validateLiteralUsage(undefined, ["prose with no marker"])).not.toThrow();
    expect(() => validateLiteralUsage([], ["prose"])).not.toThrow();
    expect(() => validateLiteralUsage([["L1", "x"]], ["uses [[lit:L1]] here"])).not.toThrow();
  });

  it("accepts a marker whose case differs from the declared id", () => {
    expect(() => validateLiteralUsage([["L1", "x"]], ["uses [[lit:l1]] here"])).not.toThrow();
  });

  it("accepts prose quoting a bare double-bracket span when its own declared marker is referenced", () => {
    const table: ScribeLiteral[] = [["TOML", "[[env.staging.analytics_engine_datasets]]"]];

    expect(() =>
      validateLiteralUsage(table, [
        "Add the [[lit:TOML]] table header to wrangler.toml.",
        "Quote [[env.staging.analytics_engine_datasets]] and [[routes]] verbatim.",
      ]),
    ).not.toThrow();
  });

  it("throws naming every id no marker references", () => {
    expect(() => validateLiteralUsage([["L1", "x"], ["L2", "y"]], ["plain prose with no marker"])).toThrow(
      'literals: "L1", "L2" declared but never referenced as [[lit:<id>]] in the blueprint\'s prose; reference each one where its value belongs, or drop it.',
    );
  });

  it("rejects a marker no declared literal owns, table or none", () => {
    const expected =
      "literals: the blueprint's prose uses [[lit:emailsKey]], [[lit:policyName]] but no literal declares them; declare each id with the exact value it stands for, or drop the marker.";

    // The reported failure: markers written, no table declared at all.
    expect(() => validateLiteralUsage([], ["Context names [[lit:emailsKey]] and [[lit:policyName]]."])).toThrow(
      expected,
    );
    // An omitted table reaches the validator the same way.
    expect(() => validateLiteralUsage(undefined, ["Context names [[lit:emailsKey]] and [[lit:policyName]]."])).toThrow(
      expected,
    );
  });

  it("reads the singular form for one undeclared marker", () => {
    expect(() => validateLiteralUsage([], ["files: [[lit:emailsKey]]"])).toThrow(
      "literals: the blueprint's prose uses [[lit:emailsKey]] but no literal declares it; declare each id with the exact value it stands for, or drop the marker.",
    );
  });

  it("names only the undeclared remainder of a partly declared set", () => {
    expect(() => validateLiteralUsage([["L1", "x"]], ["uses [[lit:L1]] and [[lit:L9]]"])).toThrow(
      "literals: the blueprint's prose uses [[lit:L9]] but no literal declares it; declare each id with the exact value it stands for, or drop the marker.",
    );
  });

  it("names a repeated or differently cased marker once", () => {
    expect(() =>
      validateLiteralUsage([], ["[[lit:emailsKey]] then [[lit:emailsKey]] then [[lit:EMAILSKEY]]"]),
    ).toThrow(
      "literals: the blueprint's prose uses [[lit:emailsKey]] but no literal declares it; declare each id with the exact value it stands for, or drop the marker.",
    );
  });

  it("leaves a bare double-bracket span out of the undeclared check", () => {
    expect(() =>
      validateLiteralUsage([["L1", "x"]], ["uses [[lit:L1]] and quotes [[routes]] verbatim"]),
    ).not.toThrow();
  });
});
