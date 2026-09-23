import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appendBlueprintFailure,
  appendSavingsRun,
  formatSavingsDashboard,
  readStatsFile,
  SAVINGS_STATS_RELATIVE_PATH,
  type SavingsRunLogEntry,
  type SavingsStatsFile,
} from "../src/stats-store";

function makeEntry(overrides: Partial<SavingsRunLogEntry> = {}): SavingsRunLogEntry {
  return {
    timestamp: new Date().toISOString(),
    slug: "test-plan",
    brainModel: "anthropic/claude-opus-4-5",
    writerModel: "anthropic/claude-haiku-3-5",
    brainInputTokens: 1000,
    brainOutputTokens: 50,
    writerInputTokens: 2000,
    writerOutputTokens: 300,
    irOutputTokens: 42,
    docOutputTokens: 400,
    writerCostUsd: 0,
    actualCostUsd: 0.001,
    baselineCostUsd: 0.010,
    netSavingsUsd: 0.009,
    priced: true,
    ...overrides,
  };
}

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `scribe-test-${randomUUID()}`);
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("readStatsFile", () => {
  it("returns a zeroed structure when no file exists (ENOENT self-heal)", async () => {
    const stats = await readStatsFile(cwd);
    expect(stats.version).toBe(1);
    expect(stats.totalRuns).toBe(0);
    expect(stats.runs).toHaveLength(0);
  });

  it("returns zeroed structure for malformed JSON (self-heal)", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(cwd, SAVINGS_STATS_RELATIVE_PATH), "{ invalid json {{");
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(0);
  });

  it("returns zeroed structure when schema is wrong (self-heal)", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(cwd, SAVINGS_STATS_RELATIVE_PATH), JSON.stringify({ version: 2, data: [] }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(0);
  });
});

