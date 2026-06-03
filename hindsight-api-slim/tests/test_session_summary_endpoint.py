"""
Tests for the session summary generation endpoint and LLM config resolution.

Covers:
1. Endpoint routes to session-summary generation and returns schema-compatible output.
2. LLM config resolution: session_summary_llm_* beats retain, retain beats global default.
3. Generator returns required fields with correct schema version.
"""

import os

import pytest


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def isolate_config(monkeypatch):
    """Ensure each test gets a clean config singleton."""
    from hindsight_api.config import clear_config_cache

    yield
    clear_config_cache()


class TestSessionSummaryLLMConfigResolution:
    """session_summary_llm_* overrides > retain_llm_* > global llm_*."""

    def _set_env(self, monkeypatch, **kwargs):
        from hindsight_api.config import clear_config_cache

        for key, value in kwargs.items():
            monkeypatch.setenv(key, value)
        clear_config_cache()

    def test_defaults_to_retain_provider_and_model(self, monkeypatch):
        self._set_env(
            monkeypatch,
            HINDSIGHT_API_SKIP_LLM_VERIFICATION="true",
            HINDSIGHT_API_LLM_PROVIDER="mock",
            HINDSIGHT_API_LLM_MODEL="global-model",
            HINDSIGHT_API_RETAIN_LLM_PROVIDER="mock",
            HINDSIGHT_API_RETAIN_LLM_MODEL="retain-model",
        )
        from hindsight_api.config import get_config
        from hindsight_api.engine.session_summary import resolve_session_summary_llm_config

        cfg = get_config()
        llm = resolve_session_summary_llm_config(cfg)
        assert llm.provider == "mock"
        assert llm.model == "retain-model"

    def test_falls_back_to_global_when_no_retain(self, monkeypatch):
        self._set_env(
            monkeypatch,
            HINDSIGHT_API_SKIP_LLM_VERIFICATION="true",
            HINDSIGHT_API_LLM_PROVIDER="mock",
            HINDSIGHT_API_LLM_MODEL="global-model",
        )
        from hindsight_api.config import get_config
        from hindsight_api.engine.session_summary import resolve_session_summary_llm_config

        cfg = get_config()
        llm = resolve_session_summary_llm_config(cfg)
        assert llm.provider == "mock"
        assert llm.model == "global-model"

    def test_session_summary_specific_overrides_retain(self, monkeypatch):
        self._set_env(
            monkeypatch,
            HINDSIGHT_API_SKIP_LLM_VERIFICATION="true",
            HINDSIGHT_API_LLM_PROVIDER="mock",
            HINDSIGHT_API_LLM_MODEL="global-model",
            HINDSIGHT_API_RETAIN_LLM_PROVIDER="mock",
            HINDSIGHT_API_RETAIN_LLM_MODEL="retain-model",
            HINDSIGHT_API_SESSION_SUMMARY_LLM_PROVIDER="mock",
            HINDSIGHT_API_SESSION_SUMMARY_LLM_MODEL="summary-model",
        )
        from hindsight_api.config import get_config
        from hindsight_api.engine.session_summary import resolve_session_summary_llm_config

        cfg = get_config()
        llm = resolve_session_summary_llm_config(cfg)
        assert llm.model == "summary-model"

    def test_config_fields_loaded_from_env(self, monkeypatch):
        self._set_env(
            monkeypatch,
            HINDSIGHT_API_SKIP_LLM_VERIFICATION="true",
            HINDSIGHT_API_LLM_PROVIDER="mock",
            HINDSIGHT_API_LLM_MODEL="global-model",
            HINDSIGHT_API_SESSION_SUMMARY_LLM_PROVIDER="mock",
            HINDSIGHT_API_SESSION_SUMMARY_LLM_MODEL="summary-specific-model",
            HINDSIGHT_API_SESSION_SUMMARY_LLM_BASE_URL="http://summary-host/v1",
        )
        from hindsight_api.config import get_config

        cfg = get_config()
        assert cfg.session_summary_llm_provider == "mock"
        assert cfg.session_summary_llm_model == "summary-specific-model"
        assert cfg.session_summary_llm_base_url == "http://summary-host/v1"


# ---------------------------------------------------------------------------
# Session summary generation service
# ---------------------------------------------------------------------------


