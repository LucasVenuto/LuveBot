"""F-SK-A1 (the Lume, docs/redteam/v03-sk2-fatias-a-b-2026-10-31.md), measured on the REAL Hermes (the Hermes the test runs in, v0.22.5 and main alike): why the dry run of "Save as a skill" must refuse a skill NAME
that Hermes's YAML reads as something that is not text.

Hermes reads and lists skills with `hermes_yaml` (ruamel, YAML 1.1), not PyYAML: `name: y` is the boolean `True`, `n` is `False`, `1e3` is the float `1000.0`. Three facts, each in a throw-away Hermes home (a subprocess:
nothing of the running stack is touched):
  * the YAML: those names are not strings, a quoted one is (`"y"` reads `y`), and a repeated key is refused (not last-wins);
  * a skill that is DISABLED in `skills.disabled` by its real name is refused by `skill_view` when its header name is plain (the control), but the skills named `y`, `n` and `1e3` are STILL SERVED
    (`success: true`, their text returned): the disabled check compares the name the header read (a boolean), so "born OFF" does not hold for them;
  * `skills_list` skips them (it slices the name and stumbles), so nothing can tell they exist: LuveBot's step "read the list by name" cannot see them either.
This pins the premise Hermes gives; the defence is LuveBot's: the dry run refuses such a name (a quoted one is accepted and is disabled like any other). It is Hermes's behavior: if Hermes fixes it, these asserts
turn red on purpose and the dry run's rule can be reviewed."""
import json
import subprocess
import sys
from pathlib import Path

PROBE = r'''
import json, os, warnings
from pathlib import Path
warnings.simplefilter("ignore")
home = Path(os.environ["HERMES_HOME"])
skills, disabled, views = (json.loads(os.environ[k]) for k in ("SKILLS", "DISABLED", "VIEWS"))
import hermes_yaml as y
reads = {t: y.safe_load("name: " + t)["name"] for t in ("y", "n", "1e3", '"y"', "skill-z")}
try:
    y.safe_load("name: a\nname: b"); repeated = "accepted"
except Exception as error:
    repeated = type(error).__name__
for folder, yaml_name in skills:                       # (the folder, the YAML text of the header `name:`)
    path = home / "skills" / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text("---\nname: " + yaml_name + "\ndescription: Probe skill " + folder + "\n---\n\n# " + folder + "\n\nBody of " + folder + ".\n")
(home / "config.yaml").write_text("skills:\n  disabled:\n" + "".join("    - " + json.dumps(name) + "\n" for name in disabled) if disabled else "skills: {}\n")
from tools.skills_tool import skill_view, skills_list
served = {}
for name in views:
    out = json.loads(skill_view(name))
    served[name] = {"success": out.get("success"), "name": repr(out.get("name")), "has_text": "Body of " in str(out.get("content") or "")}
listed = sorted(repr(s.get("name")) for s in json.loads(skills_list()).get("skills", []))
print(json.dumps({"reads": {k: repr(v) for k, v in reads.items()}, "repeated_key": repeated, "served": served, "listed": listed}))
'''


def measured(tmp_path, skills, disabled, views):
    import hermes_cli
    root = Path(hermes_cli.__file__).resolve().parent.parent
    home = tmp_path / ('home-' + str(len(list(tmp_path.iterdir()))))
    home.mkdir()
    done = subprocess.run([sys.executable, '-c', PROBE], cwd=root, capture_output=True, text=True, timeout=180,
                          env={'PATH': '/usr/bin:/bin', 'HOME': str(tmp_path), 'HERMES_HOME': str(home), 'HERMES_STATE_DB_GUARD_BYPASS': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                               'SKILLS': json.dumps(skills), 'DISABLED': json.dumps(disabled), 'VIEWS': json.dumps(views)})
    assert done.returncode == 0, done.stderr[-600:]
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_hermes_reads_a_plain_y_n_or_1e3_name_as_a_non_string_and_serves_such_a_skill_although_it_is_disabled(tmp_path):
    plain = [['y', 'y'], ['n', 'n'], ['1e3', '1e3'], ['z', 'z']]
    found = measured(tmp_path, plain, ['y', 'n', '1e3', 'z'], ['z', 'y', 'n', '1e3'])
    assert found['reads'] == {'y': 'True', 'n': 'False', '1e3': '1000.0', '"y"': "'y'", 'skill-z': "'skill-z'"}, found['reads']
    assert found['repeated_key'] == 'DuplicateKeyError', found['repeated_key']                              # the dry run's last-wins reading would disagree with Hermes (F-SK-A3)
    assert found['served']['z'] == {'success': False, 'name': 'None', 'has_text': False}, found['served']['z']   # the control: disabled by its name, refused
    for name, read in (('y', 'True'), ('n', 'False'), ('1e3', '1000.0')):
        assert found['served'][name] == {'success': True, 'name': read, 'has_text': True}, (name, found['served'][name])   # NOT refused: it loads although it is in `skills.disabled`
    assert found['listed'] == [], found['listed']                                                            # the listing skips them (and `z`, disabled): nothing can tell the plain ones exist


def test_a_quoted_name_is_read_as_the_text_y_listed_by_that_name_and_a_disabled_one_is_refused(tmp_path):
    quoted = [['q', '"y"']]
    on = measured(tmp_path, quoted, [], ['y'])
    assert on['listed'] == ["'y'"] and on['served']['y'] == {'success': True, 'name': "'y'", 'has_text': True}, on         # a quoted name is a string: listed as `y`, served as `y`
    off = measured(tmp_path, quoted, ['y'], ['y'])
    assert off['served']['y'] == {'success': False, 'name': 'None', 'has_text': False} and off['listed'] == [], off     # and disabled by that name it IS refused: this is what the dry run accepts