describe("appendSavingsRun", () => {
  it("writes and reads back a single run correctly", async () => {
    const entry = makeEntry();
    const returned = await appendSavingsRun(cwd, entry);
    expect(returned.totalRuns).toBe(1);
    expect(returned.runs).toHaveLength(1);
    expect(returned.runs[0]!.slug).toBe("test-plan");

    // Confirm durable write: fresh readStatsFile sees same data
    const reread = await readStatsFile(cwd);
    expect(reread.totalRuns).toBe(1);
    expect(reread.runs[0]!.slug).toBe("test-plan");
  });

  it("accumulates totals across multiple runs", async () => {
    const e1 = makeEntry({ brainInputTokens: 100, netSavingsUsd: 0.005 });
    const e2 = makeEntry({ brainInputTokens: 200, netSavingsUsd: 0.010 });
    await appendSavingsRun(cwd, e1);
    const stats = await appendSavingsRun(cwd, e2);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalBrainInputTokens).toBe(300);
    expect(stats.totalNetSavingsUsd).toBeCloseTo(0.015, 8);
  });

  it("counts unpriced runs separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ priced: true }));
    await appendSavingsRun(cwd, makeEntry({ priced: false }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalUnpricedRuns).toBe(1);
  });

  it("counts plan and doc runs separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ mode: "plan", slug: "a-plan" }));
    await appendSavingsRun(cwd, makeEntry({ mode: "doc", slug: "a-doc" }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalPlanRuns).toBe(1);
    expect(stats.totalDocRuns).toBe(1);
  });

  it("counts runs with an estimated baseline separately", async () => {
    await appendSavingsRun(cwd, makeEntry({ priced: false, baselineIsEstimate: true, actualCostUsd: 0, baselineCostUsd: 0.033 }));
    await appendSavingsRun(cwd, makeEntry()); // legacy entry: field absent, must not count
    await appendSavingsRun(cwd, makeEntry({ priced: false, baselineIsEstimate: true, actualCostUsd: 0, baselineCostUsd: 0.033 }));
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(3);
    expect(stats.totalEstimatedBaselineRuns).toBe(2);
  });

  it("accumulates blueprint tokens, treating entries without the field as zero", async () => {
    await appendSavingsRun(cwd, makeEntry({ irOutputTokens: 120 }));
    const legacy = makeEntry();
    delete legacy.irOutputTokens;
    const stats = await appendSavingsRun(cwd, legacy);
    expect(stats.totalIrOutputTokens).toBe(120);
  });

  it("accumulates returned-document tokens, falling back to writer output for legacy entries", async () => {
    // A pre-existing ledger has no totalDocOutputTokens: the first append must seed
    // it from the logged runs' own measures, then add the new entry's measure.
    const seeded = await appendSavingsRun(cwd, makeEntry({ docOutputTokens: 400, writerOutputTokens: 300 }));
    expect(seeded.totalDocOutputTokens).toBe(400);

    const legacy = makeEntry({ writerOutputTokens: 250 });
    delete legacy.docOutputTokens;
    const stats = await appendSavingsRun(cwd, legacy);
    // 400 (first run) + 250 (legacy run measures its raw writer output)
    expect(stats.totalDocOutputTokens).toBe(650);
  });

  it("seeds the document total from an existing run log that predates the field", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    // Pre-change shape: a valid file whose runs carry no per-run docOutputTokens.
    await Bun.write(
      join(cwd, SAVINGS_STATS_RELATIVE_PATH),
      JSON.stringify({
        version: 1,
        totalRuns: 1,
        totalUnpricedRuns: 0,
        totalActualCostUsd: 0,
        totalBaselineCostUsd: 0,
        totalNetSavingsUsd: 0,
        totalBrainInputTokens: 0,
        totalBrainOutputTokens: 0,
        totalWriterInputTokens: 0,
        totalWriterOutputTokens: 300,
        blueprintCallsTotal: 0,
        blueprintCallsFailed: 0,
        runs: [makeEntry({ docOutputTokens: undefined, writerOutputTokens: 300 })],
      }),
    );

    const stats = await appendSavingsRun(cwd, makeEntry({ docOutputTokens: 400 }));
    // 300 seeded from the legacy run log + 400 from the new entry
    expect(stats.totalDocOutputTokens).toBe(700);
  });

  it("prepends new entries (most-recent-first)", async () => {
    const e1 = makeEntry({ slug: "first" });
    const e2 = makeEntry({ slug: "second" });
    await appendSavingsRun(cwd, e1);
    await appendSavingsRun(cwd, e2);
    const stats = await readStatsFile(cwd);
    expect(stats.runs[0]!.slug).toBe("second");
    expect(stats.runs[1]!.slug).toBe("first");
  });

  it("caps runs array at 200 entries", async () => {
    // Write 201 entries sequentially to verify the 200-entry cap
    for (let i = 0; i < 201; i++) {
      await appendSavingsRun(cwd, makeEntry({ slug: `plan-${i}` }));
    }
    const stats = await readStatsFile(cwd);
    expect(stats.totalRuns).toBe(201);
    expect(stats.runs).toHaveLength(200);
    // Most recent first: plan-200 should be at index 0
    expect(stats.runs[0]!.slug).toBe("plan-200");
  });

  it("atomic write: produces a valid JSON file (no leftover .tmp files)", async () => {
    const entry = makeEntry();
    await appendSavingsRun(cwd, entry);
    const statsPath = join(cwd, SAVINGS_STATS_RELATIVE_PATH);
    const raw = await readFile(statsPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    // No sibling tmp files left
    const dir = join(cwd, ".claude", "plans");
    const files = await readdir(dir);
    expect(files.filter((f: string) => f.includes(".tmp-"))).toHaveLength(0);
  });
});

