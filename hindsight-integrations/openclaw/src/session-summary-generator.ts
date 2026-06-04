export const SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION = 2;

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
export interface SessionSummaryBudget {
  maxInputChars: number;
  maxOutputChars: number;
  maxRecallQueryChars: number;
  recallQueryBudgetRatio: number;
  minLatestQueryReserveChars: number;
  dropCompletedTodosAfterTurns: number;
}

export interface SessionSummaryBudgetedText {
  outputText: string;
  recallQueryText: string;
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
  minLatestQueryReserveChars: 400,
  dropCompletedTodosAfterTurns: 20,
};

export interface SessionSummaryRequest {
  sessionId: string;
  identityScope: string;
  messages: Array<Record<string, unknown>>;
  previousSummaryText?: string | null;
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
    if (!line || INJECTION_RE.test(line) || looksLikeMetadataAssignment(line)) continue;
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
    "Generate a compact rolling session summary.",
    "Return plain text only. No JSON, no markdown.",
    "Rules: use only evidence in user/assistant messages; preserve exact names, project names, school names, file paths, commands, addresses, dates, amounts, numbers, URLs, model names, error messages, and user terminology; do not rename, translate, normalize, abbreviate, substitute, or autocorrect proper nouns and identifiers; current messages and user corrections override the previous summary.",
    `Maximum output length: ${resolveBudget(request.budget).maxOutputChars} characters.`,
    `Previous rolling summary:\n${sanitizeSessionSummaryText(trimmed.previousSummaryText ?? "")}`,
    `Latest query:\n${sanitizeSessionSummaryText(trimmed.latestQuery ?? "")}`,
    `Messages JSON:\n${JSON.stringify(messages)}`,
  ].join("\n");
}

export function renderSessionSummary(
  summaryJson: Record<string, unknown>,
  options: { maxChars: number }
): string {
  const summaryText = summaryJson.summaryText;
  if (typeof summaryText === "string") {
    return sanitizeSessionSummaryText(summaryText, { maxChars: options.maxChars });
  }
  return "";
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
  const previousSummaryText = sanitizeSessionSummaryText(request.previousSummaryText ?? "", {
    maxChars: request.previousSummaryText ? Math.trunc(remainingTotal / 4) : 0,
  });
  let remaining = Math.max(0, remainingTotal - previousSummaryText.length);
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
    previousSummaryText,
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
      previous_summary_text: request.previousSummaryText ?? null,
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
    const rawText = String(data.summary_text ?? "");
    const summaryText = sanitizeSessionSummaryText(rawText);
    const summaryJson = {
      schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
      summaryText,
    };

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
        summaryText: "",
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
      const previous = sanitizeSessionSummaryText(trimmed.previousSummaryText ?? "");
      const summaryText = sanitizeSessionSummaryText(
        [previous, evidenceText].filter(Boolean).join("\n")
      );
      const summaryJson = {
        schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
        summaryText,
      };
      return {
        summaryJson,
        summaryText,
        schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
        status: "ready",
      };
    } catch (err) {
      return {
        summaryJson: {
          schemaVersion: SESSION_SUMMARY_GENERATOR_SCHEMA_VERSION,
          summaryText: "",
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

function normalizeMetadataKey(value: unknown): string {
  return String(value)
    .trim()
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .replace(/[-.]/g, "_")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
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
  return full.slice(0, options.maxChars).trimEnd();
}
