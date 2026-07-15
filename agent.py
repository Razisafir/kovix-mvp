"""
KOVIX :: Agent Layer (multi-provider)
======================================
Three strict system prompts aligned to PAUL (PLAN / APPLY / HEAL), callable
against any provider in providers.py. Provider-specific request shaping:

  - openai-compatible  -> POST {base}/chat/completions, Bearer auth
  - anthropic          -> POST {base}/messages, x-api-key + anthropic-version
  - gemini             -> POST {base}/models/{model}:generateContent?key=KEY

Strict JSON output is enforced; a deterministic offline fallback is used when
no provider/key is configured so the loop is fully runnable end-to-end.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

import httpx

import providers
from providers import Provider

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

DEFAULT_PROVIDER_ID: str = os.environ.get("KOVIX_DEFAULT_PROVIDER", "zai")
DEFAULT_TIMEOUT_S: float = float(os.environ.get("KOVIX_TIMEOUT_S", "90"))


@dataclass
class LLMConfig:
    """Immutable runtime config for a single loop run."""
    provider_id: str
    api_key: Optional[str]
    model: Optional[str]

    @property
    def provider(self) -> Provider:
        return providers.get_provider(self.provider_id)

    @property
    def resolved_key(self) -> Optional[str]:
        return providers.resolve_api_key(self.provider, self.api_key)

    @property
    def resolved_model(self) -> str:
        return self.model or self.provider.default_model

    @property
    def is_offline(self) -> bool:
        # Ollama is local and never needs a key.
        if self.provider_id == "ollama":
            return False
        return self.resolved_key is None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "provider_name": self.provider.name,
            "model": self.resolved_model,
            "offline": self.is_offline,
        }


# --------------------------------------------------------------------------- #
# Typed result containers (unchanged shape from v1)
# --------------------------------------------------------------------------- #

@dataclass
class BDDCriterion:
    given: str
    when: str
    then: str

    def to_dict(self) -> Dict[str, str]:
        return {"given": self.given, "when": self.when, "then": self.then}


@dataclass
class Milestone:
    id: str
    name: str
    spec: str
    filename: str
    language: Literal["python", "javascript", "bash", "text"]
    bdd: List[BDDCriterion] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "spec": self.spec,
            "filename": self.filename,
            "language": self.language,
            "bdd": [c.to_dict() for c in self.bdd],
        }


@dataclass
class Plan:
    goal: str
    milestones: List[Milestone]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "goal": self.goal,
            "milestones": [m.to_dict() for m in self.milestones],
        }


@dataclass
class CodeArtifact:
    filename: str
    language: str
    code: str
    entrypoint: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filename": self.filename,
            "language": self.language,
            "code": self.code,
            "entrypoint": self.entrypoint,
        }


FailureClass = Literal["INTENT", "SPEC", "CODE"]


@dataclass
class DiagnosticReport:
    classification: FailureClass
    reasoning: str
    should_retry: bool = False
    patched_code: str = ""
    patched_filename: str = ""
    patched_entrypoint: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "classification": self.classification,
            "reasoning": self.reasoning,
            "should_retry": self.should_retry,
            "patched_code": self.patched_code,
            "patched_filename": self.patched_filename,
            "patched_entrypoint": self.patched_entrypoint,
        }


# --------------------------------------------------------------------------- #
# System prompts (strict JSON output)
# --------------------------------------------------------------------------- #

PLAN_PROMPT: str = """You are KOVIX's PLAN agent. Given a user's abstract idea ("vibe"), produce a strict execution plan.

Output STRICT JSON only -- no prose, no markdown fences. Schema:
{
  "goal": "string -- refined, concrete goal",
  "milestones": [
    {
      "id": "M1",
      "name": "short name",
      "spec": "what to build or do",
      "filename": "output filename inside workspace, e.g. 'hello.py'",
      "language": "python|javascript|bash|text",
      "bdd": [
        {"given": "...", "when": "...", "then": "..."}
      ]
    }
  ]
}

