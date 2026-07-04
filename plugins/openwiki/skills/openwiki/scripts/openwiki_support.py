#!/usr/bin/env python3
"""Small OpenWiki helpers for agent-native skill/plugin runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

OPENWIKI_DIR = "openwiki"
METADATA_PATH = Path(OPENWIKI_DIR) / ".last-update.json"

OPENWIKI_SECTION = """## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    context_parser = subparsers.add_parser("context")
    context_parser.add_argument("--mode", choices=["init", "update"], required=True)
    context_parser.add_argument("--repo", default=".")

    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--repo", default=".")

    metadata_parser = subparsers.add_parser("write-metadata")
    metadata_parser.add_argument("--mode", choices=["init", "update"], required=True)
    metadata_parser.add_argument("--repo", default=".")
    metadata_parser.add_argument("--before-snapshot", required=True)
    metadata_parser.add_argument("--model", default="agent-native")

    agent_ref_parser = subparsers.add_parser("agent-reference")
    agent_ref_parser.add_argument("--repo", default=".")

    args = parser.parse_args()
    repo = Path(args.repo).resolve()

    if args.command == "context":
        print(create_context(args.mode, repo))
        return 0

    if args.command == "snapshot":
        print(snapshot_openwiki(repo))
        return 0

    if args.command == "write-metadata":
        result = write_metadata(
            args.mode,
            repo,
            args.before_snapshot,
            args.model,
        )
        print(json.dumps(result, indent=2))
        return 0

    if args.command == "agent-reference":
        result = ensure_agent_reference(repo)
        print(json.dumps(result, indent=2))
        return 0

    parser.error(f"unsupported command: {args.command}")
    return 2


def create_context(mode: str, repo: Path) -> str:
    last_update = read_last_update(repo)
    sections = [
        "# OpenWiki run context",
        "",
        f"Repository root: {repo}",
        f"Mode: {mode}",
        "",
        "## Last update metadata",
        json.dumps(last_update, indent=2) if last_update else "No previous OpenWiki update metadata was found.",
        "",
        "## Git context",
        create_git_summary(mode, repo, last_update),
        "",
        "## OpenWiki content snapshot",
        snapshot_openwiki(repo),
    ]

    return "\n".join(sections)


def read_last_update(repo: Path) -> dict[str, Any] | None:
    metadata_file = repo / METADATA_PATH

    try:
        raw = metadata_file.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    if not isinstance(data, dict):
        return None

    updated_at = data.get("updatedAt")
    command = data.get("command")
    model = data.get("model")

    if not all(isinstance(value, str) for value in [updated_at, command, model]):
        return None

    result: dict[str, Any] = {
        "updatedAt": updated_at,
        "command": "init" if command == "init" else "update",
        "model": model,
    }

    git_head = data.get("gitHead")
    if isinstance(git_head, str):
        result["gitHead"] = git_head

    return result


def create_git_summary(
    mode: str,
    repo: Path,
    last_update: dict[str, Any] | None,
) -> str:
    sections: list[str] = []
    status = run_git(repo, ["status", "--short"])
    head = get_git_head(repo)

    sections.append(format_git_section("git status --short", status))
    sections.append(format_git_section("git rev-parse HEAD", head or "(unknown)"))

    if mode == "update" and last_update and isinstance(last_update.get("gitHead"), str):
        git_head = last_update["gitHead"]
        output = run_git(repo, ["log", f"{git_head}..HEAD", "--name-status", "--oneline"])
        sections.append(
            format_git_section(
                f"git log {git_head}..HEAD --name-status --oneline",
                output,
            )
        )
    elif mode == "update" and last_update and isinstance(last_update.get("updatedAt"), str):
        updated_at = last_update["updatedAt"]
        output = run_git(repo, ["log", "--since", updated_at, "--name-status", "--oneline"])
        sections.append(
            format_git_section(
                f"git log --since {updated_at} --name-status --oneline",
                output,
            )
        )
    else:
        if mode == "update":
            sections.append("No prior OpenWiki update timestamp was found.")
        recent = run_git(repo, ["log", "--max-count=20", "--name-status", "--oneline"])
        sections.append(
            format_git_section(
                "git log --max-count=20 --name-status --oneline",
                recent,
            )
        )

    diff = run_git(repo, ["diff", "--name-status", "HEAD"])
    sections.append(format_git_section("git diff --name-status HEAD", diff))

    return "\n\n".join(sections)


