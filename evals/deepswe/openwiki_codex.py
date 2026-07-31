"""Harbor Codex adapters for paired DeepSWE/OpenWiki evaluations."""

from __future__ import annotations

import json
import hashlib
import os
import re
import shlex
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor_langsmith import parent_env


_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$")
_GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_APP_DIR = PurePosixPath("/app")
_OPENWIKI_SOURCE_DIR = PurePosixPath("/tmp/openwiki-source")
_OPENWIKI_HOME_DIR = PurePosixPath("/tmp/openwiki-home")
_REMOTE_PACKAGE_PATH = PurePosixPath("/tmp/openwiki-eval.tgz")
_REMOTE_WIKI_CACHE_PATH = PurePosixPath("/tmp/openwiki-wiki-cache.tgz")
_OPENWIKI_LOG_PATH = PurePosixPath("/logs/agent/openwiki.log")
_WIKI_CACHE_SCHEMA = "openwiki-eval-wiki-v1"
_MAX_CACHE_MEMBERS = 20_000
_MAX_CACHE_UNCOMPRESSED_BYTES = 1_073_741_824
_MAX_CACHE_METADATA_BYTES = 65_536


def _normalized_package_digest(package_path: Path) -> str:
    """Hash package contents without unstable tar ownership or timestamps."""

    digest = hashlib.sha256()
    seen: set[str] = set()
    with tarfile.open(package_path, mode="r:*") as archive:
        members = sorted(archive.getmembers(), key=lambda member: member.name)
        if len(members) > _MAX_CACHE_MEMBERS:
            raise ValueError("OpenWiki package contains too many archive members")
        total_size = 0
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or member.name in seen:
                raise ValueError("OpenWiki package contains an unsafe archive path")
            seen.add(member.name)
            total_size += member.size
            if total_size > _MAX_CACHE_UNCOMPRESSED_BYTES:
                raise ValueError("OpenWiki package is too large to hash safely")
            digest.update(member.name.encode("utf-8", errors="surrogateescape"))
            digest.update(b"\0")
            digest.update(member.type)
            digest.update(b"\0")
            digest.update(str(member.mode & 0o777).encode("ascii"))
            digest.update(b"\0")
            if member.isfile():
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise ValueError("OpenWiki package member could not be read")
                for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                    digest.update(chunk)
            elif member.issym() or member.islnk():
                digest.update(member.linkname.encode("utf-8", errors="surrogateescape"))
            elif not member.isdir():
                raise ValueError("OpenWiki package contains an unsupported member type")
            digest.update(b"\0")
    return digest.hexdigest()


