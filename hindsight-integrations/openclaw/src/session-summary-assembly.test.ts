import { describe, expect, it } from "vitest";
import { composeSummaryRecallQuery } from "./session-summary-assembly.js";
import { FakeSessionSummaryGenerator } from "./session-summary-generator.js";

describe("session summary assembly", () => {
  it("keeps latest recall query first and truncates summary first", () => {
    const latest = "What is the next rollout step for active-project?";
    const query = composeSummaryRecallQuery({
      latestQuery: latest,
      summaryText: "Continuing active-project rollout. " + "s".repeat(500),
      maxChars: latest.length + 80,
    });

    expect(query.startsWith(latest)).toBe(true);
    expect(query.length).toBeLessThanOrEqual(latest.length + 80);
    expect(query).toContain("Rolling session summary:");
    expect(query).toContain("active-project");
  });

  it("no-summary fallback matches latest-query-only behavior", () => {
    const latest = "What theme do I prefer?";
    expect(composeSummaryRecallQuery({ latestQuery: latest, summaryText: "", maxChars: 800 })).toBe(
      latest
    );
    expect(
      composeSummaryRecallQuery({ latestQuery: latest, summaryText: "   ", maxChars: 800 })
    ).toBe(latest);
  });

  it("fake summary keeps useful message text but ignores operational metadata", () => {
    const result = fakeSummaryText([
      'bank_id="saber-prod"',
      'source_system="openclaw"',
      'session_id="session-private"',
      'document_id="doc-private"',
      'update_mode="append"',
      "The active project is x-power-cli.",
    ]);

    expect(result).toContain("x-power-cli");
    expect(result).not.toContain("saber-prod");
    expect(result).not.toContain("openclaw");
    expect(result).not.toContain("doc-private");
  });

  it("lineage alone is not semantic context", () => {
    const transcript = JSON.stringify([
      { role: "user", content: "Continue the rollout from the latest window." },
    ]);
    const lineage = JSON.stringify({
      session_id: "session-1",
      document_id: "openclaw:agent:main:session",
      updateMode: "append",
    });

    const summary = fakeSummaryText([lineage, transcript]);
    expect(summary).not.toContain("customer-portal-cli");
  });
});

function fakeSummaryText(parts: string[]): string {
  const result = new FakeSessionSummaryGenerator().generate({
    sessionId: "session-1",
    identityScope: "bank-1",
    messages: [{ role: "user", content: parts.join("\n") }],
    latestQuery: "Continue the rollout.",
    turnIndex: 8,
  });
  return result.summaryText;
}
