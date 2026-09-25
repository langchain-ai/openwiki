#!/usr/bin/env python3
"""Prepare, run, and summarize paired DeepSWE/OpenWiki evaluations."""

from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import os
import random
import re
import shlex
import subprocess
import sys
import tomllib
import warnings
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence
from urllib.parse import urlsplit


DEEPSWE_REPOSITORY = "https://github.com/datacurve-ai/deep-swe.git"
# DeepSWE revision used for reproducible task definitions.
DEEPSWE_COMMIT = "6db64a40f3318d8659238ff34a8cc4b491c49205"
HARBOR_PACKAGE = "harbor[langsmith]==0.20.0"
LITELLM_PACKAGE = "litellm==1.83.14"
# Codex CLI version installed in each agent environment.
CODEX_VERSION = "0.144.6"
# Default coding-agent model for both experiment arms.
DEFAULT_MODEL = "openai/gpt-5.6-terra"
# Default model used to generate treatment wikis.
DEFAULT_OPENWIKI_MODEL = "gpt-5.6-terra"
# Shared LangSmith dataset keyed to the pinned benchmark revision.
DEFAULT_LANGSMITH_DATASET = f"deepswe-openwiki-{DEEPSWE_COMMIT[:12]}"
# Allowed hosts for requests made inside the eval containers.
DEFAULT_ALLOWED_HOSTS = (
    "deb.debian.org",
    "deb.nodesource.com",
    "registry.npmjs.org",
    "github.com",
    "release-assets.githubusercontent.com",
    "api.openai.com",
    "gateway.smith.langchain.com",
    "api.smith.langchain.com",
)
# Allowed characters for Harbor job names stored beneath the jobs directory.
JOB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
# Validator for additional network allowlist hostnames.
DNS_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
# Validator for Docker Compose network names derived from trials.
DOCKER_NETWORK_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# Directory containing the DeepSWE harness.
EVAL_DIR = Path(__file__).resolve().parent
# OpenWiki repository root packed for treatment runs.
PROJECT_ROOT = EVAL_DIR.parents[1]
# Default cache location for the pinned DeepSWE checkout.
DEFAULT_DEEPSWE_DIR = EVAL_DIR / ".cache" / "deep-swe"
# Default location for packed OpenWiki artifacts.
DEFAULT_ARTIFACTS_DIR = EVAL_DIR / "artifacts"
# Default location for raw Harbor job results.
DEFAULT_JOBS_DIR = EVAL_DIR / "results"
# Default location for aggregate JSON and trial CSV summaries.
DEFAULT_SUMMARY_DIR = EVAL_DIR / "summaries"
# Default host cache for generated task wikis.
DEFAULT_OPENWIKI_CACHE_DIR = EVAL_DIR / ".cache" / "openwiki-wikis"

# Five-task cohort used for fast iteration.
KOOTA_5_TASKS = (
    "koota-composite-trait-aspects",
    "koota-deferred-mutation-buffer",
    "koota-entity-snapshot-rollback",
    "koota-pair-relation-tracking",
    "koota-query-predicates",
)
# Fifteen difficult cross-repository tasks used with the Koota cohort.
WIKI_STRESS_15_TASKS = (
    "adaptix-name-mapping-aliases",
    "dynamodb-toolbox-lazy-recursive-schemas",
    "pebble-durability-wait-apis",
    "scriggo-method-declarations",
    "helm-unified-manifest-stream",
    "fastapi-implicit-head-options",
    "boa-hierarchical-evaluation-cancellation",
    "bandit-structured-nosec-directives",
    "effect-sse-httpapi-streaming",
    "katex-multicolumn-array-spans",
    "prometheus-transactional-reload-status",
    "opa-template-string-reconstruction",
    "oxvg-structural-selector-preservation",
    "kgateway-consistent-hash-policy",
    "python-statemachine-state-data-scoping",
)
# Ten disjoint tasks selected for high documentation leverage.
DOC_LEVERAGE_10_TASKS = (
    "aiomonitor-task-snapshots-diff",
    "bandit-incremental-cache-control",
    "dynamodb-toolbox-conditional-attribute-requirements",
    "fastapi-deprecation-response-headers",
    "go-genai-streamed-function-args",
    "goreleaser-retry-publish-auditing",
    "gql-incremental-graphql-delivery",
    "igel-persist-feature-schema",
    "onedump-dump-encryption-pipeline",
    "testem-bail-on-test-failure",
)

