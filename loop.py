"""
KOVIX :: PAUL Loop Engine (v2)
================================
The Plan-Apply-Unify state machine with:
  - Strict BDD evaluation (bdd.py)
  - SPEC-level retry (re-generate_plan with diagnostic reasoning, cap=2)
  - SQLite persistence (db.py)

Phase contract
--------------
PLAN   : refine vibe -> strict BDD plan                      (agent.generate_plan)
APPLY  : for each milestone, write code & execute            (agent.write_code + executor)
HEAL   : on failure, classify INTENT/SPEC/CODE, patch & retry (agent.heal_code)
         * SPEC classification triggers PLAN regeneration with reasoning
UNIFY  : reconcile executed reality against BDD acceptance    (bdd.evaluate_criterion)
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import agent
import bdd
import db
import executor

EventCallback = Callable[[Dict[str, Any]], None]
MAX_HEAL_ATTEMPTS: int = 3
MAX_SPEC_RETRIES: int = 2


# --------------------------------------------------------------------------- #
# Event helpers
# --------------------------------------------------------------------------- #

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _emit(
    cb: EventCallback,
    run_id: Optional[int],
    phase: str,
    message: str,
    status: str = "info",
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    """Send a structured event to the frontend AND persist to SQLite."""
    ev: Dict[str, Any] = {
        "phase": phase,
        "message": message,
        "status": status,
        "timestamp": _utc_now(),
    }
    if payload:
        ev["payload"] = payload
    cb(ev)
    if run_id is not None:
        try:
            db.insert_event(
                run_id=run_id,
                phase=phase,
                message=message,
                status=status,
                timestamp=ev["timestamp"],
                payload=payload,
            )
        except Exception as exc:  # noqa: BLE001
            # DB errors must never break the loop.
            print(f"[KOVIX][WARN] db.insert_event failed: {exc}")


# --------------------------------------------------------------------------- #
# STATE.md management (PAUL principle #1 -- Loop Integrity)
# --------------------------------------------------------------------------- #

def write_state(
    workspace_dir: Path,
    phase: str,
    vibe: str,
    goal: str,
    plan: Optional[agent.Plan],
    execution_log: List[Dict[str, Any]],
    healing_log: List[Dict[str, Any]],
    unify_report: Optional[Dict[str, Any]],
) -> None:
    """Rewrite STATE.md to reflect the current loop state."""
    if plan and plan.milestones:
        bdd_lines: List[str] = []
        for m in plan.milestones:
            for c in m.bdd:
                bdd_lines.append(
                    f"- **{m.id}** Given {c.given} When {c.when} Then {c.then}"
                )
        bdd_block: str = "\n".join(bdd_lines) if bdd_lines else "_(none)_"
    else:
        bdd_block = "_(pending)_"

    if plan:
        plan_block: str = "\n".join(
            f"- `{m.id}` -- {m.name} ({m.filename}, {m.language})"
            for m in plan.milestones
        ) or "_(no milestones)_"
    else:
        plan_block = "_(pending)_"

    exec_block: str = "\n".join(
        f"- [{e['phase']}] {e['message']} ({e['status']})" for e in execution_log
    ) or "_(pending)_"

    heal_block: str = "\n".join(
        f"- {h['milestone_id']}: {h['classification']} -> {h['action']}"
        for h in healing_log
    ) or "_(none)_"

    if unify_report:
        unify_lines: List[str] = [
            f"- **verdict**: {unify_report.get('verdict')}",
            f"- **passed**: {unify_report.get('passed')} / "
            f"{unify_report.get('total_milestones')}",
            f"- **drift**: {unify_report.get('planned_vs_executed_drift')}",
            f"- **spec_retries**: {unify_report.get('spec_retries', 0)}",
        ]
        unify_block: str = "\n".join(unify_lines)
    else:
        unify_block = "_(pending)_"

    content: str = f"""# KOVIX :: STATE.md

> Live state of the autonomous Plan-Apply-Unify loop.
> This file is overwritten by loop.py on every run.

## Current Phase
{phase}

## Original Vibe
{vibe}

## Refined Goal
{goal}

## Active Plan
{plan_block}

## Acceptance Criteria (BDD)
{bdd_block}

## Execution Log
{exec_block}

## Self-Healing History
{heal_block}

## Unify Report
{unify_block}