Rules:
- Produce 1 to 5 milestones, each independently executable.
- BDD criteria must be observable and testable. The "then" clause should use one of these patterns when possible: "exit code is 0", "stdout contains 'X'", "stdout is non-empty", "stderr is empty", "stdout matches /regex/".
- Each milestone produces exactly one output file.
- Filenames must be valid on Windows (no path separators, no reserved names).
- The final milestone must produce a runnable script that demonstrates the goal.

If the previous plan failed with classification SPEC, you will receive a "previous_failure" field. Regenerate the plan to address that diagnosis.
"""

APPLY_PROMPT: str = """You are KOVIX's APPLY agent. Given a milestone spec, write production-ready code.

Output STRICT JSON only -- no prose, no markdown fences. Schema:
{
  "filename": "must match the milestone filename",
  "language": "must match the milestone language",
  "code": "the complete file contents as a string",
  "entrypoint": "how to execute, e.g. 'python hello.py' or 'node app.js'"
}

Rules:
- Code must be complete and runnable on Windows.
- No placeholders, no TODOs, no 'pass' stubs.
- Match every BDD criterion in the milestone.
- Do not add shebangs on Windows scripts.
"""

HEAL_PROMPT: str = """You are KOVIX's DIAGNOSTIC agent. A previous execution failed.

Perform root-cause classification using PAUL's Diagnostic Failure Routing:

- INTENT  : The goal itself is wrong or ambiguous. Do NOT patch -- flag for human review.
- SPEC    : The plan / BDD does not match the goal. Do NOT patch -- flag for plan regeneration.
- CODE    : The plan is correct but the code execution failed. Produce a minimal patch.

Output STRICT JSON only -- no prose, no markdown fences. Schema:
{
  "classification": "INTENT|SPEC|CODE",
  "reasoning": "string explaining the diagnosis",
  "should_retry": true|false,
  "patched_code": "if should_retry, full patched file contents; else empty string",
  "patched_filename": "filename if patched_code is non-empty; else empty string",
  "patched_entrypoint": "how to execute the patched code; else empty string"
}