def run_git(repo: Path, args: list[str]) -> str:
    try:
        completed = subprocess.run(
            ["git", "--no-pager", *args],
            cwd=repo,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        return "git executable not found"

    return "\n".join(
        part.strip()
        for part in [completed.stdout, completed.stderr]
        if part and part.strip()
    ).strip()


def get_git_head(repo: Path) -> str | None:
    head = run_git(repo, ["rev-parse", "HEAD"])
    return head or None


def format_git_section(command: str, output: str) -> str:
    return f"$ {command}\n{output if output else '(no output)'}"


def snapshot_openwiki(repo: Path) -> str:
    openwiki_dir = repo / OPENWIKI_DIR
    digest = hashlib.sha256()

    add_directory_to_snapshot(digest, openwiki_dir, Path())

    return digest.hexdigest()


def add_directory_to_snapshot(
    digest: "hashlib._Hash",
    directory: Path,
    relative_directory: Path,
) -> None:
    try:
        entries = sorted(directory.iterdir(), key=lambda item: item.name)
    except (FileNotFoundError, NotADirectoryError):
        digest.update(b"missing")
        return

    for entry in entries:
        relative_path = relative_directory / entry.name

        if relative_path.as_posix() == METADATA_PATH.name:
            continue

        if entry.is_dir():
            digest.update(f"dir:{relative_path.as_posix()}\0".encode("utf-8"))
            add_directory_to_snapshot(digest, entry, relative_path)
            continue

        if not entry.is_file():
            continue

        try:
            content = entry.read_bytes()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            continue

        digest.update(f"file:{relative_path.as_posix()}\0".encode("utf-8"))
        digest.update(content)
        digest.update(b"\0")


def write_metadata(
    mode: str,
    repo: Path,
    before_snapshot: str,
    model: str,
) -> dict[str, Any]:
    after_snapshot = snapshot_openwiki(repo)

    if before_snapshot == after_snapshot:
        return {
            "changed": False,
            "metadataPath": str(METADATA_PATH),
            "reason": "openwiki content snapshot did not change",
        }

    metadata_file = repo / METADATA_PATH
    metadata_file.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "command": mode,
        "gitHead": get_git_head(repo),
        "model": model,
    }
    metadata_file.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    return {
        "changed": True,
        "metadataPath": str(METADATA_PATH),
        "metadata": metadata,
    }


def ensure_agent_reference(repo: Path) -> dict[str, Any]:
    candidates = [repo / "AGENTS.md", repo / "CLAUDE.md"]
    existing = [path for path in candidates if path.exists()]
    targets = existing or [repo / "AGENTS.md"]
    results: dict[str, str] = {}

    for target in targets:
        results[target.name] = ensure_agent_reference_file(target)

    return results


def ensure_agent_reference_file(path: Path) -> str:
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        path.write_text(OPENWIKI_SECTION, encoding="utf-8")
        return "created"

    existing = extract_openwiki_section(content)
    if existing is not None and normalize_section(existing) == normalize_section(OPENWIKI_SECTION):
        return "unchanged"

    if existing is None:
        separator = "" if content.endswith("\n") or not content else "\n\n"
        updated = f"{content}{separator}{OPENWIKI_SECTION}"
    else:
        updated = replace_openwiki_section(content, OPENWIKI_SECTION)

    if updated != content:
        path.write_text(updated, encoding="utf-8")
        return "updated"

    return "unchanged"


def extract_openwiki_section(content: str) -> str | None:
    match = re.search(
        r"(?ms)^## OpenWiki\s*\n.*?(?=^##\s+(?!OpenWiki\b)|\Z)",
        content,
    )
    return match.group(0) if match else None


def replace_openwiki_section(content: str, section: str) -> str:
    return re.sub(
        r"(?ms)^## OpenWiki\s*\n.*?(?=^##\s+(?!OpenWiki\b)|\Z)",
        section.rstrip() + "\n",
        content,
        count=1,
    )


def normalize_section(value: str) -> str:
    lines = [line.strip() for line in value.strip().splitlines()]
    return "\n".join(line for line in lines if line)


if __name__ == "__main__":
    sys.exit(main())
