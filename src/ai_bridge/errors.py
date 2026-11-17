"""Stable, machine-readable error taxonomy (FR-06 / F-06-11, Wave 3B).

Every error surface in AI Bridge — MCP tool errors (``server.py``) and
control-plane HTTP errors (``control/mcp_routes.py``) — reports one of
these codes instead of raw exception text, so clients can branch on
``code`` without parsing human-readable messages.

Rules:
- ``code`` is stable across releases; only add codes, never rename one.
- ``http_status`` is the HTTP status a control-plane endpoint returns
  for the code; MCP tool errors carry the code as a ``[CODE]`` prefix
  on the exception message (the MCP protocol has no HTTP status).
- ``message`` is the default human-readable text; callers may supply a
  more specific message, but must keep the code.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """Machine-readable error codes. The value is the wire string."""

    AUTH_REQUIRED = "AUTH_REQUIRED"
    POLICY_DENIED = "POLICY_DENIED"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    TENANT_FORBIDDEN = "TENANT_FORBIDDEN"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND"
    APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND"
    NOT_FOUND = "NOT_FOUND"
    STALE_EPOCH = "STALE_EPOCH"
    RATE_LIMITED = "RATE_LIMITED"
    UPSTREAM_UNAVAILABLE = "UPSTREAM_UNAVAILABLE"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


@dataclass(frozen=True)
class ErrorInfo:
    """HTTP status + default message for one :class:`ErrorCode`."""

    code: ErrorCode
    http_status: int
    message: str


ERROR_CATALOG: dict[ErrorCode, ErrorInfo] = {
    ErrorCode.AUTH_REQUIRED: ErrorInfo(ErrorCode.AUTH_REQUIRED, 401, "Authentication is required."),
    ErrorCode.POLICY_DENIED: ErrorInfo(ErrorCode.POLICY_DENIED, 403, "Operation denied by policy."),
    ErrorCode.APPROVAL_REQUIRED: ErrorInfo(
        ErrorCode.APPROVAL_REQUIRED, 403, "Human approval is required before this operation can run."
    ),
    ErrorCode.TENANT_FORBIDDEN: ErrorInfo(
        ErrorCode.TENANT_FORBIDDEN, 403, "The requested resource belongs to a different tenant."
    ),
    ErrorCode.TASK_NOT_FOUND: ErrorInfo(ErrorCode.TASK_NOT_FOUND, 404, "Task not found."),
    ErrorCode.DEVICE_NOT_FOUND: ErrorInfo(ErrorCode.DEVICE_NOT_FOUND, 404, "Device not found."),
    ErrorCode.APPROVAL_NOT_FOUND: ErrorInfo(ErrorCode.APPROVAL_NOT_FOUND, 404, "Approval not found."),
    ErrorCode.NOT_FOUND: ErrorInfo(ErrorCode.NOT_FOUND, 404, "The requested resource was not found."),
    ErrorCode.STALE_EPOCH: ErrorInfo(
        ErrorCode.STALE_EPOCH, 409, "The request is stale; the resource has changed."
    ),
    ErrorCode.RATE_LIMITED: ErrorInfo(ErrorCode.RATE_LIMITED, 429, "Rate limit exceeded; retry later."),
    ErrorCode.UPSTREAM_UNAVAILABLE: ErrorInfo(
        ErrorCode.UPSTREAM_UNAVAILABLE, 502, "An upstream service is unavailable."
    ),
    ErrorCode.VALIDATION_FAILED: ErrorInfo(
        ErrorCode.VALIDATION_FAILED, 400, "The request failed validation."
    ),
    ErrorCode.INTERNAL_ERROR: ErrorInfo(ErrorCode.INTERNAL_ERROR, 500, "An internal error occurred."),
}


def error_info(code: ErrorCode | str) -> ErrorInfo:
    """Look up the catalog entry for ``code`` (unknown codes map to INTERNAL_ERROR)."""
    try:
        parsed = code if isinstance(code, ErrorCode) else ErrorCode(str(code))
    except ValueError:
        return ERROR_CATALOG[ErrorCode.INTERNAL_ERROR]
    return ERROR_CATALOG.get(parsed, ERROR_CATALOG[ErrorCode.INTERNAL_ERROR])


def error_detail(code: ErrorCode | str, message: str | None = None, details: Any = None) -> str:
    """``"[CODE] message"`` string for HTTPException ``detail`` / exception text.

    ``details`` (when given) is appended as a compact suffix so the code
    stays machine-parseable at the start of the string.
    """
    info = error_info(code)
    text = (message or info.message).strip() or info.message
    if details is not None:
        text = f"{text} | details={details!r}" if not isinstance(details, dict) else f"{text} | {details}"
    return f"[{info.code.value}] {text}"


def error_response(code: ErrorCode | str, message: str | None = None, details: Any = None) -> dict[str, Any]:
    """Structured error body: ``{"code", "message", "details"}``."""
    info = error_info(code)
    return {
        "code": info.code.value,
        "message": (message or info.message).strip() or info.message,
        "details": details,
    }


class BridgeError(Exception):
    """Exception carrying a taxonomy code.

    MCP tool code keeps raising the builtin exception types callers
    already catch (``PermissionError`` / ``ValueError``) with the code
    prefixed onto the message; use this class where a structured error
    body is produced (HTTP handlers, :func:`error_response`).
    """

    def __init__(
        self,
        code: ErrorCode | str,
        message: str | None = None,
        details: Any = None,
    ) -> None:
        self.code = code if isinstance(code, ErrorCode) else ErrorCode(str(code))
        info = ERROR_CATALOG[self.code]
        self.message = (message or info.message).strip() or info.message
        self.details = details
        self.http_status = info.http_status
        super().__init__(error_detail(self.code, self.message, details))

    def to_dict(self) -> dict[str, Any]:
        """``{"code": ..., "message": ..., "details": ...}``."""
        return {"code": self.code.value, "message": self.message, "details": self.details}


def code_of_message(text: str) -> ErrorCode | None:
    """Extract a leading ``[CODE]`` prefix from an error string, if present."""
    if not isinstance(text, str) or not text.startswith("["):
        return None
    end = text.find("]")
    if end <= 1:
        return None
    try:
        return ErrorCode(text[1:end])
    except ValueError:
        return None
