import {
  type SessionSummaryBudget,
  DEFAULT_SESSION_SUMMARY_BUDGET,
  sanitizeSessionSummaryText,
} from "./session-summary-generator.js";

const RECALL_SUMMARY_HEADER = "Rolling session summary:";
const RETAIN_SUMMARY_HEADER = "Rolling session summary for extraction context:";
const PROMPT_SUMMARY_TITLE = "Hindsight rolling session summary";

export interface SessionSummaryAssemblyConfig {
  sessionSummaryEnrichRecallQuery: boolean;
  sessionSummaryEnrichRetainContext: boolean;
  sessionSummaryInjectPrompt: boolean;
  sessionSummaryMaxRecallQueryChars: number;
  sessionSummaryMaxRetainContextChars: number;
  sessionSummaryMaxPromptInjectChars: number;
}

export function composeSummaryRecallQuery(input: {
  latestQuery: string;
  summaryText?: string | null;
  maxChars: number;
  budget?: Partial<SessionSummaryBudget>;
}): string {
  const limit = recallLimit(input.maxChars, input.budget);
  if (limit <= 0) return "";
  const latest = String(input.latestQuery ?? "")
    .trim()
    .slice(0, limit);

  const summary = sanitizeSessionSummaryText(input.summaryText ?? "");
  if (!summary) return latest;
  if (latest.length >= limit) return latest;

  const summaryBudget = limit - latest.length - 2;
  if (summaryBudget <= RECALL_SUMMARY_HEADER.length) return latest;
  const block = boundedBlock(RECALL_SUMMARY_HEADER, summary, summaryBudget);
  if (!block) return latest;
  if (!latest) return block.slice(0, limit).trimEnd();
  return `${latest}\n\n${block}`.slice(0, limit).trimEnd();
}

export function buildSummaryRetainContext(input: {
  baseContext?: string | null;
  summaryText?: string | null;
  maxChars: number;
}): string {
  const base = String(input.baseContext ?? "");
  const summary = sanitizeSessionSummaryText(input.summaryText ?? "", {
    maxChars: Math.max(0, Math.trunc(input.maxChars || 0)),
  });
  if (!summary) return base;

  const block = `${RETAIN_SUMMARY_HEADER}\n${summary}`;
  return base ? `${base}\n\n${block}` : block;
}

export function renderSummaryPromptBlock(input: {
  summaryText?: string | null;
  maxChars: number;
}): string {
  const summary = sanitizeSessionSummaryText(input.summaryText ?? "", {
    maxChars: Math.max(0, Math.trunc(input.maxChars || 0)),
  });
  if (!summary) return "";
  return [
    "<hindsight_session_summary>",
    PROMPT_SUMMARY_TITLE,
    summary,
    "</hindsight_session_summary>",
  ].join("\n");
}

function recallLimit(maxChars: number, partialBudget?: Partial<SessionSummaryBudget>): number {
  const limit = Math.max(0, Math.trunc(maxChars || 0));
  if (!partialBudget) return limit;
  const budget = { ...DEFAULT_SESSION_SUMMARY_BUDGET, ...partialBudget };
  const ratioLimit = Math.trunc(
    Math.max(0, budget.maxInputChars) * Math.max(0, budget.recallQueryBudgetRatio)
  );
  return Math.min(limit, Math.max(0, Math.min(budget.maxRecallQueryChars, ratioLimit)));
}

function boundedBlock(header: string, body: string, maxChars: number): string {
  const limit = Math.max(0, Math.trunc(maxChars || 0));
  if (limit <= 0) return "";
  const cleanHeader = header.trim();
  const bodyBudget = limit - cleanHeader.length - 1;
  if (bodyBudget <= 0) return cleanHeader.slice(0, limit).trimEnd();
  const cleanBody = sanitizeSessionSummaryText(body, { maxChars: bodyBudget });
  if (!cleanBody) return "";
  return `${cleanHeader}\n${cleanBody}`.slice(0, limit).trimEnd();
}