class TestSessionSummaryGeneration:
    """Tests for the generate_session_summary service function."""

    def test_returns_schema_compatible_output_with_mock_llm(self, monkeypatch):
        """With mock LLM, generator returns all required schema fields."""
        import asyncio

        from hindsight_api.config import clear_config_cache
        from hindsight_api.engine.llm_wrapper import LLMProvider
        from hindsight_api.engine.session_summary import generate_session_summary

        monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
        monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
        monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "mock-model")
        clear_config_cache()

        mock_provider = LLMProvider(provider="mock", api_key="", base_url="", model="mock-model")
        mock_provider.set_mock_response(
            {
                "schemaVersion": 1,
                "activeProjects": ["hindsight-api"],
                "semanticAnchors": ["session summary endpoint"],
                "exactIdentifiers": ["test-session-001"],
                "decisions": [],
                "blockers": [],
                "openQuestions": [],
                "completedTodos": [],
            }
        )

        request = {
            "session_id": "test-session-001",
            "identity_scope": "bank-1",
            "messages": [
                {"role": "user", "content": "Working on hindsight-api session summary."},
                {"role": "assistant", "content": "I can help with the session summary endpoint."},
            ],
        }

        result = asyncio.get_event_loop().run_until_complete(
            generate_session_summary(request, mock_provider)
        )

        assert result["status"] == "ready"
        assert result["schema_version"] == 1
        assert "summary_json" in result
        assert "summary_text" in result
        assert "model_info" in result
        assert "api_key" not in str(result["model_info"])

    def test_summary_json_has_required_fields(self, monkeypatch):
        """summary_json must contain the 8 schema fields."""
        import asyncio

        from hindsight_api.config import clear_config_cache
        from hindsight_api.engine.llm_wrapper import LLMProvider
        from hindsight_api.engine.session_summary import generate_session_summary

        monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
        monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
        monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "mock-model")
        clear_config_cache()

        provider = LLMProvider(provider="mock", api_key="", base_url="", model="mock-model")
        provider.set_mock_response(
            {
                "schemaVersion": 1,
                "activeProjects": ["project-a"],
                "semanticAnchors": [],
                "exactIdentifiers": [],
                "decisions": [],
                "blockers": [],
                "openQuestions": [],
                "completedTodos": [],
            }
        )

        result = asyncio.get_event_loop().run_until_complete(
            generate_session_summary(
                {
                    "session_id": "s1",
                    "identity_scope": "b1",
                    "messages": [{"role": "user", "content": "project-a is the focus."}],
                },
                provider,
            )
        )

        required_fields = {
            "schemaVersion",
            "activeProjects",
            "semanticAnchors",
            "exactIdentifiers",
            "decisions",
            "blockers",
            "openQuestions",
            "completedTodos",
        }
        assert required_fields.issubset(result["summary_json"].keys())

    def test_model_info_does_not_expose_api_key(self, monkeypatch):
        """model_info must not contain credentials."""
        import asyncio

        from hindsight_api.config import clear_config_cache
        from hindsight_api.engine.llm_wrapper import LLMProvider
        from hindsight_api.engine.session_summary import generate_session_summary

        monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
        monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
        monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "mock-model")
        clear_config_cache()

        provider = LLMProvider(
            provider="mock", api_key="sk-very-secret-key", base_url="", model="mock-model"
        )
        provider.set_mock_response({"schemaVersion": 1, "activeProjects": []})

        result = asyncio.get_event_loop().run_until_complete(
            generate_session_summary(
                {"session_id": "s", "identity_scope": "b", "messages": []},
                provider,
            )
        )

        model_info_str = str(result.get("model_info", {}))
        assert "sk-very-secret-key" not in model_info_str
        assert "secret" not in model_info_str.lower()

    def test_llm_json_parse_failure_returns_error_status(self, monkeypatch):
        """If LLM returns non-JSON, result status should be error."""
        import asyncio

        from hindsight_api.config import clear_config_cache
        from hindsight_api.engine.llm_wrapper import LLMProvider
        from hindsight_api.engine.session_summary import generate_session_summary

        monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
        monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
        monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "mock-model")
        clear_config_cache()

        provider = LLMProvider(provider="mock", api_key="", base_url="", model="mock-model")
        provider.set_mock_response("this is not json at all")

        result = asyncio.get_event_loop().run_until_complete(
            generate_session_summary(
                {"session_id": "s", "identity_scope": "b", "messages": []},
                provider,
            )
        )

        assert result["status"] == "error"
        assert result.get("error")


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------


class TestSessionSummaryHttpEndpoint:
    """Integration tests for the /v1/session-summary/generate endpoint."""

    @pytest.fixture()
    def test_app(self, monkeypatch):
        from hindsight_api.config import clear_config_cache

        monkeypatch.setenv("HINDSIGHT_API_SKIP_LLM_VERIFICATION", "true")
        monkeypatch.setenv("HINDSIGHT_API_LLM_PROVIDER", "mock")
        monkeypatch.setenv("HINDSIGHT_API_LLM_MODEL", "mock-model")
        monkeypatch.setenv("HINDSIGHT_API_LAZY_RERANKER", "true")
        clear_config_cache()

        from hindsight_api import MemoryEngine
        from hindsight_api.api.http import create_app

        memory = MemoryEngine(skip_llm_verification=True, lazy_reranker=True)
        return create_app(memory, initialize_memory=False)

    def test_endpoint_exists_and_accepts_minimal_request(self, test_app):
        from fastapi.testclient import TestClient

        client = TestClient(test_app)
        response = client.post(
            "/v1/session-summary/generate",
            json={
                "session_id": "test-session",
                "identity_scope": "bank-1",
                "messages": [{"role": "user", "content": "Working on hindsight-api."}],
            },
        )
        # Should be 200 (or at worst 500 from LLM), never 404
        assert response.status_code != 404

    def test_endpoint_returns_schema_compatible_response(self, test_app, monkeypatch):
        """Endpoint returns summary_json/summary_text/schema_version/status."""
        from unittest.mock import AsyncMock, patch

        from fastapi.testclient import TestClient
        from hindsight_api.engine.session_summary import generate_session_summary

        mock_result = {
            "status": "ready",
            "schema_version": 1,
            "summary_json": {
                "schemaVersion": 1,
                "activeProjects": ["hindsight-api"],
                "semanticAnchors": [],
                "exactIdentifiers": [],
                "decisions": [],
                "blockers": [],
                "openQuestions": [],
                "completedTodos": [],
            },
            "summary_text": "Active projects: hindsight-api",
            "model_info": {"provider": "mock", "model": "mock-model"},
        }

        with patch(
            "hindsight_api.engine.session_summary.generate_session_summary",
            new=AsyncMock(return_value=mock_result),
        ):
            client = TestClient(test_app)
            response = client.post(
                "/v1/session-summary/generate",
                json={
                    "session_id": "test-session",
                    "identity_scope": "bank-1",
                    "messages": [{"role": "user", "content": "Working on hindsight-api."}],
                },
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ready"
        assert data["schema_version"] == 1
        assert "summary_json" in data
        assert "summary_text" in data
        assert "activeProjects" in data["summary_json"]
