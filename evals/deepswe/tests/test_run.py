from __future__ import annotations

import json
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from requests import HTTPError, Response

from evals.deepswe import deepswe_langsmith, openwiki_codex
from evals.deepswe import run as deepswe_run


class DeepSWEHarnessTests(unittest.TestCase):
    def test_langsmith_feedback_rounds_scores_and_skips_invalid_metrics(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        plugin._post_feedback = Mock()
        result = SimpleNamespace(
            verifier_result=SimpleNamespace(
                rewards={
                    "reward": 0,
                    "partial": 0.35877862595419846,
                    "count": 47,
                    "not_a_number": float("nan"),
                    "boolean": True,
                }
            ),
            exception_info=None,
        )

        plugin._create_feedback("00000000-0000-0000-0000-000000000001", result)

        payloads = [call.args[0] for call in plugin._post_feedback.call_args_list]
        self.assertEqual(["reward", "partial"], [payload["key"] for payload in payloads])
        self.assertEqual([0.0, 0.3588], [payload["score"] for payload in payloads])

    def test_langsmith_feedback_http_error_does_not_abort_trial(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        response = Response()
        response.status_code = 422
        response.headers["x-request-id"] = "safe-request-id"
        plugin._request = Mock(side_effect=HTTPError(response=response))

        with self.assertWarnsRegex(
            RuntimeWarning, "status=422, request_id=safe-request-id"
        ):
            plugin._post_feedback({"score": 0})

    def test_langsmith_feedback_programming_error_still_propagates(self) -> None:
        plugin = deepswe_langsmith.DeepSWELangSmithPlugin.__new__(
            deepswe_langsmith.DeepSWELangSmithPlugin
        )
        plugin._request = Mock(side_effect=TypeError("invalid payload"))

        with self.assertRaisesRegex(TypeError, "invalid payload"):
            plugin._post_feedback({"score": 0})

    def test_openwiki_install_rebuilds_only_native_sqlite_dependency(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("npm install -g", adapter)
        self.assertIn("--ignore-scripts", adapter)
        self.assertIn("npm rebuild better-sqlite3", adapter)
        self.assertIn("require('better-sqlite3')", adapter)

    def test_agent_install_ignores_broken_nodesource_apt_repository(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        disable_index = adapter.index("/etc/apt/sources.list.d/*nodesource*")
        update_index = adapter.index("apt-get update")

        self.assertLess(disable_index, update_index)
        self.assertIn('$source.disabled', adapter)

    def test_adapter_captures_committed_patch_for_separate_verifier(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("_GIT_COMMIT_RE.fullmatch(start_head)", adapter)
        self.assertIn("git config user.name 'DeepSWE Eval'", adapter)
        self.assertIn("git diff --binary", adapter)
        self.assertIn("/logs/artifacts/model.patch", adapter)
        self.assertIn("chmod 0600", adapter)

    def test_openwiki_treatment_uses_just_in_time_navigation(self) -> None:
        adapter = (deepswe_run.EVAL_DIR / "openwiki_codex.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("codex mcp add openwiki_retrieval", adapter)
        self.assertIn("command -v openwiki-retrieval-mcp || true", adapter)
        self.assertIn("if not retrieval_bin:", adapter)
        self.assertNotIn("def _build_register_mcp_servers_command", adapter)
        self.assertIn("--wiki-root", adapter)
        self.assertIn("(_APP_DIR / 'openwiki').as_posix()", adapter)
        self.assertIn("ensureCodeModeRepoSetup", adapter)
        self.assertIn("/logs/agent/openwiki-agents.md", adapter)
        self.assertIn("await super().run(instruction, environment, context)", adapter)
        self.assertNotIn("treatment_instruction", adapter)
        self.assertIn("':(exclude)AGENTS.md'", adapter)
        self.assertIn("':(exclude)openwiki/**'", adapter)

    def test_eval_defaults_use_terra_without_changing_openwiki_defaults(self) -> None:
        args = deepswe_run.parse_args(["paired"])
        self.assertEqual("openai/gpt-5.6-terra", args.model)
        self.assertEqual("gpt-5.6-terra", args.openwiki_model)

    def test_paired_commands_share_selection_and_agent_settings(self) -> None:
        args = deepswe_run.parse_args(
            [
                "paired",
                "--n-tasks",
                "7",
                "--seed",
                "42",
                "--task",
                "happy-dom-*",
                "--dry-run",
            ]
        )
        package = args.artifacts_dir / "openwiki-eval.tgz"
        baseline = deepswe_run.harbor_args(args, condition="baseline")
        treatment = deepswe_run.harbor_args(
            args, condition="openwiki", package_path=package
        )

        for flag in (
            "--path",
            "--model",
            "--env",
            "--n-attempts",
            "--n-concurrent",
            "--agent-setup-timeout-multiplier",
            "--n-tasks",
            "--include-task-name",
        ):
            self.assertEqual(
                baseline[baseline.index(flag) + 1], treatment[treatment.index(flag) + 1]
            )
        self.assertIn("openwiki_codex:BaselineCodex", baseline)
        self.assertIn("openwiki_codex:OpenWikiCodex", treatment)
        self.assertEqual(2, baseline.count("--agent-kwarg"))
        self.assertEqual(9, treatment.count("--agent-kwarg"))
        self.assertIn("retrieval_embedding_provider=local", treatment)
        self.assertIn(
            f"openwiki_cache_dir={args.openwiki_cache_dir.resolve()}", treatment
        )
        self.assertIn("reuse_compatible_wiki_cache=true", treatment)
        self.assertIn("require_openwiki_cache=false", treatment)
        self.assertIn(f"version={deepswe_run.CODEX_VERSION}", baseline)
        self.assertIn("gateway.smith.langchain.com", baseline)
        self.assertIn("api.smith.langchain.com", baseline)
        self.assertEqual(
            "3.0",
            baseline[baseline.index("--agent-setup-timeout-multiplier") + 1],
        )
        self.assertEqual(1, baseline.count("--plugin"))
        self.assertEqual(
            "deepswe_langsmith:DeepSWELangSmithPlugin",
            baseline[baseline.index("--plugin") + 1],
        )
        self.assertNotEqual(
            baseline[baseline.index("--job-name") + 1],
            treatment[treatment.index("--job-name") + 1],
        )

        baseline_env = deepswe_run.langsmith_env(args)
        treatment_env = deepswe_run.langsmith_env(args)
        self.assertEqual(
            baseline_env["HARBOR_LANGSMITH_DATASET"],
            treatment_env["HARBOR_LANGSMITH_DATASET"],
        )
        self.assertEqual("true", baseline_env["HARBOR_LANGSMITH_SYNC_DATASET"])
        self.assertEqual("true", baseline_env["HARBOR_LANGSMITH_FAIL_FAST"])

        for host in deepswe_run.DEFAULT_ALLOWED_HOSTS:
            self.assertIn(host, baseline)
            self.assertIn(host, treatment)

    def test_custom_agent_setup_timeout_multiplier_is_forwarded(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--agent-setup-timeout-multiplier", "4.5"]
        )
        command = deepswe_run.harbor_args(args, condition="baseline")

        self.assertEqual(
            "4.5",
            command[command.index("--agent-setup-timeout-multiplier") + 1],
        )

    def test_openwiki_cache_key_is_stable_and_configuration_sensitive(self) -> None:
        commit = "a" * 40
        first = openwiki_codex._wiki_cache_key(commit, "b" * 64, "model-a")
        self.assertEqual(
            first, openwiki_codex._wiki_cache_key(commit, "b" * 64, "model-a")
        )
        self.assertNotEqual(
            first, openwiki_codex._wiki_cache_key(commit, "b" * 64, "model-b")
        )

    def test_wiki_cache_archive_accepts_only_contained_regular_content(self) -> None:
        def write_archive(path: Path, entries: list[tuple[str, bytes, str]]) -> None:
            with tarfile.open(path, mode="w:gz") as archive:
                for name, content, kind in entries:
                    info = tarfile.TarInfo(name)
                    if kind == "file":
                        info.size = len(content)
                        archive.addfile(info, io.BytesIO(content))
                    elif kind == "dir":
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.type = tarfile.SYMTYPE
                        info.linkname = "../outside"
                        archive.addfile(info)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            valid = root / "valid.tgz"
            write_archive(
                valid,
                [
                    ("openwiki", b"", "dir"),
                    ("openwiki/quickstart.md", b"# Quickstart\n", "file"),
                ],
            )
            openwiki_codex._validate_wiki_cache_archive(valid)

            invalid_entries = {
                "absolute": [("/openwiki/quickstart.md", b"x", "file")],
                "traversal": [("openwiki/../outside", b"x", "file")],
                "outside": [("outside.txt", b"x", "file")],
                "symlink": [
                    ("openwiki/quickstart.md", b"", "symlink"),
                ],
                "missing": [("openwiki/overview.md", b"x", "file")],
            }
            for label, entries in invalid_entries.items():
                archive_path = root / f"{label}.tgz"
                write_archive(archive_path, entries)
                with self.subTest(label=label), self.assertRaises(ValueError):
                    openwiki_codex._validate_wiki_cache_archive(archive_path)

    def test_compatible_cache_requires_exact_commit_and_model_metadata(self) -> None:
        def write_cache(path: Path, commit: str, model: str) -> None:
            metadata = json.dumps({"gitHead": commit, "model": model}).encode()
            with tarfile.open(path, mode="w:gz") as archive:
                for name, content in (
                    ("openwiki/quickstart.md", b"# Quickstart\n"),
                    ("openwiki/.last-update.json", metadata),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))

        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            compatible = cache_dir / "old-package.tgz"
            exact = cache_dir / "new-package.tgz"
            commit = "a" * 40
            write_cache(compatible, commit, "model-a")

            selected, match = openwiki_codex._find_wiki_cache(
                cache_dir,
                exact,
                base_commit=commit,
                model="model-a",
                reuse_compatible=True,
            )
            self.assertEqual(compatible, selected)
            self.assertEqual("compatible", match)

            selected, match = openwiki_codex._find_wiki_cache(
                cache_dir,
                exact,
                base_commit=commit,
                model="model-b",
                reuse_compatible=True,
            )
            self.assertIsNone(selected)
            self.assertIsNone(match)

    def test_cache_only_cli_flags_are_forwarded(self) -> None:
        args = deepswe_run.parse_args(
            ["openwiki", "--require-openwiki-cache", "--dry-run"]
        )
        command = deepswe_run.harbor_args(
            args,
            condition="openwiki",
            package_path=args.artifacts_dir / "openwiki-eval.tgz",
        )
        self.assertIn("reuse_compatible_wiki_cache=true", command)
        self.assertIn("require_openwiki_cache=true", command)

    def test_custom_allowed_host_is_validated_and_included(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--allow-host", "Gateway.Example.com"]
        )
        command = deepswe_run.harbor_args(args, condition="baseline")
        self.assertIn("gateway.example.com", command)

        invalid = deepswe_run.parse_args(
            ["baseline", "--allow-host", "https://gateway.example.com/v1"]
        )
        with self.assertRaisesRegex(ValueError, "plain DNS hostname"):
            deepswe_run.harbor_args(invalid, condition="baseline")

    def test_credentials_require_openai_and_langsmith(self) -> None:
        args = deepswe_run.parse_args(["baseline"])
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "OPENAI_API_KEY"):
                deepswe_run.ensure_credentials(args)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "present"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "LANGSMITH_API_KEY"):
                deepswe_run.ensure_credentials(args)
        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "present", "LANGSMITH_API_KEY": "present"},
            clear=True,
        ):
            deepswe_run.ensure_credentials(args)

    def test_langsmith_endpoint_rejects_embedded_credentials(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--langsmith-endpoint", "https://user:secret@example.com"]
        )
        with self.assertRaisesRegex(ValueError, "without credentials"):
            deepswe_run.langsmith_env(args)

    def test_run_clears_ambient_experiment_overrides(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    "HARBOR_LANGSMITH_EXPERIMENT": "ambient",
                    "HARBOR_LANGSMITH_EXPERIMENT_ID": "ambient-id",
                },
            ),
            patch.object(deepswe_run.subprocess, "run") as run,
        ):
            deepswe_run.run_checked(
                ["harbor", "run"],
                env_unset=deepswe_run.LANGSMITH_ENV_UNSET,
            )
        child_env = run.call_args.kwargs["env"]
        self.assertNotIn("HARBOR_LANGSMITH_EXPERIMENT", child_env)
        self.assertNotIn("HARBOR_LANGSMITH_EXPERIMENT_ID", child_env)

    def test_cleanup_removes_only_inactive_owned_trial_network(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            jobs_dir = Path(temp_dir)
            job_dir = jobs_dir / "example-job"
            trial_dir = job_dir / "koota-query__AbC123"
            trial_dir.mkdir(parents=True)
            (job_dir / "config.json").write_text("{}\n", encoding="utf-8")
            (trial_dir / "result.json").write_text("{}\n", encoding="utf-8")
            network_name = "koota-query__abc123__env_default"
            project_name = "koota-query__abc123__env"

            def docker_run(command: list[str], **kwargs: object) -> SimpleNamespace:
                self.assertFalse(kwargs["shell"])
                if command[2] == "ls":
                    return SimpleNamespace(returncode=0, stdout=f"{network_name}\n")
                if command[2] == "inspect":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            [
                                {
                                    "Name": network_name,
                                    "Labels": {
                                        "com.docker.compose.project": project_name,
                                        "com.docker.compose.network": "default",
                                    },
                                    "Containers": {},
                                }
                            ]
                        ),
                    )
                self.assertEqual(["docker", "network", "rm", network_name], command)
                return SimpleNamespace(returncode=0, stdout=network_name)

            with patch.object(
                deepswe_run.subprocess, "run", side_effect=docker_run
            ) as run:
                deepswe_run.cleanup_docker_networks(jobs_dir)

            commands = [call.args[0] for call in run.call_args_list]
            self.assertIn(["docker", "network", "inspect", network_name], commands)
            self.assertIn(["docker", "network", "rm", network_name], commands)

    def test_cleanup_skips_active_or_foreign_trial_networks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir) / "example-job"
            active_trial = job_dir / "active__AbC"
            foreign_trial = job_dir / "foreign__DeF"
            active_trial.mkdir(parents=True)
            foreign_trial.mkdir()
            network_names = {
                "active__abc__env_default": {
                    "com.docker.compose.project": "active__abc__env",
                    "com.docker.compose.network": "default",
                },
                "foreign__def__env_default": {
                    "com.docker.compose.project": "another-project",
                    "com.docker.compose.network": "default",
                },
            }

            def docker_run(command: list[str], **kwargs: object) -> SimpleNamespace:
                self.assertFalse(kwargs["shell"])
                if command[2] == "ls":
                    return SimpleNamespace(
                        returncode=0, stdout="\n".join(network_names) + "\n"
                    )
                network_name = command[3]
                containers = (
                    {"attached": {}} if network_name.startswith("active") else {}
                )
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps(
                        [
                            {
                                "Name": network_name,
                                "Labels": network_names[network_name],
                                "Containers": containers,
                            }
                        ]
                    ),
                )

            with patch.object(
                deepswe_run.subprocess, "run", side_effect=docker_run
            ) as run:
                deepswe_run._cleanup_docker_networks(
                    [(job_dir, active_trial), (job_dir, foreign_trial)]
                )

            self.assertFalse(
                any(call.args[0][2] == "rm" for call in run.call_args_list)
            )

    def test_run_condition_cleans_docker_networks_even_when_harbor_fails(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--env-file", "credentials.env"]
        )
        with (
            patch.object(deepswe_run, "cleanup_docker_networks") as cleanup,
            patch.object(
                deepswe_run, "run_checked", side_effect=RuntimeError("harbor failed")
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "harbor failed"):
                deepswe_run.run_condition(args, "baseline")

        self.assertEqual(
            [
                unittest.mock.call(args.jobs_dir),
                unittest.mock.call(
                    args.jobs_dir, deepswe_run.harbor_job_name(args, "baseline")
                ),
            ],
            cleanup.call_args_list,
        )

    def test_cleanup_failure_does_not_mask_harbor_failure(self) -> None:
        args = deepswe_run.parse_args(
            ["baseline", "--env-file", "credentials.env"]
        )
        with (
            patch.object(
                deepswe_run,
                "cleanup_docker_networks",
                side_effect=[None, RuntimeError("cleanup failed")],
            ),
            patch.object(
                deepswe_run, "run_checked", side_effect=RuntimeError("harbor failed")
            ),
            self.assertWarnsRegex(RuntimeWarning, "final cleanup failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "harbor failed"):
                deepswe_run.run_condition(args, "baseline")

    def test_seeded_task_selection_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for name in ("alpha", "beta", "gamma"):
                task_dir = root / "tasks" / name
                task_dir.mkdir(parents=True)
                (task_dir / "task.toml").write_text(
                    f'[task]\nname = "datacurve/{name}"\n', encoding="utf-8"
                )
            args = deepswe_run.parse_args(
                [
                    "paired",
                    "--deepswe-dir",
                    str(root),
                    "--n-tasks",
                    "2",
                    "--seed",
                    "42",
                ]
            )
            first = deepswe_run.select_tasks(args)
            second = deepswe_run.select_tasks(args)
            self.assertEqual(first, second)
            self.assertEqual(2, len(first or []))
            self.assertTrue(all("/" not in task_id for task_id in first or []))

    def test_named_task_suites_are_independent_and_composable(self) -> None:
        koota = deepswe_run.TASK_SUITES["koota-5"]
        stress = deepswe_run.WIKI_STRESS_15_TASKS
        doc_leverage = deepswe_run.TASK_SUITES["openwiki-doc-leverage-10"]
        combined = deepswe_run.TASK_SUITES["openwiki-20"]

        self.assertEqual(
            {"koota-5", "openwiki-20", "openwiki-doc-leverage-10"},
            set(deepswe_run.TASK_SUITES),
        )
        self.assertEqual(5, len(koota))
        self.assertEqual(15, len(stress))
        self.assertEqual(10, len(doc_leverage))
        self.assertEqual(20, len(combined))
        self.assertTrue(set(koota).isdisjoint(stress))
        self.assertTrue(set(doc_leverage).isdisjoint(combined))
        self.assertEqual(len(doc_leverage), len(set(doc_leverage)))
        self.assertEqual((*koota, *stress), combined)

    def test_named_task_suite_selects_every_exact_member(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            expected = deepswe_run.TASK_SUITES["openwiki-20"]
            for name in expected:
                task_dir = root / "tasks" / name
                task_dir.mkdir(parents=True)
                (task_dir / "task.toml").write_text(
                    f'[task]\nname = "datacurve/{name}"\n', encoding="utf-8"
                )
            args = deepswe_run.parse_args(
                [
                    "baseline",
                    "--deepswe-dir",
                    str(root),
                    "--task-suite",
                    "openwiki-20",
                    "--n-tasks",
                    "1",
                ]
            )

            self.assertEqual(list(expected), deepswe_run.select_tasks(args))

    def test_named_task_suite_reports_missing_pinned_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            task_dir = root / "tasks" / deepswe_run.KOOTA_5_TASKS[0]
            task_dir.mkdir(parents=True)
            (task_dir / "task.toml").write_text(
                f'[task]\nname = "datacurve/{task_dir.name}"\n', encoding="utf-8"
            )
            args = deepswe_run.parse_args(
                [
                    "baseline",
                    "--deepswe-dir",
                    str(root),
                    "--task-suite",
                    "koota-5",
                ]
            )

            with self.assertRaisesRegex(ValueError, "missing pinned tasks"):
                deepswe_run.select_tasks(args)

    def test_named_task_suite_cannot_be_combined_with_task_filter(self) -> None:
        with self.assertRaises(SystemExit):
            deepswe_run.parse_args(
                [
                    "baseline",
                    "--task-suite",
                    "koota-5",
                    "--task",
                    "koota-*",
                ]
            )

    def test_load_and_aggregate_trial_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            job_dir = Path(temp_dir)
            trial_dir = job_dir / "trial-1"
            trial_dir.mkdir()
            (trial_dir / "result.json").write_text(
                json.dumps(
                    {
                        "task_name": "example-task",
                        "trial_name": "example-task__attempt-1",
                        "started_at": "2026-07-21T10:00:00+00:00",
                        "finished_at": "2026-07-21T10:02:00+00:00",
                        "agent_execution": {
                            "started_at": "2026-07-21T10:00:30+00:00",
                            "finished_at": "2026-07-21T10:01:30+00:00",
                        },
                        "agent_result": {
                            "n_input_tokens": 100,
                            "n_cache_tokens": 40,
                            "n_output_tokens": 25,
                            "cost_usd": 0.5,
                            "metadata": {"openwiki": {"duration_seconds": 20.0}},
                        },
                        "verifier_result": {"rewards": {"reward": 1}},
                    }
                ),
                encoding="utf-8",
            )

            rows = deepswe_run.load_trial_rows(job_dir, "openwiki")
            self.assertEqual(1, len(rows))
            self.assertEqual(120.0, rows[0]["total_duration_seconds"])
            self.assertEqual(60.0, rows[0]["agent_duration_seconds"])
            self.assertEqual(20.0, rows[0]["openwiki_duration_seconds"])
            self.assertEqual(1.0, deepswe_run.aggregate(rows)["solve_rate"])


if __name__ == "__main__":
    unittest.main()
