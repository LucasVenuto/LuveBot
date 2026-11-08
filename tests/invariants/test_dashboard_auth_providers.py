"""DT-6 (contract v0.11 section 5): every dashboard-auth provider of the Hermes under test is CLASSIFIED, and the classification agrees with what the provider declares.

LuveBot decides "a person with a login" from the session Hermes puts in `request.state.session` (user, provider, token). Whether a provider's session is a PERSON's is a decision about THAT
provider: a shared deployment credential (`session-token`, Hermes main) or a service credential (`drain-secret`) is automation's. A provider this file has never seen could be either, so it
fails here, in the harness, before it can matter in a user's installation: the person who bumps the Hermes under test decides about it and adds it below.

It reads the Hermes tree the stack runs (`plugins/dashboard_auth/*`, the package of each provider; the base class `hermes_cli.dashboard_auth.base.DashboardAuthProvider`), so the list is whatever
this build ships: v0.22.5 has basic, drain-secret, nous and self-hosted; main adds session-token."""
import importlib
import inspect
import pkgutil

PERSON = {'basic', 'nous', 'self-hosted'}              # a person signs in (a password, an OAuth or OIDC login in the browser) and the session is theirs
NOT_A_PERSON = {'session-token', 'drain-secret'}       # a shared deployment token; a service credential for drain control (never a session at all)


def providers():
    import plugins.dashboard_auth as package
    from hermes_cli.dashboard_auth.base import DashboardAuthProvider
    found = {}
    for module_info in pkgutil.iter_modules(package.__path__):
        if module_info.name.startswith('_'):
            continue
        module = importlib.import_module(f'{package.__name__}.{module_info.name}')
        for _name, cls in inspect.getmembers(module, inspect.isclass):
            if issubclass(cls, DashboardAuthProvider) and cls is not DashboardAuthProvider and cls.__module__ == module.__name__ and cls.name:
                # v0.22.5's base class has no `interactive_login` (every provider there that gives a session is a browser login): absent reads as True, as the newer base's default
                found[cls.name] = {'package': module_info.name, 'supports_session': getattr(cls, 'supports_session', True), 'interactive_login': getattr(cls, 'interactive_login', True),
                                   'supports_password': getattr(cls, 'supports_password', False)}
    return found


def test_the_harness_sees_the_providers_this_hermes_ships():
    found = providers()
    assert {'basic', 'nous', 'self-hosted', 'drain-secret'} <= set(found), sorted(found)    # every build has these four; main adds session-token


def test_every_provider_is_classified_as_a_person_or_not():
    found = providers()
    unclassified = sorted(set(found) - PERSON - NOT_A_PERSON)
    assert not unclassified, (f'dashboard-auth provider(s) {unclassified} of this Hermes are not classified: decide whether the session they give is a PERSON\'s '
                              f'(add to PERSON) or a credential\'s (add to NOT_A_PERSON, and make LuveBot refuse it on the routes that need a person); declared: '
                              f'{ {n: found[n] for n in unclassified} }')


def test_the_classification_agrees_with_what_each_provider_declares():
    """A person's provider has a sign-in a person does (`interactive_login`) and gives a session; a provider that is not a person's lacks one of the two. A classified provider whose
    declaration changed (a deployment token that became interactive, a person's login that stopped being one) fails, so the table is re-decided and not just trusted."""
    found = providers()
    for name in sorted(set(found) & PERSON):
        assert found[name]['supports_session'] and found[name]['interactive_login'], (name, found[name])
    for name in sorted(set(found) & NOT_A_PERSON):
        assert not (found[name]['supports_session'] and found[name]['interactive_login']), (name, found[name])
