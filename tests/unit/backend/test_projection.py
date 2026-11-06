"""Contract v0.8 section 7 (backend/budget.py project / Budget.projection): the month's spend projected to its end from the mean of
the last 7 days, against the monthly cap; fewer than 3 days with spend: no projection. A number, never an action. Fixed clock.
Mutations: the mean over the whole month; the "poucos dados" rule dropped; the crossing day counted from the 1st.
"""
from datetime import date, datetime, timezone
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()


def load(edit=None):
    name = f'proj_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.budget')
    source = (BACKEND / 'budget.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.budget', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'budget.py'), 'exec'), module.__dict__)
    return module


def days(spec):
    """{'2026-04-DD': cents} from {day: cents}."""
    return {f'2026-04-{d:02d}': cents for d, cents in spec.items()}


class Clock:
    now = datetime(2026, 4, 1, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.now


def checks(budget, tmp_path):
    today = date(2026, 4, 10)                                    # April: 30 days
    steady = budget.project(today, days({d: 100 for d in range(1, 11)}), 3000)
    assert steady == {'month': '2026-04', 'spent_cents': 1000, 'projected_cents': 3000, 'cap_cents': 3000,
                      'crosses_cap_on': '2026-04-30', 'basis_days': 7}
    assert budget.project(today, days({9: 100, 10: 100}), 3000)['projected_cents'] is None          # 2 days: poucos dados
    burst = budget.project(today, days({1: 1000, 2: 1000, 3: 1000, **{d: 100 for d in range(4, 11)}}), 10000)
    assert burst['projected_cents'] == 3700 + 100 * 20 and burst['crosses_cap_on'] is None          # the last 7 days, not the month
    over = budget.project(today, days({d: 400 for d in range(1, 11)}), 3000)
    assert over['crosses_cap_on'] == '2026-04-10'                                                   # already reached: today
    young = budget.project(date(2026, 4, 4), days({1: 50, 2: 50, 3: 50}), None)
    assert young['basis_days'] == 4 and young['projected_cents'] == 150 + round(150 / 4 * 26) and young['crosses_cap_on'] is None

    clock = Clock()                                              # the same through the budget's own ledger, per Bot and global
    ledger = budget.Budget(tmp_path / f'p{next(_n)}' / 'luvebot.db', clock=clock, stop_percent=100)
    ledger.set_limit('bot', 'alpha', 'month', 3000, actor='human')
    for day in range(1, 11):
        clock.now = datetime(2026, 4, day, 12, tzinfo=timezone.utc)
        ledger.record_spend(f'a{day}', 'alpha', 100)
        ledger.record_spend(f'b{day}', 'beta', 50)
    alpha = ledger.projection('alpha')
    assert alpha['projected_cents'] == 3000 and alpha['crosses_cap_on'] == '2026-04-30' and alpha['cap_cents'] == 3000
    everyone = ledger.projection()
    assert everyone['spent_cents'] == 1500 and everyone['projected_cents'] == 4500 and everyone['cap_cents'] is None
    assert ledger.evaluate('alpha')['allowed'] is True                                             # a projection pauses nothing


def test_projection(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ("    window = [(today - timedelta(days=back)).isoformat() for back in range(min(7, today.day))]",
     "    window = [(today - timedelta(days=back)).isoformat() for back in range(today.day)]"),
    ("    if sum(1 for cents in by_day.values() if cents > 0) < 3:", "    if False:"),
    ("            out[\"crosses_cap_on\"] = (today + timedelta(days=math.ceil((cap - spent) / avg))).isoformat()",
     "            out[\"crosses_cap_on\"] = (today.replace(day=1) + timedelta(days=math.ceil((cap - spent) / avg))).isoformat()"),
], ids=['mean_over_the_whole_month', 'no_few_data_rule', 'crossing_from_the_first'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), tmp_path)
