"""DeepSWE-compatible feedback handling for Harbor's LangSmith plugin."""

from __future__ import annotations

import math
import warnings
from typing import Any

from harbor_langsmith import LangSmithPlugin
from requests import RequestException


class DeepSWELangSmithPlugin(LangSmithPlugin):
    """Send only bounded DeepSWE rewards accepted by LangSmith."""

    def _post_feedback(self, payload: dict[str, Any]) -> None:
        """Publish feedback without allowing telemetry failures to abort a trial."""
        try:
            self._request(
                "POST", "/feedback", json=payload, ok_statuses={200, 201, 409}
            )
        except RequestException as exc:
            response = exc.response
            status = response.status_code if response is not None else "unavailable"
            request_id = "unavailable"
            if response is not None:
                request_id = response.headers.get(
                    "x-request-id", response.headers.get("x-langsmith-trace", "unavailable")
                )
            warnings.warn(
                "LangSmith feedback publish failed and was skipped: "
                f"error={type(exc).__name__}, status={status}, "
                f"request_id={request_id}",
                RuntimeWarning,
                stacklevel=2,
            )

    def _create_feedback(self, run_id: str, result: Any) -> None:
        if result.verifier_result is not None:
            for key, value in (result.verifier_result.rewards or {}).items():
                payload: dict[str, Any] = {
                    "id": self._stable_uuid(run_id, "feedback", key),
                    "run_id": run_id,
                    "key": key,
                    "feedback_source_type": "api",
                }
                is_number = isinstance(value, (int, float)) and not isinstance(
                    value, bool
                )
                if is_number and math.isfinite(float(value)) and -1 <= value <= 1:
                    # LangSmith rejects feedback scores with more than four decimal
                    # places. DeepSWE's partial reward uses full float precision.
                    payload["score"] = round(float(value), 4)
                else:
                    continue
                self._post_feedback(payload)

        if result.exception_info is not None:
            self._post_feedback(
                {
                    "id": self._stable_uuid(run_id, "feedback", "harbor_error"),
                    "run_id": run_id,
                    "key": "harbor_error",
                    "score": 1,
                    "value": result.exception_info.exception_type,
                    "comment": result.exception_info.exception_message,
                    "feedback_source_type": "api",
                }
            )