describe("appendBlueprintFailure", () => {
  it("increments both blueprintCallsTotal and blueprintCallsFailed atomically", async () => {
    const stats = await appendBlueprintFailure(cwd);
    expect(stats.blueprintCallsTotal).toBe(1);
    expect(stats.blueprintCallsFailed).toBe(1);

    const again = await appendBlueprintFailure(cwd);
    expect(again.blueprintCallsTotal).toBe(2);
    expect(again.blueprintCallsFailed).toBe(2);

    // Confirm durable write: fresh readStatsFile sees same data
    const reread = await readStatsFile(cwd);
    expect(reread.blueprintCallsTotal).toBe(2);
    expect(reread.blueprintCallsFailed).toBe(2);
  });

  it("does not increment blueprintCallsFailed on a successful run", async () => {
    await appendSavingsRun(cwd, makeEntry());
    const stats = await appendBlueprintFailure(cwd);
    expect(stats.blueprintCallsTotal).toBe(2);
    expect(stats.blueprintCallsFailed).toBe(1);
  });

  it("self-heals a pre-migration file missing blueprintCallsTotal/blueprintCallsFailed instead of crashing", async () => {
    const dir = join(cwd, ".claude", "plans");
    await mkdir(dir, { recursive: true });
    // Pre-migration shape: valid version/runs/totalRuns, but no blueprint-call counters.
    await Bun.write(
      join(cwd, SAVINGS_STATS_RELATIVE_PATH),
      JSON.stringify({ version: 1, totalRuns: 7, totalNetSavingsUsd: 1.23, runs: [] }),
    );
    const stats = await appendBlueprintFailure(cwd);
    // Self-healed to a zeroed structure before incrementing — prior totals are not preserved.
    expect(stats.totalRuns).toBe(0);
    expect(stats.blueprintCallsTotal).toBe(1);
    expect(stats.blueprintCallsFailed).toBe(1);
  });
});

