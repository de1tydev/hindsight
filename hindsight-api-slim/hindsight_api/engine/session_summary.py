"""
Session summary generation service.

LLM selection priority (highest to lowest):
  1. HINDSIGHT_API_SESSION_SUMMARY_LLM_* overrides
  2. HINDSIGHT_API_RETAIN_LLM_*
  3. HINDSIGHT_API_LLM_* (global default)
"""

import json
import logging
import re
from typing import Any

from ..config import HindsightConfig
from .llm_wrapper import LLMProvider

logger = logging.getLogger(__name__)

SESSION_SUMMARY_SCHEMA_VERSION = 2
DEFAULT_MAX_INPUT_CHARS = 16_000
DEFAULT_MAX_OUTPUT_CHARS = 2_000
DEFAULT_MAX_COMPLETION_TOKENS = 700
DEFAULT_MIN_LATEST_QUERY_RESERVE_CHARS = 400

# Sanitization patterns — mirror the integration-side guard.
_INJECTION_RE = re.compile(
    r"\b(ignore|override|forget|bypass)\b.{0,80}\b(previous|system|developer|instructions?)\b"
    r"|\b(reveal|print|exfiltrate|leak)\b.{0,80}\b(secret|token|prompt|credentials?)\b"
    r"|\bdo\s+not\s+(store|summari[sz]e|sanitize)\b",
    re.IGNORECASE | re.DOTALL,
)
_CANARY_RE = re.compile(
    r"\b[A-Z0-9_]*(?:SECRET|CANARY|DO_NOT_STORE|DO_NOT_LEAK|SHOULD_NOT_APPEAR)[A-Z0-9_]*\b"
    r"|/private/[^\s`'\"<>]+"
    r"|\bsha256:[a-fA-F0-9]{32,64}\b",
    re.IGNORECASE,
)
_SECRET_RE = re.compile(
    r"\b(?:api[_\-]?key|token|password|secret)\s*[:=]\s*['\"]?[^'\"\s,;]+",
    re.IGNORECASE,
)
_METADATA_BLOCK_RE = re.compile(
    r"[\w\s]+\(untrusted metadata\)[^\n]*\n```json\n[\s\S]*?```",
    re.IGNORECASE,
)
_MEMORY_TAG_RE = re.compile(
    r"<(?:hindsight_memories|relevant_memories)>[\s\S]*?</(?:hindsight_memories|relevant_memories)>",
    re.IGNORECASE,
)
_OPERATIONAL_METADATA_KEYS = {
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
}

_SYSTEM_PROMPT = (
    "You are a low-distortion rolling conversation summarizer. "
    "Return plain text only: no JSON, no markdown, no headings unless the conversation itself requires them. "
    "Summarize only evidence from the user and assistant messages. "
    "Write one compact natural-language summary that preserves the current objective, important context, "
    "user corrections, key conclusions, constraints, and unresolved questions when they matter. "
    "Preserve exact surface forms for names, project names, school names, file paths, commands, addresses, "
    "dates, amounts, numbers, URLs, model names, error messages, and user-provided terminology. "
    "Do not rename, translate, normalize, abbreviate, substitute, or autocorrect proper nouns and identifiers. "
    "If unsure whether a phrase is important, copy the original wording instead of paraphrasing it. "
    "Treat the previous summary as a draft, not authority; current messages and explicit user corrections override it. "
    "Remove old wording that the user corrected unless the correction itself must be noted. "
    "Do not create categories such as Semantic Anchors, Exact Identifiers, Decisions, Blockers, Open Questions, "
    "or Completed Todos."
)


def _normalize_metadata_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", key.strip().lower()).strip("_")


def _is_operational_metadata_json(text: str) -> bool:
    stripped = text.strip().rstrip(",")
    try:
        parsed = json.loads(stripped)
    except Exception:
        return False
    if not isinstance(parsed, dict) or not parsed:
        return False
    keys = {_normalize_metadata_key(str(k)) for k in parsed.keys()}
    return any(k in _OPERATIONAL_METADATA_KEYS for k in keys)


def _strip_operational_metadata_json_objects(text: str) -> str:
    def replace(raw: re.Match[str]) -> str:
        return "" if _is_operational_metadata_json(raw.group(0)) else raw.group(0)

    return re.sub(r"\{[^{}]*\}", replace, text)


def _looks_like_metadata_assignment(text: str) -> bool:
    stripped = text.strip().rstrip(",")
    separator = ":" if ":" in stripped else "=" if "=" in stripped else ""
    if not separator:
        return False
    key = stripped.split(separator, 1)[0].strip().replace("'", "").replace('"', "")
    return _normalize_metadata_key(key) in _OPERATIONAL_METADATA_KEYS


def _sanitize_text(text: str, max_chars: int | None = None) -> str:
    text = _MEMORY_TAG_RE.sub("", str(text or ""))
    text = _METADATA_BLOCK_RE.sub("", text)
    text = _strip_operational_metadata_json_objects(text)
    text = _CANARY_RE.sub("[redacted]", text)
    text = _SECRET_RE.sub("[redacted-secret]", text)
    kept: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or _INJECTION_RE.search(line) or _looks_like_metadata_assignment(line):
            continue
        kept.append(line)
    cleaned = "\n".join(kept).strip()
    if max_chars is not None and max_chars >= 0 and len(cleaned) > max_chars:
        return cleaned[:max_chars].rstrip()
    return cleaned


def _sanitize_error(error: str) -> str:
    """Strip canary/secret patterns from error messages."""
    s = _CANARY_RE.sub("[redacted]", str(error))
    return _SECRET_RE.sub("[redacted-secret]", s)


