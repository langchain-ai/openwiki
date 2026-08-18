#!/usr/bin/env python3
"""Measure direct OpenWiki retrieval overhead in Codex DeepSWE traces.

The estimate intentionally follows a simple, reproducible rule: recorded
result characters and canonical tool-call JSON characters each cost one token
per four characters. It does not attempt to model repeated context-window
charges or tokenizer-specific behavior.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


CHARS_PER_TOKEN = 4
OPENWIKI_SERVER = "openwiki_retrieval"
OPENWIKI_AGENTS_START = "<!-- OPENWIKI:START -->"
OPENWIKI_AGENTS_END = "<!-- OPENWIKI:END -->"
MAX_AGENTS_BYTES = 1_048_576
TOOL_ITEM_TYPES = {
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "todo_list",
    "web_search",
}
OPENWIKI_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:/tmp/openwiki-source/)?openwiki/"
)
READ_COMMAND_RE = re.compile(
    r"(?:^|[;&|()\s])(?:/usr/bin/|/bin/)?"
    r"(?:cat|sed|rg|grep|head|tail|less|more|awk|wc|ls|find|stat|readlink)\b"
)


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int

@dataclass(frozen=True)
class TrialMetrics:
    task_name: str
    trial_dir: str
    total_tool_calls: int
    openwiki_mcp_calls: int
    openwiki_filesystem_calls: int
    call_json_chars: int
    result_chars: int
    agents_prompt_chars: int
    usage: Usage

    @property
    def openwiki_calls(self) -> int:
        return self.openwiki_mcp_calls + self.openwiki_filesystem_calls


def _dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def canonical_call_json(name: str, args: dict[str, Any]) -> str:
    """Return the stable representation used for tool-call token estimates."""

    return json.dumps(
        {"name": name, "args": args},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def is_openwiki_filesystem_read(command: str) -> bool:
    """Whether a logged shell call reads from a generated OpenWiki directory."""

    return bool(OPENWIKI_PATH_RE.search(command) and READ_COMMAND_RE.search(command))


def _mcp_result_text(item: dict[str, Any]) -> str:
    result = item.get("result")
    result_dict = _dict(result)
    if result_dict is not None:
        content = result_dict.get("content")
        if isinstance(content, list):
            text_blocks = []
            for block in content:
                block_dict = _dict(block)
                if block_dict is not None:
                    text_value = _string(block_dict.get("text"))
                    if text_value is not None:
                        text_blocks.append(text_value)
            if text_blocks:
                return "".join(text_blocks)
    if isinstance(result, str):
        return result
    error = _string(item.get("error"))
    return error or ""


def _managed_agents_chars(path: Path) -> int:
    try:
        if path.stat().st_size > MAX_AGENTS_BYTES:
            return 0
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0
    start = content.find(OPENWIKI_AGENTS_START)
    end = content.find(OPENWIKI_AGENTS_END, start + len(OPENWIKI_AGENTS_START))
    if start < 0 or end < 0:
        return 0
    return len(content[start : end + len(OPENWIKI_AGENTS_END)])


def _iter_jsonl_objects(path: Path) -> Iterable[dict[str, Any]]:
    try:
        with path.open(encoding="utf-8") as trace:
            for line in trace:
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                value_dict = _dict(value)
                if value_dict is not None:
                    yield value_dict
    except (OSError, UnicodeDecodeError):
        return


def _usage_from_event(event: dict[str, Any]) -> Usage | None:
    if event.get("type") != "turn.completed":
        return None
    usage = _dict(event.get("usage"))
    if usage is None:
        return None
    input_tokens = _nonnegative_int(usage.get("input_tokens"))
    cached_input_tokens = _nonnegative_int(usage.get("cached_input_tokens"))
    output_tokens = _nonnegative_int(usage.get("output_tokens"))
    if input_tokens is None or cached_input_tokens is None or output_tokens is None:
        return None
    if cached_input_tokens > input_tokens:
        return None
    return Usage(input_tokens, cached_input_tokens, output_tokens)


def analyze_trace(trace_path: Path, task_name: str) -> TrialMetrics | None:
    """Analyze one Codex JSONL trace, ignoring malformed or incomplete events."""

    pending: dict[str, list[dict[str, Any]]] = {}
    usage: Usage | None = None
    total_tool_calls = 0
    mcp_calls = 0
    filesystem_calls = 0
    call_json_chars = 0
    result_chars = 0

    for event in _iter_jsonl_objects(trace_path):
        parsed_usage = _usage_from_event(event)
        if parsed_usage is not None:
            usage = parsed_usage

        event_type = event.get("type")
        item = _dict(event.get("item"))
        if item is None:
            continue
        item_id = _string(item.get("id"))
        item_type = _string(item.get("type"))
        if item_id is None or item_type is None:
            continue
        if event_type == "item.started":
            pending.setdefault(item_id, []).append(item)
            if item_type in TOOL_ITEM_TYPES:
                total_tool_calls += 1
        elif event_type == "item.completed":
            candidates = pending.get(item_id)
            if not candidates:
                continue
            started_item = candidates.pop(0)
            if not candidates:
                pending.pop(item_id, None)

            started_type = started_item.get("type")
            if (
                started_type == "mcp_tool_call"
                and started_item.get("server") == OPENWIKI_SERVER
            ):
                tool = _string(started_item.get("tool"))
                arguments = _dict(started_item.get("arguments"))
                if tool is None or arguments is None:
                    continue
                mcp_calls += 1
                call_json_chars += len(
                    canonical_call_json(f"{OPENWIKI_SERVER}.{tool}", arguments)
                )
                result_chars += len(_mcp_result_text(item))
            elif started_type == "command_execution":
                command = _string(started_item.get("command"))
                if command is None or not is_openwiki_filesystem_read(command):
                    continue
                filesystem_calls += 1
                call_json_chars += len(
                    canonical_call_json("command_execution", {"command": command})
                )
                output = _string(item.get("aggregated_output"))
                if output is not None:
                    result_chars += len(output)

    if usage is None:
        return None

    return TrialMetrics(
        task_name=task_name,
        trial_dir=str(trace_path.parent.parent),
        total_tool_calls=total_tool_calls,
        openwiki_mcp_calls=mcp_calls,
        openwiki_filesystem_calls=filesystem_calls,
        call_json_chars=call_json_chars,
        result_chars=result_chars,
        agents_prompt_chars=_managed_agents_chars(
            trace_path.parent / "openwiki-agents.md"
        ),
        usage=usage,
    )


def collect_trials(job_dirs: Iterable[Path]) -> list[TrialMetrics]:
    trials = []
    seen_trial_dirs: set[Path] = set()
    for supplied_dir in job_dirs:
        try:
            job_dir = supplied_dir.resolve(strict=True)
        except OSError as exc:
            raise ValueError(f"job directory does not exist: {supplied_dir}") from exc
        if not job_dir.is_dir():
            raise ValueError(f"job path is not a directory: {supplied_dir}")
        for result_path in job_dir.rglob("result.json"):
            try:
                resolved_result = result_path.resolve(strict=True)
                resolved_result.relative_to(job_dir)
                result = json.loads(resolved_result.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            result = _dict(result)
            task_name = _string(result.get("task_name")) if result else None
            trace_path = resolved_result.parent / "agent" / "codex.txt"
            if task_name is None or not trace_path.is_file():
                continue
            trial_dir = trace_path.parent.parent.resolve()
            if trial_dir in seen_trial_dirs:
                continue
            metrics = analyze_trace(trace_path, task_name)
            if metrics is not None:
                trials.append(metrics)
                seen_trial_dirs.add(trial_dir)
    return sorted(trials, key=lambda trial: (trial.task_name, trial.trial_dir))


def summarize(trials: list[TrialMetrics]) -> dict[str, Any]:
    if not trials:
        raise ValueError("no valid completed trials with Codex usage were found")

    count = len(trials)
    total_tool_calls = sum(trial.total_tool_calls for trial in trials)
    mcp_calls = sum(trial.openwiki_mcp_calls for trial in trials)
    filesystem_calls = sum(trial.openwiki_filesystem_calls for trial in trials)
    openwiki_calls = mcp_calls + filesystem_calls
    call_chars = sum(trial.call_json_chars for trial in trials)
    result_chars = sum(trial.result_chars for trial in trials)
    agents_chars = sum(trial.agents_prompt_chars for trial in trials)
    call_tokens = call_chars / CHARS_PER_TOKEN
    result_tokens = result_chars / CHARS_PER_TOKEN
    agents_tokens = agents_chars / CHARS_PER_TOKEN
    direct_tool_tokens = call_tokens + result_tokens
    overhead_tokens = direct_tool_tokens + agents_tokens
    raw = {
        "input_tokens": sum(trial.usage.input_tokens for trial in trials),
        "cached_input_tokens": sum(
            trial.usage.cached_input_tokens for trial in trials
        ),
        "uncached_input_tokens": sum(
            trial.usage.input_tokens - trial.usage.cached_input_tokens
            for trial in trials
        ),
        "output_tokens": sum(trial.usage.output_tokens for trial in trials),
        "total_tokens": sum(
            trial.usage.input_tokens + trial.usage.output_tokens for trial in trials
        ),
    }

    adjusted = {
        "input_tokens": raw["input_tokens"] - result_tokens - agents_tokens,
        "uncached_input_tokens": (
            raw["uncached_input_tokens"] - result_tokens - agents_tokens
        ),
        "output_tokens": raw["output_tokens"] - call_tokens,
        "total_tokens": raw["total_tokens"] - overhead_tokens,
        "tool_calls": total_tool_calls - openwiki_calls,
    }
    per_trial = {
        "raw_uncached_input_tokens": raw["uncached_input_tokens"] / count,
        "raw_input_tokens": raw["input_tokens"] / count,
        "raw_output_tokens": raw["output_tokens"] / count,
        "raw_total_tokens": raw["total_tokens"] / count,
        "raw_tool_calls": total_tool_calls / count,
        "openwiki_calls": openwiki_calls / count,
        "openwiki_estimated_tokens": overhead_tokens / count,
        "adjusted_input_tokens": adjusted["input_tokens"] / count,
        "adjusted_output_tokens": adjusted["output_tokens"] / count,
        "adjusted_total_tokens": adjusted["total_tokens"] / count,
        "adjusted_tool_calls": adjusted["tool_calls"] / count,
    }

    return {
        "estimation": {
            "chars_per_token": CHARS_PER_TOKEN,
            "scope": (
                "direct tool-call JSON, tool-result text, and one inclusion of "
                "the managed OpenWiki AGENTS.md block"
            ),
            "caveat": (
                "AGENTS.md is automatically loaded, not a tool call. The estimate "
                "does not model repeated cached-context amplification or "
                "tokenizer-specific counts."
            ),
        },
        "trials": count,
        "tasks": len({trial.task_name for trial in trials}),
        "tool_calls": {
            "all": total_tool_calls,
            "openwiki": openwiki_calls,
            "openwiki_mcp": mcp_calls,
            "openwiki_filesystem": filesystem_calls,
            "adjusted_without_openwiki": adjusted["tool_calls"],
        },
        "openwiki_token_overhead": {
            "call_json_chars": call_chars,
            "call_json_tokens": call_tokens,
            "result_chars": result_chars,
            "result_tokens": result_tokens,
            "agents_prompt_chars": agents_chars,
            "agents_prompt_tokens": agents_tokens,
            "direct_tool_tokens": direct_tool_tokens,
            "total_tokens": overhead_tokens,
        },
        "raw_usage": raw,
        "adjusted_usage": adjusted,
        "per_trial": per_trial,
        "trial_details": [
            {
                **{key: value for key, value in asdict(trial).items() if key != "usage"},
                "openwiki_calls": trial.openwiki_calls,
                "estimated_openwiki_tokens": (
                    trial.call_json_chars
                    + trial.result_chars
                    + trial.agents_prompt_chars
                )
                / CHARS_PER_TOKEN,
                "usage": asdict(trial.usage),
            }
            for trial in trials
        ],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--job-dir",
        action="append",
        required=True,
        type=Path,
        help="Harbor job directory; repeat for retry directories and replicates.",
    )
    parser.add_argument(
        "--json-output",
        type=Path,
        help="Also write the complete JSON summary to this path.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        summary = summarize(collect_trials(args.job_dir))
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    rendered = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    print(rendered, end="")
    if args.json_output is not None:
        args.json_output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
