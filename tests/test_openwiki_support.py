from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "plugins"
    / "openwiki"
    / "skills"
    / "openwiki"
    / "scripts"
    / "openwiki_support.py"
)

spec = importlib.util.spec_from_file_location("openwiki_support", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")

openwiki_support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(openwiki_support)


class OpenWikiSupportTests(unittest.TestCase):
    def test_snapshot_ignores_metadata_but_tracks_content_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            openwiki_dir = repo / "openwiki"
            openwiki_dir.mkdir()
            (openwiki_dir / "quickstart.md").write_text("# Start\n", encoding="utf-8")
            (openwiki_dir / ".last-update.json").write_text(
                '{"updatedAt":"old"}\n',
                encoding="utf-8",
            )

            original = openwiki_support.snapshot_openwiki(repo)
            self.assertRegex(original, r"^[0-9a-f]{64}$")

            (openwiki_dir / ".last-update.json").write_text(
                '{"updatedAt":"new"}\n',
                encoding="utf-8",
            )
            self.assertEqual(original, openwiki_support.snapshot_openwiki(repo))

            (openwiki_dir / "quickstart.md").write_text(
                "# Start\n\nUpdated.\n",
                encoding="utf-8",
            )
            self.assertNotEqual(original, openwiki_support.snapshot_openwiki(repo))

    def test_write_metadata_skips_when_snapshot_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            (repo / "openwiki").mkdir()
            (repo / "openwiki" / "quickstart.md").write_text(
                "# Start\n",
                encoding="utf-8",
            )
            before_snapshot = openwiki_support.snapshot_openwiki(repo)

            result = openwiki_support.write_metadata(
                "update",
                repo,
                before_snapshot,
                "agent-native",
            )

            self.assertEqual(
                result,
                {
                    "changed": False,
                    "metadataPath": "openwiki/.last-update.json",
                    "reason": "openwiki content snapshot did not change",
                },
            )
            self.assertFalse((repo / "openwiki" / ".last-update.json").exists())

    def test_write_metadata_records_changed_openwiki_content(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            self._init_git_repo(repo)
            openwiki_dir = repo / "openwiki"
            openwiki_dir.mkdir()
            (openwiki_dir / "quickstart.md").write_text("# Start\n", encoding="utf-8")
            before_snapshot = openwiki_support.snapshot_openwiki(repo)

            (openwiki_dir / "quickstart.md").write_text(
                "# Start\n\nUpdated.\n",
                encoding="utf-8",
            )
            result = openwiki_support.write_metadata(
                "init",
                repo,
                before_snapshot,
                "codex-native",
            )

            metadata_path = openwiki_dir / ".last-update.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertTrue(result["changed"])
            self.assertEqual(result["metadataPath"], "openwiki/.last-update.json")
            self.assertEqual(result["metadata"], metadata)
            self.assertEqual(metadata["command"], "init")
            self.assertEqual(metadata["model"], "codex-native")
            self.assertEqual(metadata["gitHead"], self._git(repo, "rev-parse", "HEAD"))
            self.assertRegex(metadata["updatedAt"], r"^\d{4}-\d{2}-\d{2}T.*Z$")

    def test_agent_reference_is_dry_run_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            agents = repo / "AGENTS.md"
            agents.write_text("# Existing\n\nKeep this.\n", encoding="utf-8")

            result = openwiki_support.ensure_agent_reference(repo)

            self.assertEqual(result, {"AGENTS.md": "would_update"})
            self.assertEqual(
                agents.read_text(encoding="utf-8"),
                "# Existing\n\nKeep this.\n",
            )

    def test_agent_reference_apply_updates_existing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            agents = repo / "AGENTS.md"
            claude = repo / "CLAUDE.md"
            agents.write_text("# Agent Notes\n", encoding="utf-8")
            claude.write_text("# Claude Notes\n", encoding="utf-8")

            result = openwiki_support.ensure_agent_reference(repo, apply=True)

            self.assertEqual(
                result,
                {"AGENTS.md": "updated", "CLAUDE.md": "updated"},
            )
            self.assertIn(
                openwiki_support.OPENWIKI_SECTION,
                agents.read_text(encoding="utf-8"),
            )
            self.assertIn(
                openwiki_support.OPENWIKI_SECTION,
                claude.read_text(encoding="utf-8"),
            )
            self.assertEqual(
                openwiki_support.ensure_agent_reference(repo, apply=True),
                {"AGENTS.md": "unchanged", "CLAUDE.md": "unchanged"},
            )

    def test_agent_reference_apply_creates_agents_when_no_files_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)

            dry_run = openwiki_support.ensure_agent_reference(repo)
            self.assertEqual(dry_run, {"AGENTS.md": "would_create"})
            self.assertFalse((repo / "AGENTS.md").exists())

            result = openwiki_support.ensure_agent_reference(repo, apply=True)

            self.assertEqual(result, {"AGENTS.md": "created"})
            self.assertEqual(
                (repo / "AGENTS.md").read_text(encoding="utf-8"),
                openwiki_support.OPENWIKI_SECTION,
            )

    def test_agent_reference_cli_requires_apply_to_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            repo = Path(temporary_directory)
            agents = repo / "AGENTS.md"
            agents.write_text("# Existing\n", encoding="utf-8")

            dry_run = self._run_support(
                "agent-reference",
                "--repo",
                str(repo),
            )
            self.assertEqual(dry_run, {"AGENTS.md": "would_update"})
            self.assertEqual(agents.read_text(encoding="utf-8"), "# Existing\n")

            applied = self._run_support(
                "agent-reference",
                "--repo",
                str(repo),
                "--apply",
            )
            self.assertEqual(applied, {"AGENTS.md": "updated"})
            self.assertIn(
                openwiki_support.OPENWIKI_SECTION,
                agents.read_text(encoding="utf-8"),
            )

    def _init_git_repo(self, repo: Path) -> None:
        self._git(repo, "init")
        self._git(repo, "config", "user.email", "test@example.com")
        self._git(repo, "config", "user.name", "OpenWiki Test")
        (repo / "README.md").write_text("# Test\n", encoding="utf-8")
        self._git(repo, "add", "README.md")
        self._git(repo, "commit", "-m", "initial")

    def _git(self, repo: Path, *args: str) -> str:
        completed = subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return completed.stdout.strip()

    def _run_support(self, *args: str) -> object:
        completed = subprocess.run(
            [sys.executable, str(MODULE_PATH), *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