TASK_SUITES = {
    "koota-5": KOOTA_5_TASKS,
    "openwiki-doc-leverage-10": DOC_LEVERAGE_10_TASKS,
    "openwiki-20": (*KOOTA_5_TASKS, *WIKI_STRESS_15_TASKS),
}

# Ambient overrides removed so each Harbor job creates its own experiment.
LANGSMITH_ENV_UNSET = {
    "HARBOR_LANGSMITH_EXPERIMENT",
    "HARBOR_LANGSMITH_EXPERIMENT_ID",
}
# Stable columns written to the trial-level summary CSV.
SUMMARY_FIELDS = [
    "condition",
    "task_name",
    "trial_name",
    "reward",
    "exception_type",
    "input_tokens",
    "cache_tokens",
    "output_tokens",
    "cost_usd",
    "agent_duration_seconds",
    "total_duration_seconds",
    "openwiki_duration_seconds",
]


def validate_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "LangSmith endpoint must be an http(s) URL without credentials, "
            "a query, or a fragment"
        )
    return value


def validate_host(value: str) -> str:
    labels = value.split(".")
    if len(value) > 253 or any(not DNS_LABEL_RE.fullmatch(label) for label in labels):
        raise ValueError(f"allowed host must be a plain DNS hostname: {value!r}")
    return value.lower()


def run_checked(
    argv: Sequence[str],
    *,
    cwd: Path = PROJECT_ROOT,
    dry_run: bool = False,
    env_overrides: dict[str, str] | None = None,
    env_unset: Iterable[str] = (),
) -> None:
    print(f"+ {shlex.join(argv)}")
    if dry_run:
        return
    env = os.environ.copy()
    for key in env_unset:
        env.pop(key, None)
    env.update(env_overrides or {})
    subprocess.run(list(argv), cwd=cwd, env=env, check=True, shell=False)


def harbor_job_name(args: argparse.Namespace, condition: str) -> str:
    if not JOB_NAME_RE.fullmatch(args.run_name):
        raise ValueError(f"run name contains unsupported characters: {args.run_name!r}")
    return f"{args.run_name}-{condition}-seed-{args.seed}"


def _trial_network_identity(
    trial_dir: Path, *, job_dir: Path
) -> tuple[str, str] | None:
    """Return the expected Compose project and network for one direct trial child."""

    try:
        resolved_job = job_dir.resolve(strict=True)
        resolved_trial = trial_dir.resolve(strict=True)
    except OSError:
        return None
    if not resolved_trial.is_dir() or resolved_trial.parent != resolved_job:
        return None

    project_name = f"{resolved_trial.name.lower()}__env"
    network_name = f"{project_name}_default"
    if not DOCKER_NETWORK_RE.fullmatch(network_name):
        return None
    return project_name, network_name


