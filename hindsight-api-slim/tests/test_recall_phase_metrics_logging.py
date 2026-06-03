import logging

from hindsight_api.api.http import _log_slow_recall_phases, _summarize_recall_phase_metrics


def test_summarize_recall_phase_metrics_separates_wall_sum_subphases_and_counts():
    trace = {
        "summary": {
            "phase_metrics": [
                {"phase_name": "generate_query_embedding", "duration_seconds": 0.012, "details": {}},
                {
                    "phase_name": "parallel_retrieval",
                    "duration_seconds": 0.25,
                    "details": {
                        "semantic_count": 32,
                        "bm25_count": 18,
                        "graph_count": 11,
                        "temporal_count": 4,
                    },
                },
                {"phase_name": "retrieval_semantic", "duration_seconds": 0.2, "details": {}},
                {"phase_name": "retrieval_bm25", "duration_seconds": 0.1, "details": {}},
                {"phase_name": "retrieval_graph", "duration_seconds": 0.3, "details": {}},
                {"phase_name": "retrieval_temporal_extraction", "duration_seconds": 0.04, "details": {}},
                {"phase_name": "retrieval_temporal", "duration_seconds": 0.05, "details": {}},
                {
                    "phase_name": "reranking",
                    "duration_seconds": 0.61,
                    "details": {"candidates_reranked": 100},
                },
                {"phase_name": "entity_hydration", "duration_seconds": 0.42, "details": {"entities": 7}},
                {"phase_name": "source_fact_hydration", "duration_seconds": 0.09, "details": {"source_facts": 12}},
                {"phase_name": "token_filtering", "duration_seconds": 0.08, "details": {}},
                {"phase_name": "rrf_merge", "duration_seconds": 0.03, "details": {"candidates_merged": 50}},
            ]
        }
    }

    fields = _summarize_recall_phase_metrics(trace)

    assert fields["embedding_ms"] == 12
    assert fields["retrieval_wall_ms"] == 250
    assert fields["retrieval_sum_ms"] == 690
    assert fields["retrieval_semantic_ms"] == 200
    assert fields["retrieval_bm25_ms"] == 100
    assert fields["retrieval_graph_ms"] == 300
    assert fields["retrieval_temporal_extraction_ms"] == 40
    assert fields["retrieval_temporal_ms"] == 50
    assert fields["rrf_merge_ms"] == 30
    assert fields["rerank_ms"] == 610
    assert fields["entity_hydration_ms"] == 420
    assert fields["source_fact_hydration_ms"] == 90
    assert fields["token_filtering_ms"] == 80
    assert fields["candidates_semantic"] == 32
    assert fields["candidates_bm25"] == 18
    assert fields["candidates_graph"] == 11
    assert fields["candidates_temporal"] == 4
    assert fields["candidates_reranked"] == 100
    assert fields["candidates_merged"] == 50


def test_summarize_recall_phase_metrics_handles_legacy_retrieval_without_wall_metric():
    trace = {
        "summary": {
            "phase_metrics": [
                {"phase_name": "semantic_retrieval", "duration_seconds": 0.2, "details": {"candidates": 32}},
                {"phase_name": "bm25_retrieval", "duration_seconds": 0.1, "details": {"candidates": 18}},
            ]
        }
    }

    fields = _summarize_recall_phase_metrics(trace)

    assert fields["retrieval_wall_ms"] == 300
    assert fields["retrieval_sum_ms"] == 300
    assert fields["retrieval_semantic_ms"] == 200
    assert fields["retrieval_bm25_ms"] == 100
    assert fields["candidates_semantic"] == 32
    assert fields["candidates_bm25"] == 18


def test_log_slow_recall_phases_includes_request_scoped_phase(caplog):
    caplog.set_level(logging.WARNING, logger="hindsight_api.api.http")

    _log_slow_recall_phases(
        "saber-prod",
        "saber-pr-abc123",
        {"retrieval_graph_ms": 2501, "rerank_ms": 1999},
        threshold_ms=2000,
    )

    messages = [r.message for r in caplog.records]
    assert any("[RECALL SLOW PHASE]" in m for m in messages)
    assert any("recall_id=saber-pr-abc123" in m and "phase=retrieval_graph" in m for m in messages)
    assert not any("phase=rerank" in m for m in messages)


def test_summarize_recall_phase_metrics_handles_missing_trace():
    assert _summarize_recall_phase_metrics(None) == {}