def resolve_session_summary_llm_config(config: HindsightConfig) -> LLMProvider:
    """Return the LLMProvider to use for session summary generation.

    Priority: session_summary_llm_* > retain_llm_* > global llm_*.
    """
    provider = config.session_summary_llm_provider or config.retain_llm_provider or config.llm_provider
    api_key = config.session_summary_llm_api_key or config.retain_llm_api_key or config.llm_api_key or ""
    model = config.session_summary_llm_model or config.retain_llm_model or config.llm_model
    base_url = config.session_summary_llm_base_url or config.retain_llm_base_url or config.llm_base_url or ""
    litellmrouter_config = (
        config.session_summary_llm_litellmrouter_config
        or config.retain_llm_litellmrouter_config
        or config.llm_litellmrouter_config
    )
    return LLMProvider(
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
        litellmrouter_config=litellmrouter_config,
    )


def _budget_int(budget: dict[str, Any], *keys: str, default: int) -> int:
    for key in keys:
        value = budget.get(key)
        if value is None or value == "":
            continue
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            return parsed
    return default


def _summary_budget(request: dict[str, Any]) -> dict[str, int]:
    raw = request.get("budget")
    budget = raw if isinstance(raw, dict) else {}
    max_output_chars = _budget_int(
        budget,
        "max_output_chars",
        "maxOutputChars",
        default=DEFAULT_MAX_OUTPUT_CHARS,
    )
    return {
        "max_input_chars": _budget_int(
            budget,
            "max_input_chars",
            "maxInputChars",
            default=DEFAULT_MAX_INPUT_CHARS,
        ),
        "max_output_chars": max_output_chars,
        "max_completion_tokens": _budget_int(
            budget,
            "max_completion_tokens",
            "maxCompletionTokens",
            "max_output_tokens",
            "maxOutputTokens",
            default=min(DEFAULT_MAX_COMPLETION_TOKENS, max(128, max_output_chars // 3 + 64)),
        ),
        "min_latest_query_reserve_chars": _budget_int(
            budget,
            "min_latest_query_reserve_chars",
            "minLatestQueryReserveChars",
            default=DEFAULT_MIN_LATEST_QUERY_RESERVE_CHARS,
        ),
    }


def _build_user_prompt(request: dict[str, Any]) -> str:
    """Assemble the user-turn prompt from the session summary request."""
    budget = _summary_budget(request)
    latest_query = _sanitize_text(
        str(request.get("latest_query") or ""),
        max_chars=budget["min_latest_query_reserve_chars"],
    )
    remaining = max(0, budget["max_input_chars"] - len(latest_query))
    previous_summary_text = _sanitize_text(
        str(request.get("previous_summary_text") or ""),
        max_chars=remaining // 4 if remaining > 0 else 0,
    )
    remaining = max(0, remaining - len(previous_summary_text))

    safe_messages: list[dict[str, str]] = []
    messages = request.get("messages") or []
    for message in reversed(messages if isinstance(messages, list) else []):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", ""))
        if role.lower() not in {"user", "assistant"}:
            continue
        content = _sanitize_text(str(message.get("content", "")))
        if not content:
            continue
        if len(content) > remaining:
            if remaining <= 0:
                break
            content = content[-remaining:]
        safe_messages.append({"role": role, "content": content})
        remaining -= len(content)
        if remaining <= 0:
            break
    safe_messages.reverse()

    parts = [
        f"Maximum output length: {budget['max_output_chars']} characters.",
        "Return only the rolling summary text.",
    ]
    if previous_summary_text:
        parts.append(f"Previous rolling summary:\n{previous_summary_text}")
    if latest_query:
        parts.append(f"Latest user query:\n{latest_query}")
    parts.append(f"Messages JSON:\n{json.dumps(safe_messages, ensure_ascii=False, separators=(',', ':'))}")
    return "\n\n".join(parts)


def _safe_model_info(llm: LLMProvider) -> dict[str, str]:
    """Return non-secret provider/model info suitable for API responses."""
    return {"provider": llm.provider, "model": llm.model}


def _empty_result(model_info: dict[str, str], error: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": "error" if error else "ready",
        "schema_version": SESSION_SUMMARY_SCHEMA_VERSION,
        "summary_text": "",
        "model_info": model_info,
    }
    if error:
        result["error"] = _sanitize_error(error)
    return result


async def generate_session_summary(
    request: dict[str, Any],
    llm: LLMProvider,
) -> dict[str, Any]:
    """Generate a plain-text rolling session summary using the provided LLM."""
    model_info = _safe_model_info(llm)
    budget = _summary_budget(request)
    user_prompt = _build_user_prompt(request)

    try:
        raw_output = await llm.call(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=budget["max_completion_tokens"],
            temperature=0,
            scope="session_summary",
        )

        if isinstance(raw_output, tuple):
            raw_output = raw_output[0]
        if isinstance(raw_output, dict):
            raw_text = str(raw_output.get("summary_text") or raw_output.get("summaryText") or "")
        else:
            raw_text = str(raw_output)
        # Output size is controlled at generation time via max_completion_tokens
        # plus the explicit prompt budget. Do not hard-truncate the completed
        # summary text here: cutting a rolling summary mid-sentence loses exactly
        # the cross-turn context this endpoint exists to preserve.
        summary_text = _sanitize_text(raw_text)

        return {
            "status": "ready",
            "schema_version": SESSION_SUMMARY_SCHEMA_VERSION,
            "summary_text": summary_text,
            "model_info": model_info,
        }

    except Exception as exc:
        logger.warning("session_summary generation failed: %s", exc)
        return _empty_result(model_info, error=str(exc))