def _cleanup_docker_networks(
    trials: Iterable[tuple[Path, Path]],
) -> None:
    """Best-effort removal of inactive, label-verified Harbor trial networks."""

    candidates: dict[str, str] = {}
    for job_dir, trial_dir in trials:
        identity = _trial_network_identity(trial_dir, job_dir=job_dir)
        if identity is not None:
            project_name, network_name = identity
            candidates[network_name] = project_name
    if not candidates:
        return

    try:
        listing = subprocess.run(
            ["docker", "network", "ls", "--format", "{{.Name}}"],
            check=False,
            capture_output=True,
            text=True,
            shell=False,
        )
    except OSError:
        warnings.warn(
            "Could not list Docker networks for Harbor cleanup; continuing",
            RuntimeWarning,
            stacklevel=2,
        )
        return
    if listing.returncode != 0:
        warnings.warn(
            "Could not list Docker networks for Harbor cleanup; continuing",
            RuntimeWarning,
            stacklevel=2,
        )
        return

    available = set(listing.stdout.splitlines())
    for network_name, project_name in sorted(candidates.items()):
        if network_name not in available:
            continue
        try:
            inspected = subprocess.run(
                ["docker", "network", "inspect", network_name],
                check=False,
                capture_output=True,
                text=True,
                shell=False,
            )
            if inspected.returncode != 0:
                continue
            payload = json.loads(inspected.stdout)
            if not isinstance(payload, list) or len(payload) != 1:
                continue
            network = payload[0]
            if not isinstance(network, dict):
                continue
            labels = network.get("Labels")
            containers = network.get("Containers")
            if (
                network.get("Name") != network_name
                or not isinstance(labels, dict)
                or labels.get("com.docker.compose.project") != project_name
                or labels.get("com.docker.compose.network") != "default"
                or not isinstance(containers, dict)
                or containers
            ):
                continue
            removed = subprocess.run(
                ["docker", "network", "rm", network_name],
                check=False,
                capture_output=True,
                text=True,
                shell=False,
            )
            if removed.returncode != 0:
                warnings.warn(
                    f"Could not remove inactive Harbor network {network_name!r}; "
                    "continuing",
                    RuntimeWarning,
                    stacklevel=2,
                )
        except (OSError, json.JSONDecodeError, TypeError):
            warnings.warn(
                f"Could not verify Harbor network {network_name!r}; continuing",
                RuntimeWarning,
                stacklevel=2,
            )


def cleanup_docker_networks(jobs_dir: Path, job_name: str | None = None) -> None:
    """Clean inactive networks from completed trials or one exact current job."""

    try:
        resolved_jobs = jobs_dir.resolve(strict=True)
        candidates = [jobs_dir / job_name] if job_name else jobs_dir.iterdir()
        trials: list[tuple[Path, Path]] = []
        for candidate in candidates:
            job_dir = candidate.resolve(strict=True)
            if job_dir.parent != resolved_jobs or not job_dir.is_dir():
                continue
            if job_name is None and not (job_dir / "config.json").is_file():
                continue
            for trial_dir in job_dir.iterdir():
                if trial_dir.is_dir() and (
                    job_name is not None or (trial_dir / "result.json").is_file()
                ):
                    trials.append((job_dir, trial_dir))
    except OSError:
        warnings.warn(
            "Could not inspect Harbor results for Docker cleanup; continuing",
            RuntimeWarning,
            stacklevel=2,
        )
        return
    _cleanup_docker_networks(trials)