describe("formatSavingsDashboard", () => {
  it("renders a non-empty box for zero-run stats", () => {
    const empty: SavingsStatsFile = {
      version: 1,
      totalRuns: 0,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(empty);
    expect(output).toContain("SCRIBE COST-SAVINGS DASHBOARD");
    expect(output).toContain("Total plan-mode runs");
    // No recent-run section when runs is empty
    expect(output).not.toContain("Recent runs:");
    // No estimate marker or note when no baseline was estimated
    expect(output).not.toContain("~$");
    expect(output).not.toContain("not billed amounts");
  });

  it("renders 'n/a' for blueprint reliability when no blueprint calls were made", () => {
    const empty: SavingsStatsFile = {
      version: 1,
      totalRuns: 0,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const row = formatSavingsDashboard(empty)
      .split("\n")
      .find(line => line.includes("Blueprint reliability"));
    expect(row).toContain("n/a");
  });

  it("renders passed/total and a first-try percentage for blueprint reliability", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 3,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      blueprintCallsTotal: 4,
      blueprintCallsFailed: 1,
      runs: [],
    };
    const row = formatSavingsDashboard(stats)
      .split("\n")
      .find(line => line.includes("Blueprint reliability"));
    expect(row).toContain("3/4");
    expect(row).toContain("75%");
  });

  it("renders the doc-mode run count", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 4,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      totalPlanRuns: 1,
      totalDocRuns: 2,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(stats);
    const docLine = output.split("\n").find(line => line.includes("Total doc-mode runs"));
    expect(docLine).toContain("2");
  });

  it("includes unpriced warning when totalUnpricedRuns > 0", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 1,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(stats);
    expect(output).toContain("no known per-token output rate in the catalog");
  });

  it("estimates brain output without scribe from the returned document, not the writer's raw output", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      // The writer's raw output (3,000) is deliberately larger than the returned
      // document (600): the estimate must follow the document, not the raw usage.
      totalWriterOutputTokens: 3000,
      totalIrOutputTokens: 400,
      totalDocOutputTokens: 600,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const lines = formatSavingsDashboard(stats).split("\n");
    const withoutScribe = lines.find(line => line.includes("Estimated brain tokens output without scribe"));
    // 2,000 brain output − 400 blueprint + 600 returned document
    expect(withoutScribe).toContain("2,200");
    expect(lines.find(line => line.includes("Blueprint tokens (brain, est.)"))).toContain("400");
    expect(lines.find(line => line.includes("Delegated doc tokens (est.)"))).toContain("600");
  });

  it("seeds the delegated doc total from the run log when a pre-existing file lacks it", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 2,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 600,
      totalIrOutputTokens: 400,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [
        makeEntry({ docOutputTokens: 400 }), // measured the new way: 400
        makeEntry({ docOutputTokens: undefined, writerOutputTokens: 300 }), // legacy: falls back to 300
      ],
    };
    const lines = formatSavingsDashboard(stats).split("\n");
    expect(lines.find(line => line.includes("Delegated doc tokens (est.)"))).toContain("700");
    // 2,000 brain output − 400 blueprint + (400 + 300) seeded document tokens
    expect(lines.find(line => line.includes("Estimated brain tokens output without scribe"))).toContain("2,300");
  });

  it("reads zero delegated doc tokens when the file lacks both the total and any run log", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 3000,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const lines = formatSavingsDashboard(stats).split("\n");
    expect(lines.find(line => line.includes("Blueprint tokens (brain, est.)"))).toContain("0");
    expect(lines.find(line => line.includes("Delegated doc tokens (est.)"))).toContain("0");
    // Nothing is credited back, so the estimate is the brain output alone.
    expect(lines.find(line => line.includes("Estimated brain tokens output without scribe"))).toContain("2,000");
  });

  it("explains the writer-usage vs returned-document difference in a footnote", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0,
      totalNetSavingsUsd: 0,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 2000,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 3000,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [],
    };
    const output = formatSavingsDashboard(stats);
    expect(output).toContain('"Writer tokens output" is the writer model\'s raw usage');
    expect(output).toContain("without-scribe row uses that figure");
  });

  it("flags an @plan-role estimated baseline with a ~$ marker and note", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 1,
      totalActualCostUsd: 0,
      totalBaselineCostUsd: 0.033,
      totalNetSavingsUsd: 0.033,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 50,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 2000,
      totalEstimatedBaselineRuns: 1,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [
        makeEntry({
          priced: false,
          baselineIsEstimate: true,
          actualCostUsd: 0,
          baselineCostUsd: 0.033,
          netSavingsUsd: 0.033,
        }),
      ],
    };
    const output = formatSavingsDashboard(stats);

    const estimateRow = output.split("\n").find(line => line.includes("Baseline via @plan-role estimate"));
    expect(estimateRow).toContain("1");

    const savingsLine = output.split("\n").find(line => line.includes("Total net savings"));
    expect(savingsLine).toContain("~$0.0330");

    // The recent-run row carries the ~$ marker rather than reading "unpriced"
    const recentLine = output.split("\n").find(line => line.includes("test-plan"));
    expect(recentLine).toContain("~$0.0330");
    expect(output).not.toContain("unpriced");

    expect(output).toContain("not billed amounts");
  });

  it("truncates slug to 28 chars in recent run rows", async () => {
    const entry = makeEntry({ slug: "a-very-long-slug-name-that-exceeds-28-chars" });
    await appendSavingsRun(cwd, entry);
    const stats = await readStatsFile(cwd);
    const output = formatSavingsDashboard(stats);
    // Slug > 28 chars → truncated with "..."
    expect(output).toContain("...");
  });

  it("shows all 5 recent runs when runs.length === 5", () => {
    const runs: SavingsRunLogEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ slug: `plan-${i}`, timestamp: new Date(Date.now() - i * 1000).toISOString() }),
    );
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 5,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0.005,
      totalBaselineCostUsd: 0.05,
      totalNetSavingsUsd: 0.045,
      totalBrainInputTokens: 0,
      totalBrainOutputTokens: 0,
      totalWriterInputTokens: 0,
      totalWriterOutputTokens: 0,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs,
    };
    const output = formatSavingsDashboard(stats);
    // All 5 run slugs appear
    for (let i = 0; i < 5; i++) {
      expect(output).toContain(`plan-${i}`);
    }
  });

  it("each row fits exactly 66 chars (64 inner + 2 border)", () => {
    const stats: SavingsStatsFile = {
      version: 1,
      totalRuns: 1,
      totalUnpricedRuns: 0,
      totalActualCostUsd: 0.001,
      totalBaselineCostUsd: 0.010,
      totalNetSavingsUsd: 0.009,
      totalBrainInputTokens: 1000,
      totalBrainOutputTokens: 50,
      totalWriterInputTokens: 2000,
      totalWriterOutputTokens: 300,
      blueprintCallsTotal: 0,
      blueprintCallsFailed: 0,
      runs: [makeEntry()],
    };
    const output = formatSavingsDashboard(stats);
    for (const line of output.split("\n")) {
      if (line.startsWith("╔") || line.startsWith("╟") || line.startsWith("╚") || line.startsWith("║")) {
        expect(line.length).toBe(66);
      }
    }
  });
});
