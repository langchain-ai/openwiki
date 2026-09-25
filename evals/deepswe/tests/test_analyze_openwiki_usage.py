import json
import tempfile
import unittest
from pathlib import Path

from evals.deepswe import analyze_openwiki_usage as analyzer


def event(event_type: str, item: dict) -> str:
    return json.dumps({"type": event_type, "item": item})


class AnalyzeOpenWikiUsageTests(unittest.TestCase):
    def test_canonical_call_json_and_filesystem_classification(self) -> None:
        rendered = analyzer.canonical_call_json("tool", {"z": 1, "a": "two"})
        self.assertEqual('{"args":{"a":"two","z":1},"name":"tool"}', rendered)
        self.assertTrue(
            analyzer.is_openwiki_filesystem_read(
                "sed -n '1,80p' /tmp/openwiki-source/openwiki/quickstart.md"
            )
        )
        self.assertTrue(analyzer.is_openwiki_filesystem_read("rg foo openwiki/"))
        self.assertFalse(analyzer.is_openwiki_filesystem_read("rm -rf openwiki/"))
        self.assertFalse(analyzer.is_openwiki_filesystem_read("rg openwiki src/"))

    def test_analyze_trace_pairs_events_and_counts_direct_overhead(self) -> None:
        mcp_started = {
            "id": "mcp-1",
            "type": "mcp_tool_call",
            "server": "openwiki_retrieval",
            "tool": "change_surface",
            "arguments": {"query": "routing"},
        }
        mcp_completed = {
            **mcp_started,
            "result": {
                "content": [
                    {"type": "text", "text": "first"},
                    {"type": "text", "text": "second"},
                ]
            },
        }
        shell_started = {
            "id": "shell-1",
            "type": "command_execution",
            "command": "cat openwiki/quickstart.md",
        }
        shell_completed = {
            **shell_started,
            "aggregated_output": "wiki text\n",
        }
        unrelated_started = {
            "id": "shell-2",
            "type": "command_execution",
            "command": "rg routing src tests",
        }
        unrelated_completed = {**unrelated_started, "aggregated_output": "match\n"}
        other_mcp = {
            "id": "mcp-2",
            "type": "mcp_tool_call",
            "server": "other_server",
            "tool": "search",
            "arguments": {},
        }
        file_change = {
            "id": "edit-1",
            "type": "file_change",
            "changes": [{"path": "/app/module.py", "kind": "update"}],
        }
        todo_list = {
            "id": "todo-1",
            "type": "todo_list",
            "items": [],
        }

        lines = [
            "not json",
            event("item.started", mcp_started),
            event("item.completed", mcp_completed),
            event("item.started", shell_started),
            event("item.completed", shell_completed),
            event("item.started", unrelated_started),
            event("item.completed", unrelated_completed),
            event("item.started", other_mcp),
            event("item.completed", {**other_mcp, "result": "ignored"}),
            event("item.started", file_change),
            event("item.completed", file_change),
            event("item.started", todo_list),
            event("item.completed", todo_list),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 1000,
                        "cached_input_tokens": 600,
                        "output_tokens": 200,
                    },
                }
            ),
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            trace = Path(temp_dir) / "codex.txt"
            trace.write_text("\n".join(lines), encoding="utf-8")
            (trace.parent / "openwiki-agents.md").write_text(
                "prefix\n<!-- OPENWIKI:START -->wiki guidance"
                "<!-- OPENWIKI:END -->\nsuffix\n",
                encoding="utf-8",
            )
            result = analyzer.analyze_trace(trace, "owner/task")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(6, result.total_tool_calls)
        self.assertEqual(1, result.openwiki_mcp_calls)
        self.assertEqual(1, result.openwiki_filesystem_calls)
        expected_call_chars = len(
            analyzer.canonical_call_json(
                "openwiki_retrieval.change_surface", {"query": "routing"}
            )
        ) + len(
            analyzer.canonical_call_json(
                "command_execution", {"command": "cat openwiki/quickstart.md"}
            )
        )
        self.assertEqual(expected_call_chars, result.call_json_chars)
        self.assertEqual(len("firstsecondwiki text\n"), result.result_chars)
        self.assertGreater(result.agents_prompt_chars, 0)
        self.assertEqual(
            400, result.usage.input_tokens - result.usage.cached_input_tokens
        )

    def test_collect_trials_includes_complete_usage_even_after_verifier_failure(
        self,
    ) -> None:
        def write_trial(root: Path, name: str, *, valid: bool, complete: bool) -> None:
            trial = root / name
            (trial / "agent").mkdir(parents=True)
            result = {
                "task_name": f"owner/{name}",
                "exception_info": None if valid else {"message": "failed"},
                "verifier_result": {"rewards": {"reward": 1}},
            }
            (trial / "result.json").write_text(json.dumps(result), encoding="utf-8")
            trace_lines = []
            if complete:
                trace_lines.append(
                    json.dumps(
                        {
                            "type": "turn.completed",
                            "usage": {
                                "input_tokens": 20,
                                "cached_input_tokens": 10,
                                "output_tokens": 5,
                            },
                        }
                    )
                )
            (trial / "agent" / "codex.txt").write_text(
                "\n".join(trace_lines), encoding="utf-8"
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_trial(root, "valid", valid=True, complete=True)
            write_trial(root, "failed", valid=False, complete=True)
            write_trial(root, "incomplete", valid=True, complete=False)
            trials = analyzer.collect_trials([root])

        self.assertEqual(
            ["owner/failed", "owner/valid"],
            [trial.task_name for trial in trials],
        )

    def test_analyze_trace_scopes_reused_item_ids_to_each_completion(self) -> None:
        reused_id = "item_1"
        mcp_started = {
            "id": reused_id,
            "type": "mcp_tool_call",
            "server": "openwiki_retrieval",
            "tool": "change_surface",
            "arguments": {"query": "ownership"},
        }
        shell_started = {
            "id": reused_id,
            "type": "command_execution",
            "command": "sed -n '1,40p' openwiki/quickstart.md",
        }
        lines = [
            event("item.started", mcp_started),
            event(
                "item.completed",
                {**mcp_started, "result": {"content": [{"text": "brief"}]}},
            ),
            event("item.started", shell_started),
            event(
                "item.completed",
                {**shell_started, "aggregated_output": "quickstart"},
            ),
            json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 50,
                        "output_tokens": 25,
                    },
                }
            ),
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            trace = Path(temp_dir) / "codex.txt"
            trace.write_text("\n".join(lines), encoding="utf-8")
            result = analyzer.analyze_trace(trace, "owner/task")

        self.assertIsNotNone(result)
        assert result is not None
        self.assertEqual(2, result.total_tool_calls)
        self.assertEqual(1, result.openwiki_mcp_calls)
        self.assertEqual(1, result.openwiki_filesystem_calls)
        self.assertEqual(len("briefquickstart"), result.result_chars)

    def test_summary_subtracts_calls_and_estimated_tokens(self) -> None:
        trial = analyzer.TrialMetrics(
            task_name="owner/task",
            trial_dir="/trial",
            total_tool_calls=10,
            openwiki_mcp_calls=2,
            openwiki_filesystem_calls=1,
            call_json_chars=40,
            result_chars=80,
            agents_prompt_chars=20,
            usage=analyzer.Usage(1000, 600, 200),
        )
        summary = analyzer.summarize([trial])

        self.assertEqual(35, summary["openwiki_token_overhead"]["total_tokens"])
        self.assertEqual(7, summary["tool_calls"]["adjusted_without_openwiki"])
        self.assertEqual(975, summary["adjusted_usage"]["input_tokens"])
        self.assertEqual(190, summary["adjusted_usage"]["output_tokens"])
        self.assertEqual(1165, summary["adjusted_usage"]["total_tokens"])


if __name__ == "__main__":
    unittest.main()