def prepare_deepswe(destination: Path, *, dry_run: bool) -> None:
    if not destination.exists():
        destination.parent.mkdir(parents=True, exist_ok=True)
        run_checked(
            ["git", "clone", "--depth", "1", DEEPSWE_REPOSITORY, str(destination)],
            dry_run=dry_run,
        )
    if dry_run and not destination.exists():
        print(
            f"+ git -C {shlex.quote(str(destination))} "
            f"checkout --detach {DEEPSWE_COMMIT}"
        )
        return

    current = subprocess.run(
        ["git", "-C", str(destination), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        shell=False,
    ).stdout.strip()
    if current != DEEPSWE_COMMIT:
        run_checked(
            ["git", "-C", str(destination), "fetch", "origin", DEEPSWE_COMMIT],
            dry_run=dry_run,
        )
        run_checked(
            ["git", "-C", str(destination), "checkout", "--detach", DEEPSWE_COMMIT],
            dry_run=dry_run,
        )


def pack_openwiki(artifacts_dir: Path, *, dry_run: bool) -> Path:
    package_path = artifacts_dir / "openwiki-eval.tgz"
    if dry_run:
        print(
            "+ pnpm pack --pack-destination "
            f"{shlex.quote(str(artifacts_dir))} && rename package to "
            f"{shlex.quote(str(package_path))}"
        )
        return package_path

    artifacts_dir.mkdir(parents=True, exist_ok=True)
    for stale_package in artifacts_dir.glob("openwiki-*.tgz"):
        stale_package.unlink()
    run_checked(
        ["pnpm", "pack", "--pack-destination", str(artifacts_dir)],
        cwd=PROJECT_ROOT,
    )
    created = sorted(artifacts_dir.glob("openwiki-*.tgz"))
    if len(created) != 1:
        raise RuntimeError("Could not identify the package produced by pnpm pack")
    if package_path.exists():
        package_path.unlink()
    created[0].replace(package_path)
    return package_path


def harbor_args(
    args: argparse.Namespace,
    *,
    condition: str,
    package_path: Path | None = None,
    selected_tasks: Sequence[str] | None = None,
) -> list[str]:
    job_name = harbor_job_name(args, condition)
    command = [
        "uvx",
        "--python",
        "3.12",
        "--from",
        HARBOR_PACKAGE,
        "--with",
        LITELLM_PACKAGE,
        "harbor",
        "run",
        "--path",
        str(args.deepswe_dir / "tasks"),
        "--jobs-dir",
        str(args.jobs_dir),
        "--job-name",
        job_name,
        "--agent",
        (
            "openwiki_codex:BaselineCodex"
            if condition == "baseline"
            else "openwiki_codex:OpenWikiCodex"
        ),
        "--model",
        args.model,
        "--agent-kwarg",
        f"reasoning_effort={args.reasoning_effort}",
        "--agent-kwarg",
        f"version={CODEX_VERSION}",
        "--env",
        args.environment,
        "--n-attempts",
        str(args.attempts),
        "--n-concurrent",
        str(args.concurrency),
        "--agent-setup-timeout-multiplier",
        str(args.agent_setup_timeout_multiplier),
        "--n-tasks",
        str(len(selected_tasks) if selected_tasks is not None else args.n_tasks),
        "--plugin",
        "deepswe_langsmith:DeepSWELangSmithPlugin",
        "--yes",
    ]
    for task in selected_tasks if selected_tasks is not None else args.task:
        command.extend(["--include-task-name", task])
    allowed_hosts = dict.fromkeys(
        validate_host(host) for host in (*DEFAULT_ALLOWED_HOSTS, *args.allow_host)
    )
    for host in allowed_hosts:
        command.extend(["--allow-environment-host", host])
    if args.env_file is not None:
        command.extend(["--env-file", str(args.env_file)])
    if condition == "openwiki":
        if package_path is None:
            raise ValueError("package_path is required for the OpenWiki condition")
        command.extend(
            [
                "--agent-kwarg",
                f"openwiki_package={package_path.resolve()}",
                "--agent-kwarg",
                f"openwiki_cache_dir={args.openwiki_cache_dir.resolve()}",
                "--agent-kwarg",
                f"openwiki_model={args.openwiki_model}",
                "--agent-kwarg",
                f"openwiki_timeout_sec={args.openwiki_timeout}",
                "--agent-kwarg",
                f"retrieval_embedding_provider={args.retrieval_embedding_provider}",
                "--agent-kwarg",
                "reuse_compatible_wiki_cache="
                f"{str(args.reuse_compatible_wiki_cache).lower()}",
                "--agent-kwarg",
                f"require_openwiki_cache={str(args.require_openwiki_cache).lower()}",
            ]
        )
    return command


def ensure_credentials(args: argparse.Namespace) -> None:
    if args.dry_run or args.env_file is not None:
        return
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Source your shell configuration or pass "
            "--env-file; the harness never reads or prints the key value."
        )
    if not os.environ.get("LANGSMITH_API_KEY"):
        raise RuntimeError(
            "LANGSMITH_API_KEY is not set. Source your shell configuration or pass "
            "--env-file; the harness never reads or prints the key value."
        )


