export const SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION = 1;

const OPERATIONAL_METADATA_KEYS = new Set([
  "agent",
  "agent_id",
  "bank",
  "bank_id",
  "channel",
  "channel_id",
  "message_id",
  "profile",
  "provider",
  "sender",
  "sender_id",
  "session",
  "session_id",
  "session_key",
  "source",
  "source_system",
  "thread",
  "thread_id",
  "tool",
  "tool_call_id",
  "user_id",
]);

const INJECTION_RE =
  /\b(ignore|override|forget|bypass)\b.{0,80}\b(previous|system|developer|instructions?)\b|\b(reveal|print|exfiltrate|leak)\b.{0,80}\b(secret|token|prompt|credentials?)\b|\bdo\s+not\s+(store|summari[sz]e|sanitize)\b/i;
const CANARY_RE =
  /\b[A-Z0-9_]*(?:SECRET|CANARY|DO_NOT_STORE|DO_NOT_LEAK|SHOULD_NOT_APPEAR)[A-Z0-9_]*\b|\/private\/[^\s`'"<>]+|\bsha256:[a-fA-F0-9]{32,64}\b/gi;
const SECRET_RE = /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*['"]?[^'"\s,;]+/gi;
const METADATA_BLOCK_RE = /[\w\s]+\(untrusted metadata\)[^\n]*\n```json\n[\s\S]*?```/gi;
const MEMORY_TAG_RE =
  /<(?:hindsight_memories|relevant_memories)>[\s\S]*?<\/(?:hindsight_memories|relevant_memories)>/gi;
const IDENTIFIER_RE = /\b[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+\b/g;
const PROJECT_CUE_RE =
  /\b(?:project|repo|repository|package|module|app|service|workspace)\s+([A-Za-z][\w.-]{2,})/gi;

export interface SessionSummaryBudget {
  maxInputChars: number;
  maxOutputChars: number;
  maxRecallQueryChars: number;
  recallQueryBudgetRatio: number;
  maxPromptInjectChars: number;
  maxRetainContextChars: number;
  minLatestQueryReserveChars: number;
  dropCompletedTodosAfterTurns: number;
}

export const DEFAULT_SESSION_SUMMARY_BUDGET: SessionSummaryBudget = {
  maxInputChars: 16_000,
  maxOutputChars: 2_000,
  maxRecallQueryChars: 800,
  recallQueryBudgetRatio: 0.25,
  maxPromptInjectChars: 1_200,
  maxRetainContextChars: 1_200,
  minLatestQueryReserveChars: 400,
  dropCompletedTodosAfterTurns: 20,
};

export interface SessionSummaryRequest {
  sessionId: string;
  identityScope: string;
  messages: Array<Record<string, unknown>>;
  previousSummary?: Record<string, unknown> | null;
  latestQuery?: string;
  turnIndex?: number;
  metadata?: Record<string, unknown>;
  budget?: Partial<SessionSummaryBudget>;
}

export interface SessionSummaryResult {
  summaryJson: Record<string, unknown>;
  summaryText: string;
  schemaVersion: number;
  status: "ready" | "error";
  error?: string;
}

export interface SessionSummaryGenerator {
  generate(request: SessionSummaryRequest): Promise<SessionSummaryResult> | SessionSummaryResult;
}

export function sanitizeSessionSummaryText(
  text: string,
  options: { maxChars?: number } = {}
): string {
  if (!text) return "";
  let cleaned = String(text).replace(MEMORY_TAG_RE, "");
  cleaned = cleaned.replace(METADATA_BLOCK_RE, "");
  cleaned = cleaned.replace(SECRET_RE, "[redacted-secret]");
  const kept: string[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(CANARY_RE, "[redacted]").trim();
    if (!line || INJECTION_RE.test(line)) continue;
    kept.push(line);
  }
  cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (options.maxChars !== undefined && options.maxChars >= 0 && cleaned.length > options.maxChars) {
    return cleaned.slice(0, options.maxChars).trimEnd();
  }
  return cleaned;
}

export function buildSessionSummaryPrompt(request: SessionSummaryRequest): string {
  const trimmed = trimSessionSummaryInputs(request, resolveBudget(request.budget));
  const messages = trimmed.messages.map((msg) => ({
    role: String(msg.role ?? ""),
    content: sanitizeSessionSummaryText(String(msg.content ?? "")),
  }));
  return [
    "Generate a compact Hindsight session summary as JSON only.",
    `Schema version: ${SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION}`,
    "Rules: use only evidence in user/assistant messages; do not promote bank, source, session, sender, profile, provider, or tool metadata into semantic entities; carry forward previous anchors only when grounded.",
    `Previous summary JSON:\n${JSON.stringify(trimmed.previousSummary ?? {}, null, 0)}`,
    `Latest query:\n${sanitizeSessionSummaryText(trimmed.latestQuery ?? "")}`,
    `Messages JSON:\n${JSON.stringify(messages)}`,
  ].join("\n");
}

export function renderSessionSummary(
  summaryJson: Record<string, unknown>,
  options: { maxChars: number }
): string {
  const sections: string[] = [];
  for (const [key, label] of [
    ["activeProjects", "Active projects"],
    ["semanticAnchors", "Semantic anchors"],
    ["exactIdentifiers", "Exact identifiers"],
    ["decisions", "Decisions"],
    ["blockers", "Blockers"],
    ["openQuestions", "Open questions"],
  ] as const) {
    const values = asStringList(summaryJson[key]);
    if (values.length > 0) sections.push(`${label}: ${values.join("; ")}`);
  }
  return sanitizeSessionSummaryText(sections.join("\n"), { maxChars: options.maxChars });
}

export function shouldUpdateSessionSummary(input: {
  turnIndex: number;
  retainEveryNTurns: number;
  updateEveryNTurns?: number | null;
  minUpdateEveryNTurns?: number;
}): boolean {
  if (input.turnIndex <= 0) return false;
  const minimum = Math.max(1, Math.trunc(input.minUpdateEveryNTurns ?? 2));
  const cadence =
    input.updateEveryNTurns != null
      ? Math.max(minimum, Math.trunc(input.updateEveryNTurns || minimum))
      : Math.max(minimum, Math.trunc(input.retainEveryNTurns || 1));
  return input.turnIndex % cadence === 0;
}

export function trimSessionSummaryInputs(
  request: SessionSummaryRequest,
  budget: SessionSummaryBudget
): SessionSummaryRequest {
  const latestQuery = sanitizeSessionSummaryText(request.latestQuery ?? "", {
    maxChars: Math.max(0, budget.minLatestQueryReserveChars),
  });
  let remaining = Math.max(0, budget.maxInputChars - latestQuery.length);
  const kept: Array<Record<string, unknown>> = [];
  for (const msg of [...request.messages].reverse()) {
    let content = sanitizeSessionSummaryText(String(msg.content ?? ""));
    if (!content) continue;
    if (content.length > remaining) {
      if (remaining <= 0) break;
      content = content.slice(-remaining);
    }
    kept.push({ ...msg, content });
    remaining -= content.length;
    if (remaining <= 0) break;
  }
  return {
    ...request,
    latestQuery,
    messages: kept.reverse(),
    budget,
  };
}

export class FakeSessionSummaryGenerator implements SessionSummaryGenerator {
  generate(request: SessionSummaryRequest): SessionSummaryResult {
    try {
      const budget = resolveBudget(request.budget);
      const trimmed = trimSessionSummaryInputs(request, budget);
      const evidenceText = evidenceTextFromMessages(trimmed.messages);
      const summaryJson = {
        schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
        activeProjects: activeProjects(evidenceText, trimmed.previousSummary),
        semanticAnchors: semanticAnchors(evidenceText),
        exactIdentifiers: exactIdentifiers(evidenceText),
        decisions: matchingLines(evidenceText, ["decided", "decision", "use ", "chosen"]),
        blockers: matchingLines(evidenceText, ["blocked", "failing", "failure", "error", "risk"]),
        openQuestions: matchingLines(evidenceText, ["?", "open question", "unknown"]),
        completedTodos: matchingLines(evidenceText, ["done", "completed", "fixed"]),
      };
      return {
        summaryJson,
        summaryText: renderSessionSummary(summaryJson, { maxChars: budget.maxOutputChars }),
        schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
        status: "ready",
      };
    } catch (err) {
      return {
        summaryJson: {
          schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
          activeProjects: [],
          semanticAnchors: [],
          exactIdentifiers: [],
          decisions: [],
          blockers: [],
          openQuestions: [],
          completedTodos: [],
        },
        summaryText: "",
        schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function resolveBudget(input?: Partial<SessionSummaryBudget>): SessionSummaryBudget {
  return { ...DEFAULT_SESSION_SUMMARY_BUDGET, ...(input ?? {}) };
}

function evidenceTextFromMessages(messages: Array<Record<string, unknown>>): string {
  return messages
    .filter((msg) => ["user", "assistant"].includes(String(msg.role ?? "").toLowerCase()))
    .map((msg) => sanitizeSessionSummaryText(String(msg.content ?? "")))
    .filter(Boolean)
    .join("\n");
}

function activeProjects(
  evidenceText: string,
  previousSummary?: Record<string, unknown> | null
): string[] {
  const candidates: string[] = [];
  const lowerEvidence = evidenceText.toLowerCase();
  for (const value of asStringList(previousSummary?.activeProjects)) {
    if (lowerEvidence.includes(value.toLowerCase())) candidates.push(value);
  }
  for (const match of evidenceText.matchAll(PROJECT_CUE_RE)) {
    candidates.push(match[1]);
  }
  for (const line of evidenceText.split(/\r?\n/)) {
    if (looksLikeMetadataAssignment(line)) continue;
    for (const ident of line.matchAll(IDENTIFIER_RE)) {
      if (ident[0].includes("-") && !isOperationalIdentifier(ident[0])) candidates.push(ident[0]);
    }
  }
  return dedupe(candidates, 8);
}

function semanticAnchors(evidenceText: string): string[] {
  return dedupe(
    evidenceText
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[- ]+/, ""))
      .filter((line) => line.length >= 8 && !looksLikeMetadataAssignment(line))
      .map((line) => line.slice(0, 180)),
    8
  );
}

function exactIdentifiers(evidenceText: string): string[] {
  return dedupe(
    evidenceText
      .split(/\r?\n/)
      .filter((line) => !looksLikeMetadataAssignment(line))
      .flatMap((line) => [...line.matchAll(IDENTIFIER_RE)].map((match) => match[0]))
      .filter((ident) => !isOperationalIdentifier(ident)),
    16
  );
}

function matchingLines(evidenceText: string, needles: string[]): string[] {
  return dedupe(
    evidenceText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          needles.some((needle) => line.toLowerCase().includes(needle)) &&
          !looksLikeMetadataAssignment(line)
      )
      .map((line) => line.slice(0, 180)),
    8
  );
}

function looksLikeMetadataAssignment(text: string): boolean {
  const key = text.trim().replace(/,$/, "").split(":", 1)[0].trim().replace(/['"]/g, "");
  return OPERATIONAL_METADATA_KEYS.has(key.toLowerCase().replace(/-/g, "_"));
}

function isOperationalIdentifier(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[-.]/g, "_");
  return OPERATIONAL_METADATA_KEYS.has(normalized);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
}

function dedupe(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = sanitizeSessionSummaryText(String(value)).trim().replace(/[ .,;]+$/, "");
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
