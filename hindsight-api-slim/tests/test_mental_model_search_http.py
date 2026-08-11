"""HTTP contract tests for bounded semantic mental-model search."""

from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_search_mental_models_http_contract(api_client, memory):
    memory.search_mental_models = AsyncMock(
        return_value=[
            {
                "id": "model-1",
                "name": "BPA editing model",
                "content": "Validate before writing.",
                "tags": ["bpa"],
                "relevance": 0.91,
                "updated_at": "2026-08-11T00:00:00+00:00",
                "may_be_stale": False,
                "staleness_reason": None,
                "truncated": False,
            }
        ]
    )

    response = await api_client.post(
        "/v1/default/banks/test-bank/mental-models/search",
        json={
            "query": "How should I edit a BPA case?",
            "max_results": 2,
            "max_tokens": 512,
            "min_relevance": 0.4,
        },
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["name"] == "BPA editing model"
    memory.search_mental_models.assert_awaited_once()
    kwargs = memory.search_mental_models.await_args.kwargs
    assert kwargs["max_results"] == 2
    assert kwargs["max_tokens"] == 512
    assert kwargs["min_relevance"] == 0.4
