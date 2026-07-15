"""Smoke test for KOVIX v2: exercises multi-provider catalog, offline fallback
loop, strict BDD evaluator, SPEC retry path, and SQLite persistence."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import agent  # noqa: E402
import bdd    # noqa: E402
import db     # noqa: E402
import loop   # noqa: E402
import providers  # noqa: E402

WORKSPACE = ROOT / "workspace"


def test_provider_catalog() -> None:
    print("\n[1] Provider catalog")
    catalog = providers.list_providers()
    assert len(catalog) >= 13, f"expected >=13 providers, got {len(catalog)}"
    ids = {p["id"] for p in catalog}
    for expected in {"zai", "openai", "anthropic", "gemini", "openrouter",
                     "groq", "together", "fireworks", "deepseek", "mistral",
                     "perplexity", "xai", "cohere"}:
        assert expected in ids, f"missing provider: {expected}"
    print(f"    OK -- {len(catalog)} providers registered")


def test_bdd_evaluator() -> None:
    print("\n[2] BDD evaluator")
    import executor as ex_mod
    success = ex_mod.ExecutionResult(
        returncode=0, stdout="Hello KOVIX\n", stderr="",
        command="python x.py", cwd=".", duration_s=0.1
    )
    fail = ex_mod.ExecutionResult(
        returncode=1, stdout="", stderr="NameError: GREETING",
        command="python x.py", cwd=".", duration_s=0.1
    )

    # Pass case: exit code is 0 AND stdout is non-empty AND stdout contains 'Hello'
    ev = bdd.evaluate_criterion(
        given="workspace contains x.py",
        when="python x.py is executed",
        then="exit code is 0 and stdout is non-empty and stdout contains 'Hello'",
        result=success,
    )
    assert ev.passed, f"should pass: {ev.assertions}"
    assert not ev.fallback_used
    print(f"    OK -- pass-case: {sum(1 for a in ev.assertions if a.passed)}/{len(ev.assertions)} assertions")

    # Fail case: same criteria but against failed execution
    ev2 = bdd.evaluate_criterion(
        given="workspace contains x.py",
        when="python x.py is executed",
        then="exit code is 0 and stdout is non-empty",
        result=fail,
    )
    assert not ev2.passed, "should fail"
    print(f"    OK -- fail-case: {sum(1 for a in ev2.assertions if a.passed)}/{len(ev2.assertions)} assertions")

    # Regex case
    ev3 = bdd.evaluate_criterion(
        given="x", when="y",
        then="stdout matches /Hello/",
        result=success,
    )
    assert ev3.passed, f"regex should match: {ev3.assertions}"
    print(f"    OK -- regex-case: passed={ev3.passed}")

    # Fallback case: no recognizable pattern
    ev4 = bdd.evaluate_criterion(
        given="x", when="y",
        then="the world is at peace",
        result=success,
    )
    assert ev4.fallback_used
    print("    OK -- fallback-case: fallback_used=True")


def test_offline_loop_and_persistence() -> None:
    print("\n[3] Offline loop (PLAN -> APPLY -> HEAL -> UNIFY) + SQLite")
    # Remove any old DB
    if db.DEFAULT_DB_PATH.exists():
        db.DEFAULT_DB_PATH.unlink()

    cfg = agent.LLMConfig(provider_id="zai", api_key=None, model=None)
    assert cfg.is_offline, "expected offline mode when no key set"
    print(f"    offline_mode={cfg.is_offline}, provider={cfg.provider.name}, "
          f"model={cfg.resolved_model}")

    events: list[dict] = []
    def on_event(ev: dict) -> None:
        events.append(ev)
        print(f"      [{ev['phase']:5s}] {ev['status']:7s} | {ev['message']}")

    report = loop.run_loop(
        vibe="A CLI that prints 'hello world' and exits 0.",
        workspace_dir=WORKSPACE,
        cfg=cfg,
        on_event=on_event,
    )

    # Assertions on the report
    assert report["verdict"] == "SUCCESS", f"expected SUCCESS, got {report['verdict']}"
    assert report["passed"] == 1
    assert report["failed"] == 0
    assert report["spec_retries"] == 0

    # All four phases should have fired
    phases = {e["phase"] for e in events}
    for p in ("PLAN", "APPLY", "HEAL", "UNIFY"):
        assert p in phases, f"phase {p} missing"

    # The BDD criterion should NOT have used fallback (offline fallback emits
    # "exit code is 0 and stdout is non-empty" which the evaluator parses).
    detail = report["details"][0]
    assert not detail["criteria"][0].get("fallback_used"), \
        "fallback_used should be False since the criterion uses recognized patterns"

    # SQLite persistence
    runs = db.list_runs(limit=10)
    assert len(runs) >= 1, "no runs in db"
    last = runs[0]
    assert last["verdict"] == "SUCCESS"
    assert last["passed"] == 1
    assert last["provider"] == "zai"
    assert last["model"] == "glm-4.5"

    detail_db = db.get_run_detail(last["id"])
    assert detail_db is not None
    assert len(detail_db["events"]) == len(events), \
        f"db events {len(detail_db['events'])} != live events {len(events)}"
    assert len(detail_db["milestones"]) == 1
    assert len(detail_db["healing_events"]) >= 2  # pending + CODE attempt

    print(f"    OK -- verdict={report['verdict']}, run_id={report['run_id']}, "
          f"db_events={len(detail_db['events'])}, "
          f"db_healing={len(detail_db['healing_events'])}")


def test_spec_retry_path() -> None:
    """Force a SPEC classification by monkey-patching agent.heal_code,
    then verify the loop regenerates the plan and eventually succeeds."""
    print("\n[4] SPEC retry path")
    if db.DEFAULT_DB_PATH.exists():
        # Keep db; we just want to add a new run.
        pass

    cfg = agent.LLMConfig(provider_id="zai", api_key=None, model=None)
    call_count = {"heal": 0, "plan": 0}

    real_heal = agent.heal_code
    real_plan = agent.generate_plan

    def fake_heal(broken_code, error_traceback, cfg, milestone=None):
        call_count["heal"] += 1
        if call_count["heal"] == 1:
            # First call: SPEC.
            return agent.DiagnosticReport(
                classification="SPEC",
                reasoning="BDD criterion does not match the goal.",
                should_retry=False,
            )
        # Subsequent calls: CODE patch.
        return real_heal(broken_code, error_traceback, cfg, milestone)

    def fake_plan(vibe, cfg, previous_failure=None):
        call_count["plan"] += 1
        return real_plan(vibe, cfg, previous_failure)

    agent.heal_code = fake_heal
    agent.generate_plan = fake_plan

    try:
        events: list[dict] = []
        report = loop.run_loop(
            vibe="force SPEC retry",
            workspace_dir=WORKSPACE,
            cfg=cfg,
            on_event=lambda ev: events.append(ev),
        )
    finally:
        agent.heal_code = real_heal
        agent.generate_plan = fake_plan

    # generate_plan should have been called twice (initial + 1 SPEC retry)
    assert call_count["plan"] >= 2, f"expected >=2 plan calls, got {call_count['plan']}"
    assert report["spec_retries"] >= 1, \
        f"expected spec_retries>=1, got {report['spec_retries']}"
    # After retry the patched code should still succeed
    assert report["verdict"] == "SUCCESS", \
        f"expected SUCCESS after retry, got {report['verdict']}"

    # Verify SPEC retry was persisted
    runs = db.list_runs(limit=5)
    last = runs[0]
    assert last["spec_retries"] >= 1, "spec_retries not persisted"
    print(f"    OK -- plan_calls={call_count['plan']}, "
          f"heal_calls={call_count['heal']}, "
          f"spec_retries={report['spec_retries']}, "
          f"verdict={report['verdict']}")


def main() -> int:
    test_provider_catalog()
    test_bdd_evaluator()
    test_offline_loop_and_persistence()
    test_spec_retry_path()
    print("\nALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
