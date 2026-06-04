"""Rolling session summary helpers for Codex hooks."""

from __future__ import annotations

import time
from typing import Any

from .content import strip_memory_tags
from .state import read_state, write_state


def _state_name(session_id: str) -> str:
    return f"session_summary_{session_id}.json"


def read_session_summary(session_id: str) -> dict | None:
    """Read the saved summary state for a Codex session."""
    if not session_id:
        return None
    state = read_state(_state_name(session_id), None)
    return state if isinstance(state, dict) else None


def write_session_summary(session_id: str, result: dict) -> None:
    """Persist a ready session summary response."""
    if not session_id or not isinstance(result, dict):
        return
    if result.get("status") != "ready":
        return
    write_state(
        _state_name(session_id),
        {
            "status": "ready",
            "schema_version": result.get("schema_version"),
            "summary_json": result.get("summary_json") or {},
            "summary_text": result.get("summary_text") or "",
            "model_info": result.get("model_info") or {},
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )


def summary_json_from_state(state: dict | None) -> dict | None:
    if not isinstance(state, dict):
        return None
    summary_json = state.get("summary_json")
    return summary_json if isinstance(summary_json, dict) else None


def summary_text_from_state(state: dict | None) -> str:
    if not isinstance(state, dict):
        return ""
    text = state.get("summary_text") or ""
    return text if isinstance(text, str) else str(text)


def latest_user_query(messages: list[dict[str, Any]]) -> str:
    """Return the newest user message text from a message list."""
    for msg in reversed(messages or []):
        if msg.get("role") == "user":
            content = _message_text(msg)
            if content:
                return content
    return ""


def prepare_summary_messages(messages: list[dict[str, Any]], max_messages: int = 24) -> list[dict[str, str]]:
    """Prepare text-only messages for the session-summary endpoint."""
    safe: list[dict[str, str]] = []
    allowed_roles = {"user", "assistant"}
    for msg in messages or []:
        role = msg.get("role")
        if role not in allowed_roles:
            continue
        content = strip_memory_tags(_message_text(msg)).strip()
        if not content:
            continue
        safe.append({"role": str(role), "content": content})

    if max_messages and max_messages > 0:
        return safe[-max_messages:]
    return safe


def enrich_recall_query_with_summary(query: str, summary_text: str) -> str:
    """Prefix a recall query with a compact session summary."""
    clean_summary = strip_memory_tags(summary_text or "").strip()
    if not clean_summary:
        return query
    return "\n\n".join(["Session summary:", clean_summary, query])


def update_session_summary(client, bank_id: str, session_id: str, messages: list, config: dict, debug_fn=None) -> None:
    """Generate and persist a rolling summary. Errors degrade silently."""
    prepared = prepare_summary_messages(messages, int(config.get("sessionSummaryMaxMessages", 24)))
    if not prepared:
        return

    previous = read_session_summary(session_id)
    latest_query = latest_user_query(prepared)
    try:
        result = client.generate_session_summary(
            session_id=session_id,
            identity_scope=bank_id,
            bank_id=bank_id,
            previous_summary=summary_json_from_state(previous),
            latest_query=latest_query,
            messages=prepared,
            metadata={"source_system": "codex"},
            timeout=int(config.get("sessionSummaryTimeout", 20)),
        )
    except Exception as exc:
        if debug_fn:
            debug_fn(f"Session summary update failed: {exc}")
        return

    write_session_summary(session_id, result)
    if debug_fn:
        debug_fn(f"Session summary update status: {result.get('status')}")


def _message_text(msg: dict[str, Any]) -> str:
    content = msg.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") in ("text", "input_text", "output_text"):
                    text = block.get("text") or ""
                    if text:
                        parts.append(str(text))
                elif block.get("type") == "tool_use":
                    name = block.get("name") or "tool"
                    parts.append(f"[tool_use:{name}]")
                elif block.get("type") == "tool_result":
                    text = block.get("content") or ""
                    if text:
                        parts.append(f"[tool_result] {text}")
            elif block:
                parts.append(str(block))
        return "\n".join(parts)
    return str(content)
