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

SESSION_SUMMARY_SCHEMA_VERSION = 1

# All fields that must be present in a valid summary JSON.
_REQUIRED_SCHEMA_FIELDS = (
    "schemaVersion",
    "activeProjects",
    "semanticAnchors",
    "exactIdentifiers",
    "decisions",
    "blockers",
    "openQuestions",
    "completedTodos",
)

# Array fields whose items are strings that get sanitized.
_ARRAY_FIELDS = (
    "activeProjects",
    "semanticAnchors",
    "exactIdentifiers",
    "decisions",
    "blockers",
    "openQuestions",
    "completedTodos",
)

# Sanitization patterns — mirror the TypeScript OpenClaw guard.
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

# Prompt mirrors the TypeScript buildSessionSummaryPrompt contract.
_SYSTEM_PROMPT = (
    "You are a concise session summarizer. "
    "Produce ONLY a JSON object matching the schema below, no prose, no markdown fences.\n"
    "Schema:\n"
    "{\n"
    '  "schemaVersion": 1,\n'
    '  "activeProjects": [<string>],\n'
    '  "semanticAnchors": [<string>],\n'
    '  "exactIdentifiers": [<string>],\n'
    '  "decisions": [<string>],\n'
    '  "blockers": [<string>],\n'
    '  "openQuestions": [<string>],\n'
    '  "completedTodos": [<string>]\n'
    "}\n"
    "Rules:\n"
    "- Use only evidence from user/assistant messages.\n"
    "- Do not promote bank, source, session, sender, profile, provider, tool, "
    "document, or update-mode metadata into semantic entities.\n"
    "- Carry forward previous anchors only when grounded in current messages.\n"
    "- Output valid JSON only."
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


def _sanitize_string(s: str) -> str | None:
    """Sanitize a single summary string; returns None if the entry should be dropped."""
    s = _MEMORY_TAG_RE.sub("", str(s))
    s = _METADATA_BLOCK_RE.sub("", s)
    s = _strip_operational_metadata_json_objects(s)
    if _is_operational_metadata_json(s):
        return None
    s = _CANARY_RE.sub("[redacted]", s)
    s = _SECRET_RE.sub("[redacted-secret]", s)
    s = s.strip()
    if not s or _INJECTION_RE.search(s):
        return None
    return s


def _sanitize_summary_json(summary_json: dict[str, Any]) -> dict[str, Any]:
    """Return a schema-only summary JSON with sanitized, bounded array fields."""
    result: dict[str, Any] = {"schemaVersion": SESSION_SUMMARY_SCHEMA_VERSION}
    for field in _ARRAY_FIELDS:
        raw = summary_json.get(field, [])
        if not isinstance(raw, list):
            result[field] = []
            continue
        sanitized: list[str] = []
        seen: set[str] = set()
        for item in raw:
            cleaned = _sanitize_string(str(item)) if item is not None else None
            if not cleaned:
                continue
            cleaned = cleaned[:240]
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            sanitized.append(cleaned)
            if len(sanitized) >= 16:
                break
        result[field] = sanitized
    return result


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


def _build_user_prompt(request: dict[str, Any]) -> str:
    """Assemble the user-turn prompt from the session summary request."""
    parts: list[str] = []
    parts.append(f"Schema version: {SESSION_SUMMARY_SCHEMA_VERSION}")

    previous = request.get("previous_summary")
    # Sanitize previous summary before including in prompt to prevent canary/injection leakage.
    previous_safe = _sanitize_summary_json(previous) if isinstance(previous, dict) else None
    parts.append(f"Previous summary JSON:\n{json.dumps(previous_safe or {}, separators=(',', ':'))}")

    latest_query = str(request.get("latest_query") or "")
    if latest_query:
        parts.append(f"Latest query:\n{latest_query}")

    messages = request.get("messages") or []
    safe_messages = [
        {"role": str(m.get("role", "")), "content": str(m.get("content", ""))} for m in messages if isinstance(m, dict)
    ]
    parts.append(f"Messages JSON:\n{json.dumps(safe_messages, separators=(',', ':'))}")

    return "\n".join(parts)


def _parse_llm_json_output(raw: str) -> dict[str, Any]:
    """Extract a JSON object from LLM output, stripping markdown fences."""
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().strip("`").strip()
    return json.loads(cleaned)


def _safe_model_info(llm: LLMProvider) -> dict[str, str]:
    """Return non-secret provider/model info suitable for API responses."""
    return {"provider": llm.provider, "model": llm.model}


def _render_summary_text(summary_json: dict[str, Any], max_chars: int = 2000) -> str:
    """Render summary JSON as a human-readable string."""
    sections: list[str] = []
    field_labels = [
        ("activeProjects", "Active projects"),
        ("semanticAnchors", "Semantic anchors"),
        ("exactIdentifiers", "Exact identifiers"),
        ("decisions", "Decisions"),
        ("blockers", "Blockers"),
        ("openQuestions", "Open questions"),
    ]
    for field, label in field_labels:
        values = summary_json.get(field, [])
        if isinstance(values, list) and values:
            entries = [str(v) for v in values if v]
            if entries:
                sections.append(f"{label}: {'; '.join(entries)}")
    text = "\n".join(sections)
    return text[:max_chars] if len(text) > max_chars else text


def _empty_summary_json() -> dict[str, Any]:
    return {
        "schemaVersion": SESSION_SUMMARY_SCHEMA_VERSION,
        "activeProjects": [],
        "semanticAnchors": [],
        "exactIdentifiers": [],
        "decisions": [],
        "blockers": [],
        "openQuestions": [],
        "completedTodos": [],
    }


async def generate_session_summary(
    request: dict[str, Any],
    llm: LLMProvider,
) -> dict[str, Any]:
    """Generate a session summary using the provided LLM.

    Returns a dict with keys:
        status, schema_version, summary_json, summary_text, model_info, error?
    """
    model_info = _safe_model_info(llm)
    user_prompt = _build_user_prompt(request)

    try:
        raw_output = await llm.call(
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            scope="session_summary",
        )

        if isinstance(raw_output, tuple):
            raw_output = raw_output[0]

        if isinstance(raw_output, dict):
            summary_json = raw_output
        elif isinstance(raw_output, str):
            summary_json = _parse_llm_json_output(raw_output)
        else:
            summary_json = _parse_llm_json_output(str(raw_output))

        # Ensure schema version is present
        summary_json.setdefault("schemaVersion", SESSION_SUMMARY_SCHEMA_VERSION)
        # Ensure all required fields are present
        for field in _REQUIRED_SCHEMA_FIELDS:
            if field not in summary_json:
                summary_json[field] = [] if field != "schemaVersion" else SESSION_SUMMARY_SCHEMA_VERSION

        # Sanitize and normalize LLM output before returning.
        summary_json = _sanitize_summary_json(summary_json)

        summary_text = _render_summary_text(summary_json)

        return {
            "status": "ready",
            "schema_version": SESSION_SUMMARY_SCHEMA_VERSION,
            "summary_json": summary_json,
            "summary_text": summary_text,
            "model_info": model_info,
        }

    except Exception as exc:
        logger.warning("session_summary generation failed: %s", exc)
        return {
            "status": "error",
            "schema_version": SESSION_SUMMARY_SCHEMA_VERSION,
            "summary_json": _empty_summary_json(),
            "summary_text": "",
            "model_info": model_info,
            "error": _sanitize_error(str(exc)),
        }