## Last Updated
{_utc_now()}
"""
    (workspace_dir / "STATE.md").write_text(content, encoding="utf-8")


# --------------------------------------------------------------------------- #
# Acceptance evaluation (UNIFY) -- strict, per-criterion
# --------------------------------------------------------------------------- #

def _evaluate_acceptance(
    milestone: agent.Milestone,
    result: executor.ExecutionResult,
) -> Dict[str, Any]:
    """Run every BDD criterion for this milestone through the assertion engine."""
    evals: List[bdd.CriterionEvaluation] = bdd.evaluate_milestone(
        milestone_bdd=[(c.given, c.when, c.then) for c in milestone.bdd],
        result=result,
    )
    criteria_dicts: List[Dict[str, Any]] = []
    all_pass: bool = True
    for ev in evals:
        criteria_dicts.append({
            "given": ev.given,
            "when": ev.when,
            "then": ev.then,
            "passed": ev.passed,
            "fallback_used": ev.fallback_used,
            "assertions": [
                {"text": a.text, "passed": a.passed, "reason": a.reason}
                for a in ev.assertions
            ],
        })
        if not ev.passed:
            all_pass = False
    return {
        "milestone_id": milestone.id,
        "milestone_name": milestone.name,
        "filename": milestone.filename,
        "returncode": result.returncode,
        "all_criteria_passed": all_pass,
        "criteria": criteria_dicts,
    }


# --------------------------------------------------------------------------- #
# Milestone execution (APPLY + HEAL for a single milestone)
# --------------------------------------------------------------------------- #

def _execute_milestone(
    cfg: agent.LLMConfig,
    run_id: int,
    milestone: agent.Milestone,
    workspace_dir: Path,
    goal: str,
    execution_log: List[Dict[str, Any]],
    healing_log: List[Dict[str, Any]],
    on_event: EventCallback,
    on_spec_signal: Callable[[agent.DiagnosticReport], bool],
) -> Dict[str, Any]:
    """Execute one milestone through APPLY + (HEAL | SPEC signal).

    Returns the final acceptance-evaluation dict for this milestone.

    `on_spec_signal` is called when HEAL returns SPEC; it returns True if
    the caller has chosen to regenerate the plan (and we should stop
    attempting this milestone), False to halt entirely.
    """
    def log(phase: str, message: str, status: str = "info",
            payload: Optional[Dict[str, Any]] = None) -> None:
        execution_log.append({
            "phase": phase, "message": message, "status": status,
        })
        _emit(on_event, run_id, phase, message, status, payload)

    log("APPLY", f"[{milestone.id}] writing code for '{milestone.name}' ...")
    artifact: agent.CodeArtifact = agent.write_code(milestone, cfg, context=goal)
    target: Path = workspace_dir / artifact.filename
    target.write_text(artifact.code, encoding="utf-8")
    log("APPLY",
        f"[{milestone.id}] wrote {artifact.filename} "
        f"({len(artifact.code)} bytes)",
        "info",
        {"filename": artifact.filename, "code": artifact.code})

    result: executor.ExecutionResult = executor.execute(
        artifact.entrypoint, workspace_dir, timeout_s=60.0
    )
    log("APPLY",
        f"[{milestone.id}] executed `{result.command}` "
        f"-> rc={result.returncode} in {result.duration_s:.2f}s",
        "success" if result.success else "error",
        {"result": result.to_dict()})

    attempts: int = 0
    current_code: str = artifact.code
    current_entrypoint: str = artifact.entrypoint
    current_filename: str = artifact.filename
    spec_signaled: bool = False

    while not result.success and attempts < MAX_HEAL_ATTEMPTS:
        attempts += 1
        log("HEAL",
            f"[{milestone.id}] diagnostic attempt "
            f"{attempts}/{MAX_HEAL_ATTEMPTS} ...", "warn")

        report: agent.DiagnosticReport = agent.heal_code(
            broken_code=current_code,
            error_traceback=result.stderr,
            cfg=cfg,
            milestone=milestone,
        )
        log("HEAL",
            f"[{milestone.id}] classification = {report.classification}",
            "error" if report.classification in ("INTENT", "SPEC") else "warn",
            {"report": report.to_dict()})
        try:
            db.insert_healing_event(
                run_id=run_id,
                milestone_id=milestone.id,
                attempt=attempts,
                classification=report.classification,
                reasoning=report.reasoning,
                action="pending",
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[KOVIX][WARN] db.insert_healing_event failed: {exc}")

        # --------------------------------------------------------------- #
        # INTENT  -> halt for human review
        # --------------------------------------------------------------- #
        if report.classification == "INTENT":
            healing_log.append({
                "milestone_id": milestone.id,
                "classification": "INTENT",
                "action": "human review required",
            })
            log("HEAL",
                f"[{milestone.id}] INTENT issue -> halting for human review.",
                "error")
            try:
                db.insert_healing_event(
                    run_id=run_id, milestone_id=milestone.id,
                    attempt=attempts, classification="INTENT",
                    reasoning=report.reasoning,
                    action="human review required",
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[KOVIX][WARN] db.insert_healing_event(INTENT) failed: {exc}")
            break

        # --------------------------------------------------------------- #
        # SPEC -> signal caller to regenerate the plan
        # --------------------------------------------------------------- #
        if report.classification == "SPEC":
            should_continue: bool = on_spec_signal(report)
            healing_log.append({
                "milestone_id": milestone.id,
                "classification": "SPEC",
                "action": "plan regeneration requested",
            })
            try:
                db.insert_healing_event(
                    run_id=run_id, milestone_id=milestone.id,
                    attempt=attempts, classification="SPEC",
                    reasoning=report.reasoning,
                    action="plan regeneration requested",
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[KOVIX][WARN] db.insert_healing_event(SPEC) failed: {exc}")
            if should_continue:
                spec_signaled = True
                log("HEAL",
                    f"[{milestone.id}] SPEC -> triggering plan regeneration.",
                    "warn")
            else:
                log("HEAL",
                    f"[{milestone.id}] SPEC retry cap exceeded. Halting.",
                    "error")
            break

        # --------------------------------------------------------------- #
        # CODE -> apply patch & retry
        # --------------------------------------------------------------- #
        if not report.should_retry:
            healing_log.append({
                "milestone_id": milestone.id,
                "classification": "CODE",
                "action": "no patch produced (should_retry=false)",
            })
            log("HEAL",
                f"[{milestone.id}] CODE issue but no patch produced. Halting.",
                "error")
            break

        if report.patched_code:
            current_code = report.patched_code
            current_filename = report.patched_filename or current_filename
            current_entrypoint = report.patched_entrypoint or current_entrypoint
            (workspace_dir / current_filename).write_text(
                current_code, encoding="utf-8"
            )
            log("HEAL",
                f"[{milestone.id}] patched {current_filename}, re-executing ...",
                "warn")

        result = executor.execute(
            current_entrypoint, workspace_dir, timeout_s=60.0
        )
        log("HEAL",
            f"[{milestone.id}] re-executed `{result.command}` "
            f"-> rc={result.returncode} in {result.duration_s:.2f}s",
            "success" if result.success else "error",
            {"result": result.to_dict()})
        healing_log.append({
            "milestone_id": milestone.id,
            "classification": "CODE",
            "action": "patched" if result.success else "patched-but-still-failing",
        })
        try:
            db.insert_healing_event(
                run_id=run_id, milestone_id=milestone.id,
                attempt=attempts, classification="CODE",
                reasoning=report.reasoning,
                action="patched" if result.success else "patched-but-still-failing",
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[KOVIX][WARN] db.insert_healing_event(CODE) failed: {exc}")

    acceptance: Dict[str, Any] = _evaluate_acceptance(milestone, result)
    acceptance["spec_signaled"] = spec_signaled
    try:
        db.insert_milestone(
            run_id=run_id,
            milestone_id=milestone.id,
            name=milestone.name,
            filename=milestone.filename,
            returncode=result.returncode,
            all_criteria_passed=bool(acceptance["all_criteria_passed"]),
            criteria=acceptance["criteria"],
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[KOVIX][WARN] db.insert_milestone failed: {exc}")
    return acceptance


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #

def run_loop(
    vibe: str,
    workspace_dir: Path,
    cfg: agent.LLMConfig,
    on_event: EventCallback,
    max_heal_attempts: int = MAX_HEAL_ATTEMPTS,
    max_spec_retries: int = MAX_SPEC_RETRIES,
) -> Dict[str, Any]:
    """Execute the full PAUL loop. Returns the final unify report."""
    workspace_dir.mkdir(parents=True, exist_ok=True)
    db.init_db()
    run_id: int = db.start_run(vibe=vibe, provider=cfg.provider_id,
                               model=cfg.resolved_model)

    execution_log: List[Dict[str, Any]] = []
    healing_log: List[Dict[str, Any]] = []
    acceptance_results: List[Dict[str, Any]] = []
    spec_retries_done: int = 0

    def log(phase: str, message: str, status: str = "info",
            payload: Optional[Dict[str, Any]] = None) -> None:
        execution_log.append({
            "phase": phase, "message": message, "status": status,
        })
        _emit(on_event, run_id, phase, message, status, payload)

    # ----------------------------------------------------------------------- #
    # PHASE 1 :: PLAN
    # ----------------------------------------------------------------------- #
    log("PLAN", "Generating plan from vibe ...")
    write_state(workspace_dir, "PLAN", vibe, "_(generating)_", None,
                execution_log, healing_log, None)

    plan: agent.Plan = agent.generate_plan(vibe, cfg)
    log("PLAN", f"Refined goal: {plan.goal}", "success",
        {"goal": plan.goal, "milestone_count": len(plan.milestones)})
    for m in plan.milestones:
        log("PLAN", f"Milestone {m.id} -> {m.name} ({m.filename})",
            "info", {"milestone": m.to_dict()})
    write_state(workspace_dir, "PLAN", vibe, plan.goal, plan,
                execution_log, healing_log, None)

    # ----------------------------------------------------------------------- #
    # PHASE 2 :: APPLY (with SPEC retry loop)
    # ----------------------------------------------------------------------- #
    log("APPLY", f"Applying {len(plan.milestones)} milestone(s) ...")
    write_state(workspace_dir, "APPLY", vibe, plan.goal, plan,
                execution_log, healing_log, None)

    # SPEC retry loop: rebuild plan when a milestone signals SPEC.
    while True:
        spec_signaled: bool = False
        spec_report: Optional[agent.DiagnosticReport] = None

        # Run all milestones in order.
        for milestone in plan.milestones:
            acceptance: Dict[str, Any] = _execute_milestone(
                cfg=cfg,
                run_id=run_id,
                milestone=milestone,
                workspace_dir=workspace_dir,
                goal=plan.goal,
                execution_log=execution_log,
                healing_log=healing_log,
                on_event=on_event,
                on_spec_signal=lambda report: spec_retries_done < max_spec_retries,
            )
            acceptance_results.append(acceptance)
            write_state(workspace_dir, "APPLY", vibe, plan.goal, plan,
                        execution_log, healing_log, None)

            if acceptance.get("spec_signaled"):
                spec_signaled = True
                # find the matching report (last SPEC classification for this milestone)
                spec_report = agent.DiagnosticReport(
                    classification="SPEC",
                    reasoning="Spec mismatch detected during milestone execution.",
                )
                break

        if not spec_signaled:
            break

        # SPEC retry: regenerate plan and restart APPLY.
        spec_retries_done += 1
        log("PLAN",
            f"SPEC retry {spec_retries_done}/{max_spec_retries}: "
            "regenerating plan with diagnostic reasoning ...", "warn")
        previous_failure: str = (
            spec_report.reasoning if spec_report else
            "Previous plan produced a SPEC-level failure during execution."
        )
        plan = agent.generate_plan(vibe, cfg, previous_failure=previous_failure)
        log("PLAN",
            f"Regenerated goal: {plan.goal} "
            f"({len(plan.milestones)} milestones)",
            "success",
            {"goal": plan.goal, "milestone_count": len(plan.milestones),
             "spec_retry": spec_retries_done})
        # Reset acceptance results -- new plan, fresh start.
        acceptance_results = []
        write_state(workspace_dir, "PLAN", vibe, plan.goal, plan,
                    execution_log, healing_log, None)
        if spec_retries_done >= max_spec_retries:
            log("PLAN",
                "SPEC retry cap reached. Proceeding to UNIFY with current state.",
                "warn")
            break

    # ----------------------------------------------------------------------- #
    # PHASE 3 :: UNIFY
    # ----------------------------------------------------------------------- #
    log("UNIFY", "Reconciling execution against acceptance criteria ...")
    passed: int = sum(1 for r in acceptance_results
                      if r.get("all_criteria_passed"))
    failed: int = len(acceptance_results) - passed
    verdict: str = (
        "SUCCESS" if failed == 0
        else "PARTIAL" if passed > 0
        else "FAILURE"
    )
    unify_report: Dict[str, Any] = {
        "total_milestones": len(plan.milestones),
        "passed": passed,
        "failed": failed,
        "verdict": verdict,
        "details": acceptance_results,
        "planned_vs_executed_drift": failed,
        "spec_retries": spec_retries_done,
    }
    log("UNIFY",
        f"Verdict: {verdict} "
        f"({passed} passed / {failed} failed of {len(plan.milestones)}, "
        f"spec_retries={spec_retries_done})",
        "success" if failed == 0 else "warn" if passed > 0 else "error",
        {"unify_report": unify_report})

    write_state(workspace_dir, "UNIFY", vibe, plan.goal, plan,
                execution_log, healing_log, unify_report)

    try:
        db.finish_run(
            run_id=run_id,
            goal=plan.goal,
            verdict=verdict,
            passed=passed,
            failed=failed,
            total_milestones=len(plan.milestones),
            spec_retries=spec_retries_done,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[KOVIX][WARN] db.finish_run failed: {exc}")

    unify_report["run_id"] = run_id
    return unify_report
