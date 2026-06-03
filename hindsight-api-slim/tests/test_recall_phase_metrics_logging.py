from hindsight_api.api.http import _summarize_recall_phase_metrics


def test_summarize_recall_phase_metrics_groups_phase_durations_and_counts():
    trace = {
        "summary": {
            "phase_metrics": [
                {"phase_name": "generate_query_embedding", "duration_seconds": 0.012, "details": {}},
                {"phase_name": "semantic_retrieval", "duration_seconds": 0.2, "details": {"candidates": 32}},
                {"phase_name": "bm25_retrieval", "duration_seconds": 0.1, "details": {"candidates": 18}},
                {
                    "phase_name": "reranking",
                    "duration_seconds": 0.61,
                    "details": {"candidates_reranked": 100},
                },
                {"phase_name": "entity_hydration", "duration_seconds": 0.42, "details": {"entities": 7}},
                {"phase_name": "token_filtering", "duration_seconds": 0.08, "details": {}},
                {"phase_name": "merge_candidates", "duration_seconds": 0.03, "details": {"candidates_merged": 50}},
            ]
        }
    }

    fields = _summarize_recall_phase_metrics(trace)

    assert fields["embedding_ms"] == 12
    assert fields["retrieval_ms"] == 300
    assert fields["rerank_ms"] == 610
    assert fields["entity_hydration_ms"] == 420
    assert fields["token_filtering_ms"] == 80
    assert fields["merge_ms"] == 30
    assert fields["candidates_reranked"] == 100
    assert fields["candidates_merged"] == 50


def test_summarize_recall_phase_metrics_handles_missing_trace():
    assert _summarize_recall_phase_metrics(None) == {}