def langsmith_env(args: argparse.Namespace) -> dict[str, str]:
    """Return non-secret Harbor/LangSmith configuration for one job."""

    overrides = {
        "PYTHONPATH": str(EVAL_DIR),
        "HARBOR_LANGSMITH_DATASET": args.langsmith_dataset,
        "HARBOR_LANGSMITH_SYNC_DATASET": "true",
        "HARBOR_LANGSMITH_FAIL_FAST": "true",
    }
    if args.langsmith_endpoint:
        overrides["LANGSMITH_ENDPOINT"] = validate_endpoint(args.langsmith_endpoint)
    if args.langsmith_workspace_id:
        overrides["LANGSMITH_WORKSPACE_ID"] = args.langsmith_workspace_id
    return overrides


def prepare(args: argparse.Namespace) -> Path:
    prepare_deepswe(args.deepswe_dir, dry_run=args.dry_run)
    return pack_openwiki(args.artifacts_dir, dry_run=args.dry_run)


def select_tasks(args: argparse.Namespace) -> list[str] | None:
    """Select an exact, reproducible Harbor task set from the pinned checkout."""

    tasks_dir = args.deepswe_dir / "tasks"
    suite_tasks: list[str] | None = None
    if args.task_suite:
        suite_tasks = list(TASK_SUITES[args.task_suite])
    if not tasks_dir.is_dir():
        return suite_tasks
    candidates: list[tuple[str, str]] = []
    for config_path in sorted(tasks_dir.glob("*/task.toml")):
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
        configured_name = config.get("task", {}).get("name")
        local_id = config_path.parent.name
        if isinstance(configured_name, str):
            candidates.append((local_id, configured_name))
    if suite_tasks is not None:
        available = {local_id for local_id, _ in candidates}
        missing = [task_id for task_id in suite_tasks if task_id not in available]
        if missing:
            raise ValueError(
                f"DeepSWE task suite {args.task_suite!r} is missing pinned tasks: "
                f"{', '.join(missing)}"
            )
        return suite_tasks
    if args.task:
        candidates = [
            candidate
            for candidate in candidates
            if any(
                fnmatch.fnmatchcase(candidate[0], pattern)
                or fnmatch.fnmatchcase(candidate[1], pattern)
                or fnmatch.fnmatchcase(candidate[1].split("/")[-1], pattern)
                for pattern in args.task
            )
        ]
    if not candidates:
        raise ValueError("No DeepSWE tasks matched the requested filters")
    rng = random.Random(args.seed)
    rng.shuffle(candidates)
    return [local_id for local_id, _ in candidates[: args.n_tasks]]


def run_condition(
    args: argparse.Namespace,
    condition: str,
    *,
    package_path: Path | None = None,
) -> None:
    ensure_credentials(args)
    if not args.dry_run:
        args.jobs_dir.mkdir(parents=True, exist_ok=True)
    command = harbor_args(
        args,
        condition=condition,
        package_path=package_path,
        selected_tasks=select_tasks(args),
    )
    clean_docker = args.environment == "docker" and not args.dry_run
    job_name = harbor_job_name(args, condition)
    if clean_docker:
        cleanup_docker_networks(args.jobs_dir)
    try:
        run_checked(
            command,
            dry_run=args.dry_run,
            env_overrides=langsmith_env(args),
            env_unset=LANGSMITH_ENV_UNSET,
        )
    finally:
        if clean_docker:
            try:
                cleanup_docker_networks(args.jobs_dir, job_name)
            except Exception:
                warnings.warn(
                    "Docker network final cleanup failed; continuing",
                    RuntimeWarning,
                    stacklevel=2,
                )


