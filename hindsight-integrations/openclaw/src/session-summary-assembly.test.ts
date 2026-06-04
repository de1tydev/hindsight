import { describe, expect, it } from "vitest";
import { composeSummaryRecallQuery } from "./session-summary-assembly.js";
import { FakeSessionSummaryGenerator } from "./session-summary-generator.js";

describe("session summary assembly", () => {
  it("O-S3-001 keeps latest recall query first and truncates summary first", () => {
    const latest = "What is the next rollout step for active-project?";
    const query = composeSummaryRecallQuery({
      latestQuery: latest,
      summaryText: "Active projects: active-project\nSemantic anchors: " + "s".repeat(500),
      maxChars: latest.length + 80,
    });

    expect(query.startsWith(latest)).toBe(true);
    expect(query.length).toBeLessThanOrEqual(latest.length + 80);
    expect(query).toContain("Rolling session summary:");
    expect(query).toContain("Semantic anchors:");
  });

  it("O-S3-001 no-summary fallback matches latest-query-only behavior", () => {
    const latest = "What theme do I prefer?";
    expect(composeSummaryRecallQuery({ latestQuery: latest, summaryText: "", maxChars: 800 })).toBe(
      latest
    );
    expect(
      composeSummaryRecallQuery({ latestQuery: latest, summaryText: "   ", maxChars: 800 })
    ).toBe(latest);
  });

  it("O-S3-003 fake extraction ignores operational metadata in the private fixture", () => {
    const combined = combinedSummaryFields(
      fakeExtract([
        'bank_id="saber-prod"',
        'source_system="openclaw"',
        'session_id="session-private"',
        'document_id="doc-private"',
        'update_mode="append"',
        "The active project is x-power-cli.",
      ])
    );

    expect(combined).toContain("x-power-cli");
    expect(combined).not.toContain("saber-prod");
    expect(combined).not.toContain("openclaw");
    expect(combined).not.toContain("doc-private");
  });

  it("O-S3-003 fake extraction ignores operational metadata in a generic fixture", () => {
    const combined = combinedSummaryFields(
      fakeExtract([
        '{"bankId":"bank-random","source":"source-random","sessionId":"session-random","documentId":"document-random","updateMode":"append","provider":"provider-random"}',
        "The real project is customer-portal-cli.",
      ])
    );

    expect(combined).toContain("customer-portal-cli");
    for (const forbidden of [
      "bank-random",
      "source-random",
      "session-random",
      "document-random",
      "provider-random",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it("O-S3-005 lineage alone is not semantic context", () => {
    const transcript = JSON.stringify([
      { role: "user", content: "Continue the rollout from the latest window." },
    ]);
    const lineage = JSON.stringify({
      session_id: "session-1",
      document_id: "openclaw:agent:main:session",
      updateMode: "append",
    });

    const lineageOnly = combinedSummaryFields(fakeExtract([lineage, transcript]));
    expect(lineageOnly).not.toContain("customer-portal-cli");
  });
});

function fakeExtract(parts: string[]): Record<string, unknown> {
  const result = new FakeSessionSummaryGenerator().generate({
    sessionId: "session-1",
    identityScope: "bank-1",
    messages: [{ role: "user", content: parts.join("\n") }],
    latestQuery: "Continue the rollout.",
    turnIndex: 8,
  });
  return result.summaryJson;
}

function combinedSummaryFields(summaryJson: Record<string, unknown>): string {
  return ["activeProjects", "semanticAnchors", "exactIdentifiers"]
    .flatMap((key) => (Array.isArray(summaryJson[key]) ? summaryJson[key] : []))
    .join(" ");
}
