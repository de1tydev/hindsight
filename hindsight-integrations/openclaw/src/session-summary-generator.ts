export const SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION = 1;

const OPERATIONAL_METADATA_KEYS = new Set([
  "agent",
  "agent_id",
  "bank",
  "bank_id",
  "channel",
  "channel_id",
  "document",
  "document_id",
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
  "update_mode",
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

export interface SessionSummaryBudgetedText {
  outputText: string;
  recallQueryText: string;
  promptInjectText: string;
  retainContextText: string;
}

export interface SessionSummaryWindowBounds {
  segmentStartTurn: number;
  segmentEndTurn: number;
  inputStartTurn: number;
  recallContextStartTurn: number;
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
  cleaned = stripOperationalMetadataJsonObjects(cleaned);
  cleaned = cleaned.replace(SECRET_RE, "[redacted-secret]");
  const kept: string[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(CANARY_RE, "[redacted]").trim();
    if (!line || INJECTION_RE.test(line)) continue;
    kept.push(line);
  }
  cleaned = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (
    options.maxChars !== undefined &&
    options.maxChars >= 0 &&
    cleaned.length > options.maxChars
  ) {
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
    "Rules: use only evidence in user/assistant messages; do not promote bank, source, session, sender, profile, provider, tool, document, or update-mode metadata into semantic entities; carry forward previous anchors only when grounded.",
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
  retainOverlapTurns?: number;
  recallContextTurns?: number;
  updateEveryNTurns?: number | null;
  minUpdateEveryNTurns?: number;
}): boolean {
  if (input.turnIndex <= 0) return false;
  sessionSummaryWindowBounds({
    turnIndex: input.turnIndex,
    retainEveryNTurns: input.retainEveryNTurns,
    retainOverlapTurns: input.retainOverlapTurns,
    recallContextTurns: input.recallContextTurns,
  });
  const minimum = Math.max(1, Math.trunc(input.minUpdateEveryNTurns ?? 2));
  const cadence =
    input.updateEveryNTurns != null
      ? Math.max(minimum, Math.trunc(input.updateEveryNTurns || minimum))
      : Math.max(minimum, Math.trunc(input.retainEveryNTurns || 1));
  return input.turnIndex % cadence === 0;
}

export function sessionSummaryWindowBounds(input: {
  turnIndex: number;
  retainEveryNTurns: number;
  retainOverlapTurns?: number;
  recallContextTurns?: number;
}): SessionSummaryWindowBounds {
  const endTurn = Math.max(0, Math.trunc(input.turnIndex || 0));
  if (endTurn <= 0) {
    return {
      segmentStartTurn: 0,
      segmentEndTurn: 0,
      inputStartTurn: 0,
      recallContextStartTurn: 0,
    };
  }
  const segmentSize = Math.max(1, Math.trunc(input.retainEveryNTurns || 1));
  const overlap = Math.max(0, Math.trunc(input.retainOverlapTurns || 0));
  const recallContext = Math.max(1, Math.trunc(input.recallContextTurns || 1));
  const segmentStart = Math.max(1, endTurn - segmentSize + 1);
  const overlapStart = Math.max(1, segmentStart - overlap);
  const recallStart = Math.max(1, endTurn - recallContext + 1);
  return {
    segmentStartTurn: segmentStart,
    segmentEndTurn: endTurn,
    inputStartTurn: Math.min(overlapStart, recallStart),
    recallContextStartTurn: recallStart,
  };
}

export function trimSessionSummaryInputs(
  request: SessionSummaryRequest,
  budget: SessionSummaryBudget
): SessionSummaryRequest {
  const latestQuery = sanitizeSessionSummaryText(request.latestQuery ?? "", {
    maxChars: Math.max(0, budget.minLatestQueryReserveChars),
  });
  const remainingTotal = Math.max(0, budget.maxInputChars - latestQuery.length);
  const previousSummary = trimPreviousSummary(request.previousSummary, {
    maxChars: request.previousSummary ? Math.trunc(remainingTotal / 4) : 0,
  });
  let remaining = Math.max(0, remainingTotal - jsonLength(previousSummary));
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
    previousSummary,
    latestQuery,
    messages: kept.reverse(),
    budget,
  };
}

export function buildSessionSummaryBudgetedText(
  summaryJson: Record<string, unknown>,
  budget: SessionSummaryBudget
): SessionSummaryBudgetedText {
  return {
    outputText: renderSessionSummary(summaryJson, { maxChars: budget.maxOutputChars }),
    recallQueryText: renderBudgetedSummaryVariant(summaryJson, {
      maxChars: effectiveRecallQueryChars(budget),
    }),
    promptInjectText: renderBudgetedSummaryVariant(summaryJson, {
      maxChars: budget.maxPromptInjectChars,
    }),
    retainContextText: renderBudgetedSummaryVariant(summaryJson, {
      maxChars: budget.maxRetainContextChars,
    }),
  };
}

interface HindsightApiGeneratorOptions {
  apiUrl: string;
  apiToken: string | undefined;
  timeoutMs: number;
  /** Injectable fetch implementation for testing. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Production session summary generator that delegates to the Hindsight API endpoint.
 *
 * LLM routing (session_summary_llm_* > retain_llm_* > global) happens server-side;
 * the client only sends the messages and budget constraints.
 */
export class HindsightApiSessionSummaryGenerator implements SessionSummaryGenerator {
  private readonly apiUrl: string;
  private readonly apiToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HindsightApiGeneratorOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiToken = opts.apiToken;
    this.timeoutMs = opts.timeoutMs;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async generate(request: SessionSummaryRequest): Promise<SessionSummaryResult> {
    const endpoint = `${this.apiUrl}/v1/session-summary/generate`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const body = JSON.stringify({
      session_id: request.sessionId,
      identity_scope: request.identityScope,
      previous_summary: request.previousSummary ?? null,
      latest_query: request.latestQuery ?? null,
      messages: (request.messages ?? []).map((m) => ({
        role: String(m.role ?? ""),
        content: String(m.content ?? ""),
      })),
      metadata: request.metadata ?? null,
      budget: request.budget ?? null,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchFn(endpoint, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const detail = await resp.text().catch(() => String(resp.status));
        return this._errorResult(`session-summary API error ${resp.status}: ${detail}`);
      }

      const data = (await resp.json()) as Record<string, unknown>;
      return this._parseApiResponse(data);
    } catch (err) {
      // Never include the api token in the error message.
      const msg = err instanceof Error ? err.message : String(err);
      return this._errorResult(`session-summary request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private _parseApiResponse(data: Record<string, unknown>): SessionSummaryResult {
    const summaryJson = (data.summary_json as Record<string, unknown> | undefined) ?? {};
    summaryJson.schemaVersion =
      summaryJson.schemaVersion ?? SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION;

    const rawText = String(data.summary_text ?? "");
    const summaryText = sanitizeSessionSummaryText(rawText, {
      maxChars: DEFAULT_SESSION_SUMMARY_BUDGET.maxOutputChars,
    });

    const status = data.status === "ready" ? "ready" : "error";
    const result: SessionSummaryResult = {
      summaryJson,
      summaryText,
      schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
      status,
    };
    if (data.error) result.error = String(data.error);
    return result;
  }

  private _errorResult(msg: string): SessionSummaryResult {
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
      error: msg,
    };
  }
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

function stripOperationalMetadataJsonObjects(text: string): string {
  return text.replace(/\{[^{}]*\}/g, (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    const keys = Object.keys(parsed).map((key) => normalizeMetadataKey(key));
    return keys.some((key) => OPERATIONAL_METADATA_KEYS.has(key)) ? "" : raw;
  });
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
  const stripped = text.trim().replace(/,$/, "");
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed).map((key) => normalizeMetadataKey(key));
      if (keys.some((key) => OPERATIONAL_METADATA_KEYS.has(key))) return true;
    }
  } catch {
    // Non-JSON metadata assignment handling follows.
  }
  const separator = stripped.includes(":") ? ":" : stripped.includes("=") ? "=" : "";
  if (!separator) return false;
  const key = stripped.split(separator, 1)[0].trim().replace(/['"]/g, "");
  return OPERATIONAL_METADATA_KEYS.has(normalizeMetadataKey(key));
}

function isOperationalIdentifier(value: string): boolean {
  return OPERATIONAL_METADATA_KEYS.has(normalizeMetadataKey(value));
}

function normalizeMetadataKey(value: unknown): string {
  return String(value)
    .trim()
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .replace(/[-.]/g, "_")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function trimPreviousSummary(
  previousSummary: Record<string, unknown> | null | undefined,
  options: { maxChars: number }
): Record<string, unknown> | null {
  if (!previousSummary || options.maxChars <= 2) return null;
  const sanitized: Record<string, unknown> = {};
  if (previousSummary.schemaVersion !== undefined) {
    const candidate = { schemaVersion: previousSummary.schemaVersion };
    if (jsonLength(candidate) <= options.maxChars) Object.assign(sanitized, candidate);
  }
  for (const key of [
    "activeProjects",
    "exactIdentifiers",
    "semanticAnchors",
    "decisions",
    "blockers",
    "openQuestions",
    "completedTodos",
  ]) {
    const kept: string[] = [];
    for (const value of asStringList(previousSummary[key])) {
      const text = sanitizeSessionSummaryText(value);
      if (!text) continue;
      const candidate = { ...sanitized, [key]: [...kept, text] };
      if (jsonLength(candidate) > options.maxChars) break;
      kept.push(text);
    }
    if (kept.length > 0) sanitized[key] = kept;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function jsonLength(value: unknown): number {
  if (value == null) return 0;
  return JSON.stringify(value).length;
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
    const text = sanitizeSessionSummaryText(String(value))
      .trim()
      .replace(/[ .,;]+$/, "");
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function effectiveRecallQueryChars(budget: SessionSummaryBudget): number {
  const ratioLimit = Math.trunc(
    Math.max(0, budget.maxInputChars) * Math.max(0, budget.recallQueryBudgetRatio)
  );
  return Math.max(0, Math.min(budget.maxRecallQueryChars, ratioLimit));
}

function renderBudgetedSummaryVariant(
  summaryJson: Record<string, unknown>,
  options: { maxChars: number }
): string {
  if (options.maxChars <= 0) return "";
  const full = renderSessionSummary(summaryJson, options);
  if (full.length < options.maxChars) return full;
  const anchors = asStringList(summaryJson.semanticAnchors);
  if (anchors.length === 0) return full;
  return renderSessionSummary({ semanticAnchors: anchors }, options) || full;
}
