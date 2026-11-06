"""Editing a routine sends `schedule` in the PATCH: Hermes's own update_job takes it (parsed, `next_run_at` refreshed unless paused); an object or an
empty text is 422 as at creation; a schedule Hermes cannot read is a 422 and not "Hermes is unavailable"; the update is audited. WRITTEN, NOT RUN.
The rules and their mutations: tests/unit/backend/test_routine_schedule_patch.py."""
from test_bots import audit_rows, patch, post
from test_phase4 import delete, new_routine


def test_editing_the_schedule_of_a_paused_routine_leaves_it_paused(human_browser):
    """Invariant 7 with Hermes's REAL update_job (cron/jobs.py#L2086): a routine paused (by a person here, as by the cap: the same `state: paused`) keeps its
    pause when only its schedule is sent. UNPROVEN until the harness runs."""
    made = []
    routine = new_routine(human_browser, made, 'sch-paused', start=True)
    try:
        assert post(human_browser, f"/routines/{routine['id']}/pause", {}).status == 200
        edited = patch(human_browser, f"/routines/{routine['id']}", {'schedule': '0 10 * * 3'})
        assert edited.status == 200, edited.text()
        after = edited.json()['routine']
        assert after['schedule']['expr'] == '0 10 * * 3'
        assert after['state'] == 'paused' and after['enabled'] is False, after                    # edited, and still paused
    finally:
        for job_id in made:
            delete(human_browser, f'/routines/{job_id}', {'confirm_name': 'sch-paused'})


def test_the_schedule_of_a_routine_can_be_edited(human_browser):
    made = []
    routine = new_routine(human_browser, made, 'sch-patch', start=False)
    try:
        rows = len(audit_rows('routine.update'))
        edited = patch(human_browser, f"/routines/{routine['id']}", {'schedule': '0 9 * * 2'})
        assert edited.status == 200, edited.text()
        assert edited.json()['routine']['schedule']['expr'] == '0 9 * * 2'
        assert len(audit_rows('routine.update')) == rows + 2                                               # intent and result
        for bad in ({'schedule': {'kind': 'cron', 'expr': '0 9 * * 2'}}, {'schedule': ''}, {'schedule': 7}):
            assert patch(human_browser, f"/routines/{routine['id']}", bad).status == 422, bad
        refused = patch(human_browser, f"/routines/{routine['id']}", {'schedule': 'banana banana banana'})
        assert refused.status == 422 and refused.json()['error']['code'] == 'invalid_field'               # Hermes cannot read it: the person's input
        assert patch(human_browser, f"/routines/{routine['id']}", {'name': 'sch-patch-2'}).status == 200  # the other fields still go
    finally:
        for job_id in made:  # the name may or may not have been edited when the test stopped: try both
            for name in ('sch-patch-2', 'sch-patch'):
                if delete(human_browser, f'/routines/{job_id}', {'confirm_name': name}).status == 200:
                    break
