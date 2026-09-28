/**
 * Token-economics harness — `bun run measure`.
 *
 * Hydrates the checked-in fixture plan through the extension's own path
 * (`resolveScribeSteps` → `hydrateScribeStep` → `buildPlanPromptText`) and
 * prints the real `countTokens` cost of every stage of the writer pipeline,
 * plus the two wire formats the tuple IR was chosen over.
 *
 * Every row is measured with the host's native tokenizer in the fixture's
 * encoding and the reference encodings beside it. A platform whose
 * `@oh-my-pi/pi-natives` addon does not resolve is a hard failure: this harness
 * never prints a character estimate as if it were a measurement.
 */
import type { Model } from "@oh-my-pi/pi-catalog";
import { resolveTokenCounter, tokenBreakdown, type TokenCounter } from "../src/token-accounting";
import { WRITER_SYSTEM_PROMPT } from "../src/writer-session";
import {
  loadTokenFixture,
  loadTokenFixtureWithUncappedSnippets,
  renderCompactDsl,
  renderProseEquivalent,
  tupleJson,
} from "../tests/support/token-fixture";

/** Writer input the pre-change pipeline was recorded at: 796 tokens of system
 *  prompt plus a 5,225-token brief, 4,558 of which were hydrated snippets. */
const RECORDED_PRE_CHANGE_WRITER_INPUT = 6021;

/** Reduction the writer input must show against {@link RECORDED_PRE_CHANGE_WRITER_INPUT}. */
const REQUIRED_REDUCTION = 0.35;

/** Ceiling on the tuple IR's cost relative to a prose rendering of the same plan. */
const MAX_JSON_OVER_PROSE = 1.15;

const ENCODINGS: ReadonlyArray<{ label: string; model: Pick<Model, "tokenizer"> }> = [
  { label: "deepseek-v3", model: { tokenizer: "deepseek-v3" } },
  { label: "claude-v3", model: { tokenizer: "claude-v3" } },
  { label: "O200kBase", model: {} },
];

const fixture = await loadTokenFixture();
const capped = await loadTokenFixtureWithUncappedSnippets();

const counters: Array<{ label: string; counter: TokenCounter }> = [];
for (const { label, model } of ENCODINGS) {
  const counter = await resolveTokenCounter(model);
  if (!counter.exact) {
    console.error(
      `No exact tokenizer for ${label}: the native @oh-my-pi/pi-natives addon did not resolve for this platform.\n` +
        "Install dependencies (npm install) before measuring — this harness never prints estimates as measurements.",
    );
    process.exit(1);
  }
  counters.push({ label, counter });
}

const stages: ReadonlyArray<{ label: string; text: string }> = [
  { label: "tuple JSON (planner payload)", text: tupleJson(fixture.plan) },
  { label: "prose equivalent", text: renderProseEquivalent(fixture.plan) },
  { label: "compact DSL", text: renderCompactDsl(fixture.plan) },
  { label: "writer system prompt", text: WRITER_SYSTEM_PROMPT },
  { label: "writer brief", text: fixture.brief },
  { label: "  of which hydrated snippets", text: fixture.snippetText },
  { label: "writer brief (200-line cap)", text: capped.brief },
  { label: "  of which snippets (200-line cap)", text: capped.snippetText },
];

const countsByStage = stages.map(stage => {
  const breakdown = tokenBreakdown(counters[0].counter, { [stage.label]: stage.text });
  return { label: stage.label, counts: counters.map(entry => entry.counter.count(stage.text)), exact: breakdown.exact };
});

const totals = counters.map(entry => entry.counter.count(WRITER_SYSTEM_PROMPT) + entry.counter.count(fixture.brief));
const cappedTotals = counters.map(entry => entry.counter.count(WRITER_SYSTEM_PROMPT) + entry.counter.count(capped.brief));

const width = Math.max(...stages.map(stage => stage.label.length), "writer input total".length, "stage".length);
const columnWidths = counters.map((entry, index) => {
  const values = [...countsByStage.map(row => String(row.counts[index])), String(totals[index]), String(cappedTotals[index])];
  return Math.max(entry.label.length, ...values.map(value => value.length)) + 2;
});

const pad = (text: string, width: number): string => text.padStart(width);
const row = (label: string, cells: readonly string[]): string =>
  `${label.padEnd(width)}${cells.map((cell, index) => pad(cell, columnWidths[index])).join("")}`;

console.log("Token economics — writer pipeline, measured with the host's native tokenizer\n");
console.log(row("stage", counters.map(entry => entry.label)));
console.log(row("", counters.map(entry => (entry.counter.exact ? "exact" : "estimated"))));
console.log("-".repeat(width + columnWidths.reduce((sum, value) => sum + value, 0)));
for (const counts of countsByStage) console.log(row(counts.label, counts.counts.map(String)));
console.log("-".repeat(width + columnWidths.reduce((sum, value) => sum + value, 0)));
console.log(row("writer input total", totals.map(String)));
console.log(row("writer input total (200-line cap)", cappedTotals.map(String)));

const [primary] = counters;
const primaryIndex = 0;
const jsonTokens = countsByStage[0].counts[primaryIndex];
const proseTokens = countsByStage[1].counts[primaryIndex];
const dslTokens = countsByStage[2].counts[primaryIndex];
const briefTokens = countsByStage[4].counts[primaryIndex];
const snippetTokens = countsByStage[5].counts[primaryIndex];
const cappedBriefTokens = countsByStage[6].counts[primaryIndex];
const cappedSnippetTokens = countsByStage[7].counts[primaryIndex];

const reduction = 1 - totals[primaryIndex] / RECORDED_PRE_CHANGE_WRITER_INPUT;
const capReduction = 1 - totals[primaryIndex] / cappedTotals[primaryIndex];
const jsonOverProse = jsonTokens / proseTokens;

console.log(`\n${primary.label} (${primary.counter.encoding}):`);
console.log(`  tuple JSON ${jsonTokens} vs prose ${proseTokens} = ${jsonOverProse.toFixed(3)}x (ceiling ${MAX_JSON_OVER_PROSE}x) — a compact DSL saves only ${(1 - dslTokens / jsonTokens) * 100 > 0 ? ((1 - dslTokens / jsonTokens) * 100).toFixed(1) : "0.0"}% more`);
console.log(`  writer input ${totals[primaryIndex]} tokens (system ${countsByStage[3].counts[primaryIndex]}, brief ${briefTokens}, snippets ${snippetTokens})`);
console.log(`  recorded pre-change baseline ${RECORDED_PRE_CHANGE_WRITER_INPUT} -> reduction ${(reduction * 100).toFixed(1)}% (required ${(REQUIRED_REDUCTION * 100).toFixed(0)}%)`);
console.log(`  on the same fixture, the 200-line snippet cap gave ${cappedSnippetTokens} snippet tokens vs ${snippetTokens} now: brief ${cappedBriefTokens} -> ${briefTokens}, writer input reduction ${(capReduction * 100).toFixed(1)}%`);

const failed = [
  reduction < REQUIRED_REDUCTION ? `writer input reduction ${(reduction * 100).toFixed(1)}% < ${(REQUIRED_REDUCTION * 100).toFixed(0)}%` : "",
  jsonOverProse > MAX_JSON_OVER_PROSE ? `tuple JSON / prose ${jsonOverProse.toFixed(3)}x > ${MAX_JSON_OVER_PROSE}x` : "",
].filter(entry => entry !== "");

if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.join("; ")}`);
  process.exit(1);
}
console.log("\nPASS: every measured target holds.");