Rules:
- For INTENT issues set should_retry=false and patched_code="".
- For SPEC issues set should_retry=false and patched_code="".
- For CODE issues set should_retry=true and provide the full patched file (not a diff).
"""


# --------------------------------------------------------------------------- #
# Low-level LLM call (provider-aware)
# --------------------------------------------------------------------------- #

def _call_llm(cfg: LLMConfig, system_prompt: str, user_prompt: str) -> str:
    """Call the configured provider and return raw assistant text.

    Falls back to a deterministic offline producer when no key is set
    (except for Ollama, which is local).
    """
    if cfg.is_offline:
        return _offline_fallback(system_prompt, user_prompt)

    if cfg.provider.chat_format == "openai":
        return _call_openai_compatible(cfg, system_prompt, user_prompt)
    if cfg.provider.chat_format == "anthropic":
        return _call_anthropic(cfg, system_prompt, user_prompt)
    if cfg.provider.chat_format == "gemini":
        return _call_gemini(cfg, system_prompt, user_prompt)
    raise RuntimeError(f"Unknown chat_format: {cfg.provider.chat_format}")


def _call_openai_compatible(
    cfg: LLMConfig, system_prompt: str, user_prompt: str
) -> str:
    url: str = f"{cfg.provider.base_url}/chat/completions"
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.resolved_key}",
    }
    headers.update(cfg.provider.extra_headers)
    payload: Dict[str, Any] = {
        "model": cfg.resolved_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    with httpx.Client(timeout=DEFAULT_TIMEOUT_S) as client:
        resp: httpx.Response = client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"{cfg.provider.name} API error {resp.status_code}: "
                f"{resp.text[:500]}"
            )
        data: Dict[str, Any] = resp.json()
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as exc:
            raise RuntimeError(f"Malformed {cfg.provider.name} response: {data}") from exc


def _call_anthropic(
    cfg: LLMConfig, system_prompt: str, user_prompt: str
) -> str:
    url: str = f"{cfg.provider.base_url}/messages"
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "x-api-key": cfg.resolved_key or "",
    }
    headers.update(cfg.provider.extra_headers)
    payload: Dict[str, Any] = {
        "model": cfg.resolved_model,
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }
    with httpx.Client(timeout=DEFAULT_TIMEOUT_S) as client:
        resp: httpx.Response = client.post(url, headers=headers, json=payload)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Anthropic API error {resp.status_code}: {resp.text[:500]}"
            )
        data: Dict[str, Any] = resp.json()
        # Anthropic returns content as a list of blocks.
        try:
            content = data.get("content", [])
            parts: List[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
            return "".join(parts)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Malformed Anthropic response: {data}") from exc


def _call_gemini(
    cfg: LLMConfig, system_prompt: str, user_prompt: str
) -> str:
    url: str = (
        f"{cfg.provider.base_url}/models/{cfg.resolved_model}:generateContent"
    )
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    params: Dict[str, str] = {}
    if cfg.resolved_key:
        params[cfg.provider.query_param or "key"] = cfg.resolved_key
    payload: Dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {"role": "user", "parts": [{"text": user_prompt}]},
        ],
        "generationConfig": {"temperature": 0.2},
    }
    with httpx.Client(timeout=DEFAULT_TIMEOUT_S) as client:
        resp: httpx.Response = client.post(
            url, headers=headers, params=params, json=payload
        )
        if resp.status_code >= 400:
            raise RuntimeError(
                f"Gemini API error {resp.status_code}: {resp.text[:500]}"
            )
        data: Dict[str, Any] = resp.json()
        try:
            candidates = data.get("candidates", [])
            if not candidates:
                raise RuntimeError(f"Gemini returned no candidates: {data}")
            parts_out = candidates[0].get("content", {}).get("parts", [])
            return "".join(str(p.get("text", "")) for p in parts_out)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Malformed Gemini response: {data}") from exc


# --------------------------------------------------------------------------- #
# JSON parsing (lenient)
# --------------------------------------------------------------------------- #

def _parse_json_lenient(raw: str) -> Dict[str, Any]:
    text: str = raw.strip()
    if text.startswith("```"):
        parts: List[str] = text.split("```")
        if len(parts) >= 3:
            text = parts[1]
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    if not (text.startswith("{") and text.endswith("}")):
        first: int = text.find("{")
        last: int = text.rfind("}")
        if first != -1 and last != -1 and last > first:
            text = text[first : last + 1]
    return json.loads(text)


# --------------------------------------------------------------------------- #
# Offline fallback (deterministic; same shape as v1)
# --------------------------------------------------------------------------- #

def _offline_fallback(system_prompt: str, user_prompt: str) -> str:
    if "PLAN agent" in system_prompt:
        # Try to extract the vibe from the JSON user prompt.
        vibe_text: str = user_prompt
        try:
            parsed = json.loads(user_prompt)
            vibe_text = str(parsed.get("vibe", user_prompt))
        except Exception:  # noqa: BLE001
            pass
        # If a previous SPEC failure is present, prepend a regen marker.
        regen_marker: str = ""
        try:
            parsed = json.loads(user_prompt)
            if parsed.get("previous_failure"):
                regen_marker = "[REGEN] "
        except Exception:  # noqa: BLE001
            pass
        return json.dumps({
            "goal": f"{regen_marker}Build a working Python CLI that satisfies: "
                    f"{vibe_text[:120]}",
            "milestones": [
                {
                    "id": "M1",
                    "name": "skeleton_script",
                    "spec": "A Python CLI script that prints a friendly greeting and exits 0.",
                    "filename": "main_demo.py",
                    "language": "python",
                    "bdd": [
                        {
                            "given": "the workspace contains main_demo.py",
                            "when": "python main_demo.py is executed",
                            "then": "exit code is 0 and stdout is non-empty",
                        }
                    ],
                }
            ],
        })
    if "APPLY agent" in system_prompt:
        # Deliberate NameError to force a HEAL iteration.
        return json.dumps({
            "filename": "main_demo.py",
            "language": "python",
            "code": (
                "def main() -> int:\n"
                "    print(GREETING)\n"
                "    return 0\n\n"
                "if __name__ == '__main__':\n"
                "    raise SystemExit(main())\n"
            ),
            "entrypoint": "python main_demo.py",
        })
    if "DIAGNOSTIC agent" in system_prompt:
        return json.dumps({
            "classification": "CODE",
            "reasoning": "NameError on GREETING indicates an undefined identifier; "
                         "the plan is sound, only the code is defective.",
            "should_retry": True,
            "patched_code": (
                "def main() -> int:\n"
                "    print('KOVIX autonomous execution online.')\n"
                "    return 0\n\n"
                "if __name__ == '__main__':\n"
                "    raise SystemExit(main())\n"
            ),
            "patched_filename": "main_demo.py",
            "patched_entrypoint": "python main_demo.py",
        })
    return "{}"


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def generate_plan(vibe: str, cfg: LLMConfig, previous_failure: Optional[str] = None) -> Plan:
    """PLAN phase -- refine the vibe into a strict, BDD-anchored plan."""
    user_prompt: str = json.dumps(
        {
            "vibe": vibe,
            "previous_failure": previous_failure,
        },
        ensure_ascii=False,
        indent=2,
    )
    raw: str = _call_llm(cfg, PLAN_PROMPT, user_prompt)
    data: Dict[str, Any] = _parse_json_lenient(raw)

    milestones: List[Milestone] = []
    for m in data.get("milestones", []):
        bdd: List[BDDCriterion] = [
            BDDCriterion(
                given=str(b.get("given", "")),
                when=str(b.get("when", "")),
                then=str(b.get("then", "")),
            )
            for b in m.get("bdd", [])
        ]
        lang_str: str = str(m.get("language", "python")).lower()
        if lang_str not in ("python", "javascript", "bash", "text"):
            lang_str = "python"
        milestones.append(
            Milestone(
                id=str(m.get("id", f"M{len(milestones) + 1}")),
                name=str(m.get("name", "unnamed")),
                spec=str(m.get("spec", "")),
                filename=str(m.get("filename", f"out_{len(milestones)}.py")),
                language=lang_str,  # type: ignore[arg-type]
                bdd=bdd,
            )
        )
    return Plan(goal=str(data.get("goal", vibe)), milestones=milestones)


def write_code(milestone: Milestone, cfg: LLMConfig, context: str = "") -> CodeArtifact:
    """APPLY phase -- write the code artifact for a single milestone."""
    user_prompt: str = json.dumps(
        {
            "milestone": milestone.to_dict(),
            "project_context": context,
        },
        ensure_ascii=False,
        indent=2,
    )
    raw: str = _call_llm(cfg, APPLY_PROMPT, user_prompt)
    data: Dict[str, Any] = _parse_json_lenient(raw)
    return CodeArtifact(
        filename=str(data.get("filename", milestone.filename)),
        language=str(data.get("language", milestone.language)),
        code=str(data.get("code", "")),
        entrypoint=str(data.get("entrypoint", f"python {milestone.filename}")),
    )


def heal_code(
    broken_code: str,
    error_traceback: str,
    cfg: LLMConfig,
    milestone: Optional[Milestone] = None,
) -> DiagnosticReport:
    """Diagnostic Failure Routing -- classify the failure and patch if CODE-level."""
    user_prompt: str = json.dumps(
        {
            "milestone": milestone.to_dict() if milestone else {},
            "broken_code": broken_code,
            "error_traceback": error_traceback,
        },
        ensure_ascii=False,
        indent=2,
    )
    raw: str = _call_llm(cfg, HEAL_PROMPT, user_prompt)
    data: Dict[str, Any] = _parse_json_lenient(raw)
    cls_raw: str = str(data.get("classification", "CODE")).upper()
    if cls_raw not in ("INTENT", "SPEC", "CODE"):
        cls_raw = "CODE"
    return DiagnosticReport(
        classification=cls_raw,  # type: ignore[arg-type]
        reasoning=str(data.get("reasoning", "")),
        should_retry=bool(data.get("should_retry", False)),
        patched_code=str(data.get("patched_code", "")),
        patched_filename=str(data.get("patched_filename", "")),
        patched_entrypoint=str(data.get("patched_entrypoint", "")),
    )


def is_offline_mode(cfg: LLMConfig) -> bool:
    return cfg.is_offline
