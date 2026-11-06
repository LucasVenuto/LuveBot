"""Applies ONE mutation of tests/harness/mutate_v04.py to a worktree, with the runner's own anchor check (exactly one hit, valid syntax).
Usage: apply.py <worktree> <name|base>. Prints the pytest node ids of the mutation's test (all params), one per line."""
import sys
from pathlib import Path

wt, name = Path(sys.argv[1]), sys.argv[2]
sys.path.insert(0, str(wt / 'tests/harness'))
import mutate_v04 as m  # noqa: E402

TESTS = {'t83d_image_accepted': ('test_mascot.py', 'test_an_unknown_mascot_or_an_image_is_refused_on_both_routes_and_writes_nothing'),
         'luve_any_value': ('test_mascot.py', 'test_a_luve_recipe_off_the_lists_is_refused_on_both_routes_and_writes_nothing'),
         'me_no_csrf': ('test_person_display.py', 'test_no_csrf_no_change_and_no_audit_row')}
if name != 'base':
    file, short, edits, *suite = m.MUTATIONS[name]
    assert suite[0] == TESTS[name][0] and TESTS[name][1].startswith(short), (suite, short)
    target = wt / file
    target.write_text(m.mutate(target.read_text(), edits))
    print('MUTATED ' + file, file=sys.stderr)
for key in ('t83d_image_accepted', 'luve_any_value', 'me_no_csrf') if name == 'base' else (name,):
    print(f'{TESTS[key][0]}::{TESTS[key][1]}')