def _wiki_cache_key(base_commit: str, package_digest: str, model: str) -> str:
    if not _GIT_COMMIT_RE.fullmatch(base_commit):
        raise ValueError("invalid base commit for OpenWiki cache")
    payload = json.dumps(
        {
            "schema": _WIKI_CACHE_SCHEMA,
            "base_commit": base_commit,
            "package_digest": package_digest,
            "model": model,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_wiki_cache_archive(archive_path: Path) -> dict[str, str] | None:
    """Reject archives that could write anywhere except openwiki/."""

    seen: set[str] = set()
    quickstart_found = False
    metadata_bytes: bytes | None = None
    total_size = 0
    with tarfile.open(archive_path, mode="r:*") as archive:
        members = archive.getmembers()
        if not members or len(members) > _MAX_CACHE_MEMBERS:
            raise ValueError("OpenWiki cache has an invalid member count")
        for member in members:
            path = PurePosixPath(member.name)
            normalized = path.as_posix().rstrip("/")
            if (
                path.is_absolute()
                or not path.parts
                or path.parts[0] != "openwiki"
                or ".." in path.parts
                or normalized in {"", "."}
                or normalized in seen
            ):
                raise ValueError("OpenWiki cache contains an unsafe archive path")
            seen.add(normalized)
            if not (member.isfile() or member.isdir()):
                raise ValueError("OpenWiki cache may contain only files and directories")
            total_size += member.size
            if total_size > _MAX_CACHE_UNCOMPRESSED_BYTES:
                raise ValueError("OpenWiki cache is too large to restore safely")
            if normalized == "openwiki/quickstart.md" and member.isfile():
                quickstart_found = True
            if normalized == "openwiki/.last-update.json" and member.isfile():
                if member.size > _MAX_CACHE_METADATA_BYTES:
                    raise ValueError("OpenWiki cache has invalid update metadata")
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise ValueError("OpenWiki cache update metadata could not be read")
                metadata_bytes = extracted.read(_MAX_CACHE_METADATA_BYTES + 1)
    if not quickstart_found:
        raise ValueError("OpenWiki cache is missing openwiki/quickstart.md")
    if metadata_bytes is None:
        return None
    try:
        value = json.loads(metadata_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("OpenWiki cache update metadata is invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("OpenWiki cache update metadata must be an object")
    git_head = value.get("gitHead")
    model = value.get("model")
    if not isinstance(git_head, str) or not _GIT_COMMIT_RE.fullmatch(git_head):
        raise ValueError("OpenWiki cache update metadata has an invalid gitHead")
    if not isinstance(model, str) or not _MODEL_ID_RE.fullmatch(model):
        raise ValueError("OpenWiki cache update metadata has an invalid model")
    return {"gitHead": git_head, "model": model}


def _find_wiki_cache(
    cache_dir: Path,
    exact_path: Path,
    *,
    base_commit: str,
    model: str,
    reuse_compatible: bool,
) -> tuple[Path | None, str | None]:
    """Find an exact-key cache, or a metadata-compatible older package cache."""

    candidates = [exact_path]
    if reuse_compatible:
        candidates.extend(
            path for path in sorted(cache_dir.glob("*.tgz")) if path != exact_path
        )
    for index, candidate in enumerate(candidates):
        if not candidate.is_file():
            continue
        metadata = _validate_wiki_cache_archive(candidate)
        if metadata == {"gitHead": base_commit, "model": model}:
            return candidate, "exact" if index == 0 else "compatible"
    return None, None


def _bool_option(value: bool | str, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if value == "true":
        return True
    if value == "false":
        return False
    raise ValueError(f"{name} must be true or false")


class BaselineCodex(Codex):
    """Codex with credential-safe Harbor command logging for the control arm."""

    _PATCH_PATHSPEC = ""

    @staticmethod
    def name() -> str:
        return "codex-baseline"

    async def install(self, environment: BaseEnvironment) -> None:
        """Install pinned Codex without Harbor's unnecessary NVM bootstrap."""

        if await self._installed_codex_satisfies_version(environment):
            return
        if self._version is None or not re.fullmatch(r"\d+\.\d+\.\d+", self._version):
            raise ValueError("a pinned semantic Codex version is required")
        await self.exec_as_root(
            environment,
            command=(
                "if command -v rg >/dev/null 2>&1; then :; "
                "elif command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache ripgrep; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "for source in /etc/apt/sources.list.d/*nodesource*; do "
                "[ ! -f \"$source\" ] || mv \"$source\" \"$source.disabled\"; done; "
                "apt-get update && apt-get install -y ripgrep; "
                "elif command -v yum >/dev/null 2>&1; then "
                "yum install -y ripgrep; "
                "else echo 'No supported package manager for ripgrep' >&2; exit 1; fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        package = shlex.quote(f"@openai/codex@{self._version}")
        await self.exec_as_agent(
            environment,
            command=(
                f"npm install -g {package} --ignore-scripts --no-audit --no-fund && "
                "codex --version"
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run Codex and capture committed work for DeepSWE's verifier.

        DeepSWE v1.1 normally relies on Pier's ``pre_artifacts.sh`` lifecycle.
        Harbor 0.20 does not execute that hook, so the adapter performs the same
        base-to-final-HEAD patch capture after the agent exits.
        """

        head_result = await self.exec_as_agent(
            environment,
            command="git rev-parse HEAD",
            cwd=_APP_DIR.as_posix(),
        )
        start_head = (head_result.stdout or "").strip()
        if not _GIT_COMMIT_RE.fullmatch(start_head):
            raise RuntimeError("Task repository returned an invalid starting commit")
        await self.exec_as_agent(
            environment,
            command=(
                "git config user.name 'DeepSWE Eval' && "
                "git config user.email 'deepswe-eval@local.invalid'"
            ),
            cwd=_APP_DIR.as_posix(),
        )
        try:
            await super().run(instruction, environment, context)
        finally:
            patch_path = PurePosixPath("/logs/artifacts/model.patch")
            await self.exec_as_agent(
                environment,
                command=(
                    "umask 077; mkdir -p /logs/artifacts && "
                    f"git diff --binary {shlex.quote(start_head)} HEAD"
                    f"{self._PATCH_PATHSPEC} > "
                    f"{shlex.quote(patch_path.as_posix())} && "
                    f"chmod 0600 {shlex.quote(patch_path.as_posix())}"
                ),
                cwd=_APP_DIR.as_posix(),
            )

    async def _exec(
        self,
        environment: BaseEnvironment,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ) -> Any:
        """Execute without logging environment values or command output.

        Harbor's upstream helper includes the per-command environment in debug log
        metadata. Eval jobs necessarily pass provider credentials, so this
        adapter deliberately keeps environment values out of logs.
        """

        result = await environment.exec(
            command=f"set -o pipefail; {command}",
            user=user,
            env=env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )
        if result.return_code != 0:
            raise RuntimeError(
                f"Sandbox command failed with exit code {result.return_code}; "
                "inspect the trial logs for non-sensitive diagnostics."
            )
        return result


class OpenWikiCodex(BaselineCodex):
    """Generate OpenWiki in an isolated clone before running the same Codex agent."""

    _PATCH_PATHSPEC = " -- . ':(exclude)AGENTS.md' ':(exclude)openwiki/**'"

    def __init__(
        self,
        *args: Any,
        openwiki_package: str,
        openwiki_model: str,
        openwiki_cache_dir: str,
        openwiki_timeout_sec: int = 5400,
        retrieval_embedding_provider: str = "local",
        reuse_compatible_wiki_cache: bool | str = True,
        require_openwiki_cache: bool | str = False,
        **kwargs: Any,
    ) -> None:
        package_path = Path(openwiki_package).expanduser().resolve()
        if package_path.suffix != ".tgz" or not package_path.is_file():
            raise ValueError("openwiki_package must be an existing .tgz file")
        if not _MODEL_ID_RE.fullmatch(openwiki_model):
            raise ValueError("openwiki_model contains unsupported characters")
        if openwiki_timeout_sec <= 0 or openwiki_timeout_sec > 14_400:
            raise ValueError("openwiki_timeout_sec must be between 1 and 14400")
        if retrieval_embedding_provider not in {"local", "openai"}:
            raise ValueError("retrieval_embedding_provider must be local or openai")
        cache_dir = Path(openwiki_cache_dir).expanduser().resolve()
        cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not cache_dir.is_dir():
            raise ValueError("openwiki_cache_dir must be a directory")

        self._openwiki_package = package_path
        self._openwiki_package_digest = _normalized_package_digest(package_path)
        self._openwiki_model = openwiki_model
        self._openwiki_cache_dir = cache_dir
        self._openwiki_timeout_sec = openwiki_timeout_sec
        self._retrieval_embedding_provider = retrieval_embedding_provider
        self._reuse_compatible_wiki_cache = _bool_option(
            reuse_compatible_wiki_cache, "reuse_compatible_wiki_cache"
        )
        self._require_openwiki_cache = _bool_option(
            require_openwiki_cache, "require_openwiki_cache"
        )
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "codex-openwiki"

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.upload_file(
            self._openwiki_package, _REMOTE_PACKAGE_PATH.as_posix()
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 0644 {shlex.quote(_REMOTE_PACKAGE_PATH.as_posix())}",
        )
        await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                f"npm install -g {shlex.quote(_REMOTE_PACKAGE_PATH.as_posix())} "
                "--ignore-scripts --no-audit --no-fund && "
                'cd "$(npm root -g)/openwiki" && '
                "npm rebuild better-sqlite3 --foreground-scripts "
                "--no-audit --no-fund && "
                "node -e \"require('better-sqlite3')\" && "
                "command -v openwiki >/dev/null"
            ),
        )
        openwiki_bin_result = await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; command -v openwiki"
            ),
        )
        openwiki_bin_lines = [
            line.strip()
            for line in (openwiki_bin_result.stdout or "").splitlines()
            if line.strip()
        ]
        openwiki_bin = openwiki_bin_lines[-1] if openwiki_bin_lines else ""
        if not re.fullmatch(r"/[A-Za-z0-9._/@+-]+", openwiki_bin):
            raise RuntimeError("OpenWiki installation returned an invalid binary path")
        await self.exec_as_root(
            environment,
            command=(f"ln -sf {shlex.quote(openwiki_bin)} /usr/local/bin/openwiki"),
        )
        retrieval_bin_result = await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                "command -v openwiki-retrieval-mcp || true"
            ),
        )
        retrieval_bin_lines = [
            line.strip()
            for line in (retrieval_bin_result.stdout or "").splitlines()
            if line.strip()
        ]
        retrieval_bin = retrieval_bin_lines[-1] if retrieval_bin_lines else ""
        if not retrieval_bin:
            return
        if not re.fullmatch(r"/[A-Za-z0-9._/@+-]+", retrieval_bin):
            raise RuntimeError("OpenWiki retrieval installation returned an invalid path")
        await self.exec_as_root(
            environment,
            command=(
                f"ln -sf {shlex.quote(retrieval_bin)} "
                "/usr/local/bin/openwiki-retrieval-mcp"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "codex mcp add openwiki_retrieval -- "
                "/usr/local/bin/openwiki-retrieval-mcp "
                f"--repo-root {_APP_DIR.as_posix()} "
                f"--wiki-root {(_APP_DIR / 'openwiki').as_posix()} "
                "--embedding-provider "
                f"{shlex.quote(self._retrieval_embedding_provider)}"
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        started = time.monotonic()
        status = "failure"
        cache_hit = False
        cache_match: str | None = None
        cache_key: str | None = None
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"mkdir -p {shlex.quote(_OPENWIKI_HOME_DIR.as_posix())} && "
                    f"git clone --quiet --no-hardlinks "
                    f"{shlex.quote(_APP_DIR.as_posix())} "
                    f"{shlex.quote(_OPENWIKI_SOURCE_DIR.as_posix())}"
                ),
                timeout_sec=600,
            )

            head_result = await self.exec_as_agent(
                environment,
                command="git rev-parse HEAD",
                cwd=_OPENWIKI_SOURCE_DIR.as_posix(),
            )
            base_commit = (head_result.stdout or "").strip()
            cache_key = _wiki_cache_key(
                base_commit, self._openwiki_package_digest, self._openwiki_model
            )
            cache_path = (self._openwiki_cache_dir / f"{cache_key}.tgz").resolve()
            if cache_path.parent != self._openwiki_cache_dir:
                raise RuntimeError("OpenWiki cache path escaped its configured directory")

            selected_cache, cache_match = _find_wiki_cache(
                self._openwiki_cache_dir,
                cache_path,
                base_commit=base_commit,
                model=self._openwiki_model,
                reuse_compatible=self._reuse_compatible_wiki_cache,
            )
            if selected_cache is not None:
                await environment.upload_file(
                    selected_cache, _REMOTE_WIKI_CACHE_PATH.as_posix()
                )
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"tar -xzf {shlex.quote(_REMOTE_WIKI_CACHE_PATH.as_posix())} "
                        f"-C {shlex.quote(_OPENWIKI_SOURCE_DIR.as_posix())} && "
                        f"test -f {shlex.quote((_OPENWIKI_SOURCE_DIR / 'openwiki' / 'quickstart.md').as_posix())} && "
                        f"test ! -L {shlex.quote((_OPENWIKI_SOURCE_DIR / 'openwiki' / 'quickstart.md').as_posix())}"
                    ),
                    timeout_sec=600,
                )
                cache_hit = True
            else:
                if self._require_openwiki_cache:
                    raise RuntimeError(
                        "No compatible OpenWiki cache exists for the task commit "
                        "and model; generation is disabled"
                    )
                trace_env = parent_env(self.context_id)
                wiki_env = {
                    "HOME": _OPENWIKI_HOME_DIR.as_posix(),
                    "OPENAI_API_KEY": self._get_env("OPENAI_API_KEY") or "",
                    "LANGSMITH_API_KEY": self._get_env("LANGSMITH_API_KEY") or "",
                    "LANGCHAIN_TRACING_V2": "true",
                    "OPENWIKI_PROVIDER": "openai",
                    "OPENWIKI_MODEL_ID": self._openwiki_model,
                    "OPENWIKI_TELEMETRY_DISABLED": "1",
                    "DO_NOT_TRACK": "1",
                    **trace_env,
                }
                if project := trace_env.get("LANGSMITH_PROJECT"):
                    wiki_env["LANGCHAIN_PROJECT"] = project
                for key in ("LANGSMITH_ENDPOINT", "LANGSMITH_WORKSPACE_ID"):
                    if value := self._get_env(key):
                        wiki_env[key] = value
                if openai_base_url := self._get_env("OPENAI_BASE_URL"):
                    wiki_env["OPENAI_BASE_URL"] = openai_base_url
                await self.exec_as_agent(
                    environment,
                    command=(
                        "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                        "openwiki code --init --print "
                        f"> {shlex.quote(_OPENWIKI_LOG_PATH.as_posix())} 2>&1"
                    ),
                    env=wiki_env,
                    cwd=_OPENWIKI_SOURCE_DIR.as_posix(),
                    timeout_sec=self._openwiki_timeout_sec,
                )
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"test -f {shlex.quote((_OPENWIKI_SOURCE_DIR / 'openwiki' / 'quickstart.md').as_posix())} && "
                        f"tar -czf {shlex.quote(_REMOTE_WIKI_CACHE_PATH.as_posix())} "
                        f"-C {shlex.quote(_OPENWIKI_SOURCE_DIR.as_posix())} openwiki"
                    ),
                    timeout_sec=600,
                )
                temp_handle = tempfile.NamedTemporaryFile(
                    prefix=f".{cache_key}.",
                    suffix=".tmp",
                    dir=self._openwiki_cache_dir,
                    delete=False,
                )
                temp_path = Path(temp_handle.name)
                temp_handle.close()
                try:
                    await environment.download_file(
                        _REMOTE_WIKI_CACHE_PATH.as_posix(), temp_path
                    )
                    _validate_wiki_cache_archive(temp_path)
                    os.chmod(temp_path, 0o600)
                    os.replace(temp_path, cache_path)
                finally:
                    temp_path.unlink(missing_ok=True)

            await self.exec_as_agent(
                environment,
                command=(
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                    "node --input-type=module -e \"const root=process.argv[1]; "
                    "const repo=process.argv[2]; const module=await "
                    "import('file://' + root + '/openwiki/dist/code-mode.js'); "
                    "await module.ensureCodeModeRepoSetup(repo)\" "
                    '"$(npm root -g)" '
                    f"{shlex.quote(_OPENWIKI_SOURCE_DIR.as_posix())}"
                ),
                timeout_sec=600,
            )
            await self.exec_as_agent(
                environment,
                command=(
                    f"rm -rf {shlex.quote((_APP_DIR / 'openwiki').as_posix())} && "
                    f"cp -R {shlex.quote((_OPENWIKI_SOURCE_DIR / 'openwiki').as_posix())} "
                    f"{shlex.quote((_APP_DIR / 'openwiki').as_posix())} && "
                    f"cp {shlex.quote((_OPENWIKI_SOURCE_DIR / 'AGENTS.md').as_posix())} "
                    f"{shlex.quote((_APP_DIR / 'AGENTS.md').as_posix())} && "
                    "mkdir -p /logs/agent && "
                    f"cp {shlex.quote((_APP_DIR / 'AGENTS.md').as_posix())} "
                    "/logs/agent/openwiki-agents.md && "
                    "printf '\\n/AGENTS.md\\n/openwiki/\\n' >> .git/info/exclude && "
                    "git ls-files -z -- AGENTS.md openwiki | "
                    "git update-index --skip-worktree -z --stdin"
                ),
                cwd=_APP_DIR.as_posix(),
                timeout_sec=600,
            )
            status = "success"
        finally:
            elapsed = round(time.monotonic() - started, 3)
            openwiki_metadata = {
                "status": status,
                "duration_seconds": elapsed,
                "model": self._openwiki_model,
                "cache_hit": cache_hit,
                "cache_match": cache_match,
                "cache_key": cache_key,
                "quickstart": (
                    _OPENWIKI_SOURCE_DIR / "openwiki" / "quickstart.md"
                ).as_posix(),
            }
            context.metadata = {
                **(context.metadata or {}),
                "openwiki": openwiki_metadata,
            }
            (self.logs_dir / "openwiki.json").write_text(
                json.dumps(openwiki_metadata, indent=2) + "\n",
                encoding="utf-8",
            )

        await super().run(instruction, environment, context)
