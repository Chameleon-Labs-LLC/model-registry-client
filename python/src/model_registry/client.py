"""ChameleonLabs model-registry client.

Resolves current LLM model IDs from a published registry JSON (schema v2) so projects
never hardcode model IDs that go stale. Stdlib only — this file can be vendored into any
project as-is.

Default registry: the public ChameleonLabs registry, refreshed daily. Point it at your
own registry with the MODEL_REGISTRY_URL env var or the ``url=`` argument.

Error posture: fetch failure -> serve in-memory cache (even expired) -> serve bundled
fallback file (if configured) -> raise RegistryError. With a fallback configured the
client never raises, so model pickers always work.

Typical usage::

    from model_registry import resolve, context_window

    model_id = resolve("anthropic", "opus")            # -> "claude-opus-4-8"
    stable   = resolve("openai", "gpt", channel="stable")
    window   = context_window(model_id)                # -> 200000 or None
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from typing import Any, Callable, Optional

DEFAULT_URL = "https://chameleonlabs-model-registry.s3.us-east-1.amazonaws.com/models/latest.json"
DEFAULT_TTL_SECONDS = 3600.0
FETCH_TIMEOUT_SECONDS = 5.0
MIN_SCHEMA_VERSION = 2

Fetch = Callable[[str, float], str]
Clock = Callable[[], float]


class RegistryError(RuntimeError):
    """Raised when the registry cannot be fetched and no fallback is available."""


def _default_fetch(url: str, timeout: float) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (https URL)
        if resp.status != 200:
            raise RegistryError(f"registry HTTP {resp.status}")
        return resp.read().decode("utf-8")


def _is_valid(reg: Any) -> bool:
    return (
        isinstance(reg, dict)
        and isinstance(reg.get("schema_version"), int)
        and reg["schema_version"] >= MIN_SCHEMA_VERSION
        and isinstance(reg.get("families"), dict)
    )


# Cache is keyed by URL so tests / multi-registry processes don't cross-contaminate.
_cache: dict[str, tuple[dict, float]] = {}


def clear_cache() -> None:
    """Drop the in-memory cache (test seam)."""
    _cache.clear()


def get_registry(
    *,
    url: Optional[str] = None,
    fallback_path: Optional[str] = None,
    ttl_seconds: float = DEFAULT_TTL_SECONDS,
    _fetch: Optional[Fetch] = None,
    _clock: Optional[Clock] = None,
) -> dict:
    """Return the parsed registry dict, fetching at most once per ``ttl_seconds``.

    ``fallback_path`` names a snapshotted latest.json bundled with the consuming
    project; when set, this function never raises.
    """
    resolved_url = url or os.environ.get("MODEL_REGISTRY_URL") or DEFAULT_URL
    fetch = _fetch or _default_fetch
    clock = _clock or time.time

    cached = _cache.get(resolved_url)
    if cached is not None and clock() - cached[1] < ttl_seconds:
        return cached[0]

    try:
        raw = fetch(resolved_url, FETCH_TIMEOUT_SECONDS)
        reg = json.loads(raw)
        if not _is_valid(reg):
            raise RegistryError("registry schema invalid (need schema_version >= 2 with families)")
        _cache[resolved_url] = (reg, clock())
        return reg
    except Exception as err:  # noqa: BLE001 — availability beats freshness here
        print(f"model-registry fetch failed ({err}); using cache/fallback", file=sys.stderr)
        if cached is not None:
            return cached[0]
        if fallback_path:
            with open(fallback_path, encoding="utf-8") as fh:
                return json.load(fh)
        raise RegistryError(f"registry unavailable and no fallback configured: {err}") from err


def resolve(
    provider: str,
    family: str,
    channel: str = "active",
    **kwargs: Any,
) -> str:
    """Resolve (provider, family) to the current model ID.

    ``channel`` may be "active" (default), "stable", or "preview"; non-active channels
    read families_detail and fall back to the active ID when the channel is absent.
    Extra kwargs are passed to :func:`get_registry`.
    """
    reg = get_registry(**kwargs)
    families = reg.get("families", {}).get(provider)
    if not families or family not in families:
        known = sorted(families) if families else sorted(reg.get("families", {}))
        raise LookupError(f"no family {provider}/{family} in registry (known: {known})")
    if channel != "active":
        detail = reg.get("families_detail", {}).get(provider, {}).get(family, {})
        if detail.get(channel):
            return detail[channel]
    return families[family]


def context_window(model_id: str, **kwargs: Any) -> Optional[int]:
    """Return the model's context window in tokens, or None if unknown."""
    reg = get_registry(**kwargs)
    return reg.get("capabilities", {}).get(model_id, {}).get("context_window")


def available(provider: str, **kwargs: Any) -> list[str]:
    """Return the full curated model-ID list for a provider (empty if unknown)."""
    reg = get_registry(**kwargs)
    return list(reg.get("available", {}).get(provider, []))
