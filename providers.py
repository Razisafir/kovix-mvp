"""
KOVIX :: Provider Registry
============================
Single source of truth for every LLM provider KOVIX can talk to.

Each Provider knows:
  - its OpenAI-compatible (or native) chat-completions endpoint
  - its model-listing endpoint + auth scheme
  - the env var that holds its API key (so /api/models can fall back to it)
  - its default model

Adding a new provider = add one entry to PROVIDERS below. No other code change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

import httpx

# --------------------------------------------------------------------------- #
# Types
# --------------------------------------------------------------------------- #

AuthScheme = Literal["bearer", "x-api-key", "query"]
ChatFormat = Literal["openai", "anthropic", "gemini"]


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    base_url: str                  # chat completions base (OpenAI-style, no /chat/completions)
    models_url: str                # full URL for listing models
    auth_scheme: AuthScheme
    chat_format: ChatFormat        # how to shape the request body
    env_var: str                   # env var to consult if no key passed
    default_model: str
    docs_url: str
    extra_headers: Dict[str, str] = field(default_factory=dict)
    query_param: Optional[str] = None  # for Gemini-style ?key=KEY
    needs_key_for_models: bool = True


# --------------------------------------------------------------------------- #
# Provider catalogue
# --------------------------------------------------------------------------- #

PROVIDERS: Dict[str, Provider] = {
    "zai": Provider(
        id="zai",
        name="Z.ai (GLM)",
        base_url="https://api.z.ai/api/paas/v4",
        models_url="https://api.z.ai/api/paas/v4/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="ZAI_API_KEY",
        default_model="glm-4.5",
        docs_url="https://docs.z.ai/",
    ),
    "openai": Provider(
        id="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        models_url="https://api.openai.com/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="OPENAI_API_KEY",
        default_model="gpt-4o-mini",
        docs_url="https://platform.openai.com/docs",
    ),
    "anthropic": Provider(
        id="anthropic",
        name="Anthropic (Claude)",
        base_url="https://api.anthropic.com/v1",
        models_url="https://api.anthropic.com/v1/models?limit=100",
        auth_scheme="x-api-key",
        chat_format="anthropic",
        env_var="ANTHROPIC_API_KEY",
        default_model="claude-3-5-sonnet-latest",
        docs_url="https://docs.anthropic.com/",
        extra_headers={
            "anthropic-version": "2023-06-01",
        },
    ),
    "gemini": Provider(
        id="gemini",
        name="Google Gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        models_url="https://generativelanguage.googleapis.com/v1beta/models",
        auth_scheme="query",
        chat_format="gemini",
        env_var="GEMINI_API_KEY",
        default_model="gemini-1.5-flash",
        docs_url="https://ai.google.dev/gemini-api/docs",
        query_param="key",
    ),
    "openrouter": Provider(
        id="openrouter",
        name="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        models_url="https://openrouter.ai/api/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="OPENROUTER_API_KEY",
        default_model="openai/gpt-4o-mini",
        docs_url="https://openrouter.ai/docs",
        needs_key_for_models=False,  # public catalog
    ),
    "groq": Provider(
        id="groq",
        name="Groq",
        base_url="https://api.groq.com/openai/v1",
        models_url="https://api.groq.com/openai/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="GROQ_API_KEY",
        default_model="llama-3.3-70b-versatile",
        docs_url="https://console.groq.com/docs",
    ),
    "together": Provider(
        id="together",
        name="Together AI",
        base_url="https://api.together.xyz/v1",
        models_url="https://api.together.xyz/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="TOGETHER_API_KEY",
        default_model="meta-llama/Llama-3.3-70B-Instruct-Turbo",
        docs_url="https://docs.together.ai/",
    ),
    "fireworks": Provider(
        id="fireworks",
        name="Fireworks AI",
        base_url="https://api.fireworks.ai/inference/v1",
        models_url="https://api.fireworks.ai/inference/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="FIREWORKS_API_KEY",
        default_model="accounts/fireworks/models/llama-v3p3-70b-instruct",
        docs_url="https://docs.fireworks.ai/",
    ),
    "deepseek": Provider(
        id="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        models_url="https://api.deepseek.com/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="DEEPSEEK_API_KEY",
        default_model="deepseek-chat",
        docs_url="https://api-docs.deepseek.com/",
    ),
    "mistral": Provider(
        id="mistral",
        name="Mistral AI",
        base_url="https://api.mistral.ai/v1",
        models_url="https://api.mistral.ai/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="MISTRAL_API_KEY",
        default_model="mistral-small-latest",
        docs_url="https://docs.mistral.ai/",
    ),
    "perplexity": Provider(
        id="perplexity",
        name="Perplexity",
        base_url="https://api.perplexity.ai",
        models_url="https://api.perplexity.ai/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="PERPLEXITY_API_KEY",
        default_model="sonar",
        docs_url="https://docs.perplexity.ai/",
    ),
    "xai": Provider(
        id="xai",
        name="xAI (Grok)",
        base_url="https://api.x.ai/v1",
        models_url="https://api.x.ai/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="XAI_API_KEY",
        default_model="grok-2-latest",
        docs_url="https://docs.x.ai/",
    ),
    "cohere": Provider(
        id="cohere",
        name="Cohere",
        base_url="https://api.cohere.com/v2",
        models_url="https://api.cohere.com/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="COHERE_API_KEY",
        default_model="command-r-plus",
        docs_url="https://docs.cohere.com/",
    ),
    "ollama": Provider(
        id="ollama",
        name="Ollama (local)",
        base_url="http://127.0.0.1:11434/v1",
        models_url="http://127.0.0.1:11434/v1/models",
        auth_scheme="bearer",
        chat_format="openai",
        env_var="OLLAMA_API_KEY",
        default_model="llama3.2",
        docs_url="https://ollama.com/",
        needs_key_for_models=False,
    ),
}


# --------------------------------------------------------------------------- #
# Public helpers
# --------------------------------------------------------------------------- #

def list_providers() -> List[Dict[str, str]]:
    """Return provider metadata for the frontend dropdown."""
    return [
        {
            "id": p.id,
            "name": p.name,
            "env_var": p.env_var,
            "default_model": p.default_model,
            "docs_url": p.docs_url,
            "needs_key_for_models": p.needs_for_models_str(),
        }
        for p in PROVIDERS.values()
    ]


def get_provider(provider_id: str) -> Provider:
    if provider_id not in PROVIDERS:
        raise KeyError(f"Unknown provider: {provider_id!r}")
    return PROVIDERS[provider_id]


def resolve_api_key(provider: Provider, explicit_key: Optional[str]) -> Optional[str]:
    """Return explicit key if given, else env var, else None."""
    import os
    if explicit_key and explicit_key.strip():
        return explicit_key.strip()
    return os.environ.get(provider.env_var)


def _provider_add_header(provider: Provider) -> str:
    return "yes" if provider.needs_key_for_models else "no"


# Patch the dataclass with a small helper (kept outside for clarity).
Provider.needs_for_models_str = lambda self: "yes" if self.needs_key_for_models else "no"  # type: ignore[attr-defined]


def fetch_models(provider: Provider, api_key: Optional[str]) -> List[str]:
    """Hit the provider's /models endpoint and return a sorted list of model IDs.

    Raises RuntimeError with a human-readable message on failure.
    """
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    params: Dict[str, str] = {}
    url: str = provider.models_url

    if provider.auth_scheme == "bearer":
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
    elif provider.auth_scheme == "x-api-key":
        if api_key:
            headers["x-api-key"] = api_key
    elif provider.auth_scheme == "query":
        if api_key and provider.query_param:
            params[provider.query_param] = api_key

    headers.update(provider.extra_headers)

    try:
        with httpx.Client(timeout=15.0) as client:
            resp: httpx.Response = client.get(url, headers=headers, params=params)
    except httpx.RequestError as exc:
        raise RuntimeError(f"Network error talking to {provider.name}: {exc}") from exc

    if resp.status_code == 401:
        raise RuntimeError(f"Unauthorized (401). The API key for {provider.name} is invalid or missing.")
    if resp.status_code == 403:
        raise RuntimeError(f"Forbidden (403). The API key for {provider.name} lacks permission to list models.")
    if resp.status_code >= 400:
        snippet: str = resp.text[:300]
        raise RuntimeError(f"{provider.name} returned HTTP {resp.status_code}: {snippet}")

    try:
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"{provider.name} returned non-JSON: {resp.text[:200]}") from exc

    # Normalize across providers.
    raw_models: List[str] = []
    if isinstance(data, dict):
        # OpenAI-style: {"data": [{"id": "..."}, ...]}
        for item in data.get("data", []) or []:
            if isinstance(item, dict) and "id" in item:
                raw_models.append(str(item["id"]))
            elif isinstance(item, str):
                raw_models.append(item)
        # Gemini-style: {"models": [{"name": "models/gemini-1.5-pro"}, ...]}
        for item in data.get("models", []) or []:
            if isinstance(item, dict):
                name = item.get("name") or item.get("id") or item.get("display_name")
                if name:
                    raw_models.append(str(name))
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                name = item.get("id") or item.get("name")
                if name:
                    raw_models.append(str(name))
            elif isinstance(item, str):
                raw_models.append(item)

    # Strip "models/" prefix from Gemini names for cleaner display.
    cleaned: List[str] = []
    for m in raw_models:
        if m.startswith("models/"):
            m = m[len("models/"):]
        cleaned.append(m)

    # De-dup, sort, drop empties.
    seen = set()
    final: List[str] = []
    for m in cleaned:
        if m and m not in seen:
            seen.add(m)
            final.append(m)
    final.sort()
    return final
