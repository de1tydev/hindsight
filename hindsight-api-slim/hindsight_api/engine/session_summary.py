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


def resolve_session_summary_llm_config(config: HindsightConfig) -> LLMProvider:
    """Return the LLMProvider to use for session summary generation.

    Priority: session_summary_llm_* > retain_llm_* > global llm_*.
    """
    provider = config.session_summary_llm_provider or config.retain_llm_provider or config.llm_provider
    api_key = config.session_summary_llm_api_key or config.retain_llm_api_key or config.llm_api_key or ""
    model = config.session_summary_llm_model or config.retain_llm_model or config.llm_model
    base_url = config.session_summary_llm_base_url or config.retain_llm_base_url or config.llm_base_url or ""
    return LLMProvider(
        provider=provider,
        api_key=api_key,
        base_url=base_url,
        model=model,
    )


def _build_user_prompt(request: dict[str, Any]) -> str:
    """Assemble the user-turn prompt from the session summary request."""
    parts: list[str] = []
    parts.append(f"Schema version: {SESSION_SUMMARY_SCHEMA_VERSION}")

    previous = request.get("previous_summary")
    parts.append(f"Previous summary JSON:\n{json.dumps(previous or {}, separators=(',', ':'))}")

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
            "error": str(exc),
        }
