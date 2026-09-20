import { describe, expect, it } from "bun:test";
import { computeCosts } from "../src/pricing";

describe("computeCosts", () => {
  it("computes actual and baseline when brainOutputRatePerMillionUsd is nonzero (priced)", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 1.65,   // input + exploration/thinking output component
      writerActualCostUsd: 0.008,
      brainOutputRatePerMillionUsd: 15, // e.g. claude-3-opus output rate
      writerOutputTokens: 1000,
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 3,   // present but must be ignored on the priced path
      referenceOutputRatePerMillionUsd: 15,
    });

    expect(result.priced).toBe(true);
    expect(result.baselineIsEstimate).toBe(false);

    // actual = brain total + writer total
    expect(result.actualCostUsd).toBeCloseTo(1.65 + 0.008, 8);

    // baseline = brain total turn cost + writerOutputTokens * rate / 1e6
    const expectedBaseline = 1.65 + (1000 * 15) / 1e6;
    expect(result.baselineCostUsd).toBeCloseTo(expectedBaseline, 8);

    // net savings = max(0, baseline - actual)
    expect(result.netSavingsUsd).toBeCloseTo(Math.max(0, expectedBaseline - (1.65 + 0.008)), 8);
  });

  it("sets priced:false when brainOutputRatePerMillionUsd is zero", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      writerOutputTokens: 5000,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 0,  // reference model unavailable
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
    // baseline reduces to just brainActualTotalCostUsd (the writerOutputTokens term vanishes)
    expect(result.baselineCostUsd).toBeCloseTo(0, 8);
    expect(result.actualCostUsd).toBeCloseTo(0, 8);
    expect(result.netSavingsUsd).toBe(0);
  });

  it("baseline reduces to brainActualTotalCostUsd when rate is zero even with nonzero tokens", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0.50,
      writerActualCostUsd: 0.002,
      brainOutputRatePerMillionUsd: 0,
      writerOutputTokens: 10_000,
      brainInputTokens: 20_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
    // rate=0 → the writer-token term vanishes, so the baseline is the brain's own turn cost
    expect(result.baselineCostUsd).toBeCloseTo(0.50, 8);
    expect(result.actualCostUsd).toBeCloseTo(0.502, 8);
    // baseline (0.50) < actual (0.502) → savings clamped at 0
    expect(result.netSavingsUsd).toBe(0);
  });

  it("netSavingsUsd is zero when actual exceeds baseline", () => {
    // Contrive a case where actual > baseline: high writer cost with tiny brain output rate.
    const result = computeCosts({
      brainActualTotalCostUsd: 0.001,
      writerActualCostUsd: 50.00, // very expensive writer
      brainOutputRatePerMillionUsd: 0.28, // low output rate
      writerOutputTokens: 1000,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.netSavingsUsd).toBe(0);
  });

  it("local model with all-zero costs produces zeroed result with priced:false", () => {
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      writerOutputTokens: 3000,
      brainInputTokens: 1200,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.actualCostUsd).toBe(0);
    expect(result.baselineCostUsd).toBe(0);
    expect(result.netSavingsUsd).toBe(0);
    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(false);
  });

  it("produces nonzero baseline and savings for a fully local brain run when a @plan reference rate is available", () => {
    // Regression: a local/custom brain model charges nothing and has no catalog
    // rate, so both baseline and net savings previously collapsed to $0.00 even
    // though the writer output still cost the brain model real money to produce.
    const result = computeCosts({
      brainActualTotalCostUsd: 0,
      writerActualCostUsd: 0,
      brainOutputRatePerMillionUsd: 0,
      writerOutputTokens: 2000,
      brainInputTokens: 1000,
      referenceInputRatePerMillionUsd: 3,   // e.g. claude-3-opus input rate
      referenceOutputRatePerMillionUsd: 15, // e.g. claude-3-opus output rate
    });

    expect(result.priced).toBe(false);
    expect(result.baselineIsEstimate).toBe(true);
    expect(result.actualCostUsd).toBe(0);

    // baseline = (brainInputTokens * ref input rate + writerOutputTokens * ref output rate) / 1e6
    const expectedBaseline = (1000 * 3 + 2000 * 15) / 1e6;
    expect(result.baselineCostUsd).toBeCloseTo(expectedBaseline, 8);
    expect(result.netSavingsUsd).toBeCloseTo(expectedBaseline, 8);
  });

  it("keeps net savings positive when a large shared exploration cost cancels out", () => {
    // Regression: the baseline used to price only the brain's *input* cost, so the
    // brain's own exploration/thinking output cost appeared on the actual side only.
    // The baseline then fell below the actual cost and every run clamped to $0.00
    // even though delegating the Markdown to the writer still saved real money.
    const result = computeCosts({
      brainActualTotalCostUsd: 2.00, // large shared exploration cost, identical in both scenarios
      writerActualCostUsd: 0,        // free local writer, so the whole delegation delta is saved
      brainOutputRatePerMillionUsd: 15,
      writerOutputTokens: 3000,
      brainInputTokens: 500_000,
      referenceInputRatePerMillionUsd: 0,
      referenceOutputRatePerMillionUsd: 0,
    });

    expect(result.priced).toBe(true);
    expect(result.baselineIsEstimate).toBe(false);
    // baseline = the brain's own turn cost + the writer's tokens priced at the brain's rate
    expect(result.baselineCostUsd).toBeCloseTo(2.00 + 0.045, 8);
    expect(result.actualCostUsd).toBeCloseTo(2.00, 8);
    // The shared 2.00 cancels; only the 0.045 delegation delta remains
    expect(result.netSavingsUsd).toBeCloseTo(0.045, 8);
  });
});