def seconds_between(timing: dict[str, Any] | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    started = datetime.fromisoformat(timing["started_at"])
    finished = datetime.fromisoformat(timing["finished_at"])
    return round((finished - started).total_seconds(), 3)


def load_trial_rows(job_dir: Path, condition: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for result_path in sorted(job_dir.glob("*/result.json")):
        data = json.loads(result_path.read_text(encoding="utf-8"))
        if "task_name" not in data:
            continue
        agent_result = data.get("agent_result") or {}
        verifier_result = data.get("verifier_result") or {}
        rewards = verifier_result.get("rewards") or {}
        metadata = agent_result.get("metadata") or {}
        openwiki = metadata.get("openwiki") or {}
        exception = data.get("exception_info") or {}
        rows.append(
            {
                "condition": condition,
                "task_name": data["task_name"],
                "trial_name": data.get("trial_name"),
                "reward": rewards.get("reward"),
                "exception_type": exception.get("exception_type"),
                "input_tokens": agent_result.get("n_input_tokens"),
                "cache_tokens": agent_result.get("n_cache_tokens"),
                "output_tokens": agent_result.get("n_output_tokens"),
                "cost_usd": agent_result.get("cost_usd"),
                "agent_duration_seconds": seconds_between(data.get("agent_execution")),
                "total_duration_seconds": seconds_between(
                    {
                        "started_at": data.get("started_at"),
                        "finished_at": data.get("finished_at"),
                    }
                ),
                "openwiki_duration_seconds": openwiki.get("duration_seconds"),
            }
        )
    return rows


def mean(values: Iterable[float | int | None]) -> float | None:
    present = [float(value) for value in values if value is not None]
    return round(sum(present) / len(present), 6) if present else None


def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    rewards = [row["reward"] for row in rows if row["reward"] in (0, 1)]
    successful = [row for row in rows if row["reward"] == 1]
    return {
        "trials": len(rows),
        "errors": sum(1 for row in rows if row["exception_type"]),
        "invalid_rewards": sum(
            1
            for row in rows
            if row["reward"] is not None and row["reward"] not in (0, 1)
        ),
        "solve_rate": mean(rewards),
        "mean_input_tokens": mean(row["input_tokens"] for row in rows),
        "mean_cache_tokens": mean(row["cache_tokens"] for row in rows),
        "mean_output_tokens": mean(row["output_tokens"] for row in rows),
        "mean_cost_usd": mean(row["cost_usd"] for row in rows),
        "mean_agent_duration_seconds": mean(
            row["agent_duration_seconds"] for row in rows
        ),
        "mean_total_duration_seconds": mean(
            row["total_duration_seconds"] for row in rows
        ),
        "mean_openwiki_duration_seconds": mean(
            row["openwiki_duration_seconds"] for row in rows
        ),
        "successful_trials": len(successful),
        "successful_mean_input_tokens": mean(row["input_tokens"] for row in successful),
        "successful_mean_output_tokens": mean(
            row["output_tokens"] for row in successful
        ),
        "successful_mean_agent_duration_seconds": mean(
            row["agent_duration_seconds"] for row in successful
        ),
    }


def summarize(args: argparse.Namespace) -> tuple[Path, Path]:
    baseline_dir = args.jobs_dir / f"{args.run_name}-baseline-seed-{args.seed}"
    openwiki_dir = args.jobs_dir / f"{args.run_name}-openwiki-seed-{args.seed}"
    rows = load_trial_rows(baseline_dir, "baseline") + load_trial_rows(
        openwiki_dir, "openwiki"
    )
    if not rows:
        raise RuntimeError("No Harbor trial result.json files were found")

    by_condition: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_condition[row["condition"]].append(row)

    tasks_by_condition = {
        condition: sorted(row["task_name"] for row in condition_rows)
        for condition, condition_rows in by_condition.items()
    }
    paired_task_sets_match = tasks_by_condition.get(
        "baseline"
    ) == tasks_by_condition.get("openwiki")
    summary = {
        "run_name": args.run_name,
        "seed": args.seed,
        "paired_task_sets_match": paired_task_sets_match,
        "conditions": {
            condition: aggregate(condition_rows)
            for condition, condition_rows in sorted(by_condition.items())
        },
    }

    args.summary_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.summary_dir / f"{args.run_name}-seed-{args.seed}.json"
    csv_path = args.summary_dir / f"{args.run_name}-seed-{args.seed}-trials.csv"
    json_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SUMMARY_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(summary, indent=2))
    print(f"Wrote {json_path}")
    print(f"Wrote {csv_path}")
    return json_path, csv_path


def add_common_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--deepswe-dir", type=Path, default=DEFAULT_DEEPSWE_DIR)
    parser.add_argument("--artifacts-dir", type=Path, default=DEFAULT_ARTIFACTS_DIR)
    parser.add_argument("--jobs-dir", type=Path, default=DEFAULT_JOBS_DIR)
    parser.add_argument("--summary-dir", type=Path, default=DEFAULT_SUMMARY_DIR)
    parser.add_argument("--run-name", default="deepswe-openwiki")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--openwiki-model", default=DEFAULT_OPENWIKI_MODEL)
    parser.add_argument(
        "--reasoning-effort",
        choices=("low", "medium", "high", "xhigh", "max"),
        default="high",
    )
    parser.add_argument("--environment", choices=("docker", "modal"), default="docker")
    parser.add_argument("--n-tasks", type=int, default=10)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument(
        "--task-suite",
        choices=tuple(TASK_SUITES),
        help="Exact named task set; selects all members regardless of --n-tasks",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument(
        "--agent-setup-timeout-multiplier",
        type=float,
        default=3.0,
        help="Multiplier for Harbor's agent setup deadline (default: 3.0)",
    )
    parser.add_argument("--openwiki-timeout", type=int, default=5400)
    parser.add_argument(
        "--openwiki-cache-dir",
        type=Path,
        default=DEFAULT_OPENWIKI_CACHE_DIR,
        help="Persistent host cache for generated task wikis",
    )
    parser.add_argument(
        "--reuse-compatible-wiki-cache",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Reuse a cache whose recorded task commit and model match even when "
            "the packaged OpenWiki implementation changed"
        ),
    )
    parser.add_argument(
        "--require-openwiki-cache",
        action="store_true",
        help="Fail before wiki generation when no compatible cache exists",
    )
    parser.add_argument(
        "--retrieval-embedding-provider",
        choices=("local", "openai"),
        default="local",
        help="Vector engine used by the OpenWiki retrieval MCP server",
    )
    parser.add_argument("--env-file", type=Path)
    parser.add_argument(
        "--allow-host",
        action="append",
        default=[],
        help="Additional API gateway hostname allowed in the agent container",
    )
    parser.add_argument("--langsmith-dataset", default=DEFAULT_LANGSMITH_DATASET)
    parser.add_argument("--langsmith-endpoint")
    parser.add_argument("--langsmith-workspace-id")
    parser.add_argument("--dry-run", action="store_true")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "baseline", "openwiki", "paired", "summarize"):
        subparser = subparsers.add_parser(name)
        add_common_options(subparser)
    args = parser.parse_args(argv)
    if (
        args.n_tasks <= 0
        or args.attempts <= 0
        or args.concurrency <= 0
        or args.agent_setup_timeout_multiplier <= 0
    ):
        parser.error(
            "--n-tasks, --attempts, --concurrency, and "
            "--agent-setup-timeout-multiplier must be positive"
        )
    if args.task_suite and args.task:
        parser.error("--task-suite cannot be combined with --task")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "prepare":
            prepare(args)
        elif args.command == "baseline":
            prepare_deepswe(args.deepswe_dir, dry_run=args.dry_run)
            run_condition(args, "baseline")
        elif args.command == "openwiki":
            package_path = prepare(args)
            run_condition(args, "openwiki", package_path=package_path)
        elif args.command == "paired":
            package_path = prepare(args)
            run_condition(args, "baseline")
            run_condition(args, "openwiki", package_path=package_path)
            if not args.dry_run:
                summarize(args)
        elif args.command == "summarize":
            summarize(args)
        else:
            raise AssertionError(f"Unhandled command: {args.command}")
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
