"""
KOVIX :: BDD Assertion Interpreter
====================================
Per-criterion evaluator for PAUL's Acceptance-Driven Development.

Each BDD criterion's `then` clause is parsed for one or more assertions
written in plain English. Supported patterns (case-insensitive):

    exit code is N            -> result.returncode == N
    return code is N          -> result.returncode == N
    exit code is 0            -> result.success
    stdout contains "X"       -> X in result.stdout
    stdout contains 'X'       -> X in result.stdout
    stdout contains X         -> X in result.stdout (greedy up to ' and ' / '.')
    stdout does not contain X -> X not in result.stdout
    stdout matches /regex/    -> re.search(regex, result.stdout)
    stdout matches regex X    -> re.search(X, result.stdout)
    stdout is non-empty       -> bool(result.stdout.strip())
    stdout is empty           -> not result.stdout.strip()
    stderr contains "X"       -> X in result.stderr
    stderr is empty           -> not result.stderr.strip()
    execution succeeds        -> result.success
    execution fails           -> not result.success
    succeeds                  -> result.success

If multiple assertions are joined by ' and ', ALL must pass.
If no pattern matches, fall back to rc==0 + non-empty stdout.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

import executor


@dataclass
class AssertionResult:
    text: str
    passed: bool
    reason: str


@dataclass
class CriterionEvaluation:
    given: str
    when: str
    then: str
    passed: bool
    assertions: List[AssertionResult]
    fallback_used: bool


def _split_conjuncts(text: str) -> List[str]:
    """Split a clause on ' and ' (case-insensitive), preserving quoted spans."""
    parts: List[str] = re.split(r"\s+and\s+", text, flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


def _eval_single(assertion: str, result: executor.ExecutionResult) -> AssertionResult:
    """Evaluate a single assertion phrase against the execution result.

    Matching is case-insensitive (we lowercase `a` for keyword comparison),
    but we re-extract capture groups from the ORIGINAL assertion string so
    quoted substrings keep their original case.
    """
    orig: str = assertion.strip().rstrip(".")
    a: str = orig.lower()

    # --- exit / return code ------------------------------------------------ #
    m = re.search(r"(?:exit|return)\s+code\s+is\s+(\d+)", a)
    if m:
        expected: int = int(m.group(1))
        ok: bool = result.returncode == expected
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"expected rc={expected}, got rc={result.returncode}",
        )

    # --- stdout does not contain X ---------------------------------------- #
    m = re.search(r'stdout\s+does\s+not\s+contain\s+["\'](.+?)["\']', orig, re.IGNORECASE)
    if m:
        needle: str = m.group(1)
        ok = needle not in result.stdout
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"'{needle}' should be ABSENT from stdout: "
                   f"{'absent' if ok else 'PRESENT'}",
        )
    m = re.search(r"stdout\s+does\s+not\s+contain\s+(.+)", orig, re.IGNORECASE)
    if m:
        needle = m.group(1).strip().rstrip(".")
        ok = needle not in result.stdout
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"'{needle}' should be ABSENT from stdout: "
                   f"{'absent' if ok else 'PRESENT'}",
        )

    # --- stdout contains "X" / 'X' ---------------------------------------- #
    m = re.search(r'stdout\s+contains\s+["\'](.+?)["\']', orig, re.IGNORECASE)
    if m:
        needle = m.group(1)
        ok = needle in result.stdout
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"looking for '{needle}' in stdout: "
                   f"{'found' if ok else 'MISSING'}",
        )

    # --- stdout matches /regex/ ------------------------------------------- #
    m = re.search(r"stdout\s+matches\s+/(.+)/", orig, re.IGNORECASE)
    if m:
        pattern = m.group(1)
        try:
            ok = re.search(pattern, result.stdout) is not None
            reason = f"regex /{pattern}/ on stdout: " + ("matched" if ok else "no match")
        except re.error as exc:
            ok = False
            reason = f"invalid regex /{pattern}/: {exc}"
        return AssertionResult(text=assertion, passed=ok, reason=reason)

    # --- stdout matches regex X ------------------------------------------- #
    m = re.search(r"stdout\s+matches\s+regex\s+(.+)", orig, re.IGNORECASE)
    if m:
        pattern = m.group(1).strip().rstrip(".")
        try:
            ok = re.search(pattern, result.stdout) is not None
            reason = f"regex '{pattern}' on stdout: " + ("matched" if ok else "no match")
        except re.error as exc:
            ok = False
            reason = f"invalid regex '{pattern}': {exc}"
        return AssertionResult(text=assertion, passed=ok, reason=reason)

    # --- stdout is non-empty / empty -------------------------------------- #
    if re.search(r"stdout\s+is\s+non[- ]?empty", a) or re.search(r"stdout\s+is\s+not\s+empty", a):
        ok = bool(result.stdout.strip())
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"stdout is non-empty: {ok} (len={len(result.stdout.strip())})",
        )
    if re.search(r"stdout\s+is\s+empty", a):
        ok = not result.stdout.strip()
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"stdout is empty: {ok}",
        )

    # --- stdout contains X (unquoted, greedy until ' and ' or '.') -------- #
    m = re.search(r"stdout\s+contains\s+(.+)", orig, re.IGNORECASE)
    if m:
        needle = m.group(1).strip().rstrip(".")
        ok = needle in result.stdout
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"looking for '{needle}' in stdout: "
                   f"{'found' if ok else 'MISSING'}",
        )

    # --- stderr contains "X" ---------------------------------------------- #
    m = re.search(r'stderr\s+contains\s+["\'](.+?)["\']', orig, re.IGNORECASE)
    if m:
        needle = m.group(1)
        ok = needle in result.stderr
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"looking for '{needle}' in stderr: "
                   f"{'found' if ok else 'MISSING'}",
        )
    m = re.search(r"stderr\s+contains\s+(.+)", orig, re.IGNORECASE)
    if m:
        needle = m.group(1).strip().rstrip(".")
        ok = needle in result.stderr
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"looking for '{needle}' in stderr: "
                   f"{'found' if ok else 'MISSING'}",
        )

    # --- stderr is empty -------------------------------------------------- #
    if re.search(r"stderr\s+is\s+empty", a):
        ok = not result.stderr.strip()
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"stderr is empty: {ok}",
        )

    # --- execution succeeds / fails --------------------------------------- #
    if a in ("execution succeeds", "succeeds", "succeeds with exit code 0"):
        ok = result.success
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"execution success: {ok} (rc={result.returncode})",
        )
    if a in ("execution fails", "fails", "fails with non-zero exit code"):
        ok = not result.success
        return AssertionResult(
            text=assertion, passed=ok,
            reason=f"execution failed: {ok} (rc={result.returncode})",
        )

    # --- fallback --------------------------------------------------------- #
    ok = result.success and bool(result.stdout.strip())
    return AssertionResult(
        text=assertion, passed=ok, reason=(
            "fallback (no pattern matched): rc==0 and non-empty stdout "
            f"-> rc={result.returncode}, stdout_len={len(result.stdout.strip())}"
        ),
    )


def evaluate_criterion(
    given: str,
    when: str,
    then: str,
    result: executor.ExecutionResult,
) -> CriterionEvaluation:
    """Evaluate a full BDD criterion against an execution result.

    The `then` clause may contain multiple assertions joined by ' and '.
    ALL assertions must pass for the criterion to pass.
    """
    conjuncts: List[str] = _split_conjuncts(then)
    if not conjuncts:
        conjuncts = [then]

    assertion_results: List[AssertionResult] = [
        _eval_single(c, result) for c in conjuncts
    ]
    all_pass: bool = all(ar.passed for ar in assertion_results)

    # Fallback flag: set when the only assertion is the synthetic fallback.
    fallback_used: bool = (
        len(assertion_results) == 1
        and "fallback" in assertion_results[0].reason
    )

    return CriterionEvaluation(
        given=given,
        when=when,
        then=then,
        passed=all_pass,
        assertions=assertion_results,
        fallback_used=fallback_used,
    )


def evaluate_milestone(
    milestone_bdd: List[Tuple[str, str, str]],
    result: executor.ExecutionResult,
) -> List[CriterionEvaluation]:
    """Evaluate all BDD criteria for a single milestone."""
    return [
        evaluate_criterion(given=g, when=w, then=t, result=result)
        for (g, w, t) in milestone_bdd
    ]
