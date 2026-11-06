# Crie seu Luve B1/B2: the three mutations, red on the native (no Docker) harness

Tested commit: `b37b234`, Hermes v0.22.5 real (native lane, one stack at a time). Mutations come from `tests/harness/mutate_v04.py`
(`apply.py` imports its table and its anchor check: exactly one hit, valid syntax). Each run boots a fresh stack, runs ONE test (all its
params) against the mutated copy of the plugin, and the repository tree is never touched (a clean worktree is reset between runs).

| Run | Mutation (one defect) | Test | Result |
| --- | --- | --- | --- |
| base | none | the 3 tests below + their files (`test_mascot.py` 11, `test_mascot.py` 8, `test_person_display.py` 2) | **11 + 8 + 2 passed**, `audit append failed = 0` |
| `t83d_image_accepted` | `bot_meta.py`: `image` joins the accepted avatar kinds | `test_an_unknown_mascot_or_an_image_is_refused_on_both_routes_and_writes_nothing` | **2 failed, 9 passed**: both `image` params, `assert 200 == 422` |
| `luve_any_value` | `bot_meta.py`: the Luve recipe check becomes `pass` | `test_a_luve_recipe_off_the_lists_is_refused_on_both_routes_and_writes_nothing` | **8 failed** (all params: wrong shape/material/accessory, upper-case hex, `#` hex, extra part, URL, number), `assert 200 == 422` |
| `me_no_csrf` | `plugin_api.py`: `PUT /me/display` no longer calls `_require_csrf` | `test_no_csrf_no_change_and_no_audit_row` | **2 failed** (`None` and `forged` token), `assert 200 == 403`, the face was written |

Every red is an assertion on the HTTP status (the mutated route answered 200), not a boot, import or syntax failure.

Run: `RUN=<native run.sh> H=<scratch root with venv and hermes> WT=<clean worktree of main> OUT=<dir> zsh run.zsh [names...]`.
`logs/*.txt` has the raw pytest output and the exact diff of each mutation.
