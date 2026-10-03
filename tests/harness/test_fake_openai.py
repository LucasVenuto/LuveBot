"""The fake model's contract (t119 demo scenarios), checked in-process: no Hermes, no Docker.

  python -m pytest -q tests/harness/test_fake_openai.py
"""
import json
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import fake_openai  # noqa: E402


@pytest.fixture(scope="module")
def model():
    server = ThreadingHTTPServer(("127.0.0.1", 0), fake_openai.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"

    def ask(*messages):
        request = urllib.request.Request(url, json.dumps({"model": "fake-harness", "messages": list(messages)}).encode(),
                                         {"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(request, timeout=30))["choices"][0]["message"]

    yield ask
    server.shutdown()


def user(text):
    return {"role": "user", "content": text}


TOOL_REPLY = ({"role": "assistant", "content": "", "tool_calls": [{"id": "c", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
              {"role": "tool", "tool_call_id": "c", "content": "ok"})


def room_turn(handle, text, room="Lançamento"):
    peers = ", ".join(f"@{h}" for h in ("vendas", "dev") if h != handle)
    return user(f'[Discussion: "{room}"] You are @{handle}, one participant with {peers} and the user.\n\n'
                f"New messages in this thread since your last turn (oldest first):\n  User (user): {text}\n\n"
                'Rules for this Discussion:\n- If you have nothing new to add, reply with exactly "(pass)".')


DEMO_ROOM = "@Vendas follow-ups dos leads de ontem; @Dev reproduza o bug do cliente X."


def tool_call(message):
    call = message["tool_calls"][0]["function"]
    return call["name"], json.loads(call["arguments"])


def test_existing_turn_contract_is_unchanged(model):
    assert model(user("hello"))["content"] == "Harness model response"
    assert tool_call(model(user("T33_ASK: go"))) == ("terminal", {"command": fake_openai.SCENARIOS["T33_ASK"]["command"]})
    assert model(user("T33_ASK: go"), *TOOL_REPLY)["content"] == "T33 done"
    # c902512: only the LAST user message decides; an older scenario turn and its tool reply do not count
    assert model(user("T33_ASK: go"), *TOOL_REPLY, {"role": "assistant", "content": "T33 done"}, user("hello"))["content"] == "Harness model response"
    assert "tool_calls" in model(user("T33_ASK: go"), *TOOL_REPLY, {"role": "assistant", "content": "T33 done"}, user("T33_ASK: again"))
    assert "background" in tool_call(model(user("T09_OPEN_WINDOW")))[1]


def test_each_room_member_answers_its_own_part_of_the_demo_message(model):
    vendas, dev = model(room_turn("vendas", DEMO_ROOM)), model(room_turn("dev", DEMO_ROOM))
    assert vendas["content"] == fake_openai.ROOM_SCENARIOS["follow-ups dos leads de ontem"]["vendas"]
    assert dev["content"] == fake_openai.ROOM_SCENARIOS["follow-ups dos leads de ontem"]["dev"]
    # the room quotes "reproduza o bug do cliente X", a chat scenario: no tool starts inside the room turn
    assert "tool_calls" not in vendas and "tool_calls" not in dev
    assert "@" not in vendas["content"] + dev["content"]          # no handle in a reply: no second round is pulled in
    assert model(room_turn("chefe", DEMO_ROOM))["content"] == "(pass)"
    assert model(room_turn("vendas", "bom dia"))["content"] == "Harness model response"


def test_dev_reproduces_the_bug_with_the_terminal_and_hands_the_fix_to_vendas_through_kanban(model):
    name, args = tool_call(model(user("Dev, reproduza o bug do cliente X no terminal.")))
    assert name == "terminal" and "pedidos.js:88" in args["command"]
    name, args = tool_call(model(user("Passe a correção para a Vendas avisar o cliente.")))
    assert name == "kanban_create" and args["assignee"] == "vendas" and args["title"]
    assert model(user("Passe a correção para a Vendas avisar o cliente."), *TOOL_REPLY)["content"].startswith("Pronto")


def test_the_follow_up_draft_asks_a_human_through_the_same_rule_as_t33(model):
    name, args = tool_call(model(user("Prepare o follow-up do lead 3.")))
    assert name == "terminal" and "chmod 600" in args["command"]


# English keys for the README photos (EN): each behaves like its Portuguese twin (same tool, command or arguments' target).
PAIRS = (("Dev, reproduza o bug do cliente X no terminal.", "Dev, reproduce customer X's bug in the terminal."),
         ("Prepare o follow-up do lead 3.", "Draft the follow-up for lead 3."),
         ("Passe a correção para a Vendas avisar o cliente.", "Hand the fix to Sales so they tell the customer."))
DEMO_ROOM_EN = "@vendas follow-ups on yesterday's leads; @dev reproduce customer X's bug."


@pytest.mark.parametrize("pt,en", PAIRS)
def test_each_english_key_calls_the_same_tool_as_its_portuguese_twin(model, pt, en):
    (pt_tool, pt_args), (en_tool, en_args) = tool_call(model(user(pt))), tool_call(model(user(en)))
    assert en_tool == pt_tool and en_args.get("command") == pt_args.get("command") and en_args.get("assignee") == pt_args.get("assignee")
    answer = model(user(en), *TOOL_REPLY)["content"]
    assert answer and answer != model(user(pt), *TOOL_REPLY)["content"]                     # answered in English, not the PT line


def test_the_english_room_message_gets_english_answers_per_member_and_no_tool(model):
    lines = fake_openai.ROOM_SCENARIOS["follow-ups on yesterday's leads"]
    for handle in ("vendas", "dev"):
        reply = model(room_turn(handle, DEMO_ROOM_EN))
        assert reply["content"] == lines[handle] and "tool_calls" not in reply and "@" not in reply["content"]
    assert model(room_turn("chefe", DEMO_ROOM_EN))["content"] == "(pass)"


def test_the_demo_commands_are_canonical_so_only_the_rule_they_are_meant_for_asks_a_human():
    """A command LuveBot cannot read canonically is asked about (backend/rules.py hook_verdict, R-12): the demo's terminal
    reproduction must run straight away, and the follow-up must ask only because of the built-in chmod rule."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from backend.rules import Action, _view
    for key in ("reproduza o bug do cliente X", "reproduce customer X's bug", "Prepare o follow-up do lead", "Draft the follow-up for lead"):
        assert _view(Action(bot="", tool="terminal", command=fake_openai.SCENARIOS[key]["command"])).clean, key


def intro_prompt(label, template_id):
    """The intro turn exactly as backend/bot_controls.py intro_instruction builds it (that module imports Hermes, so the format is
    checked against its source below), from the shipped templates."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from backend.templates import get_template
    return (fake_openai.INTRO_MARKER + " Apresente-se ao seu novo usuário em até 3 frases, no seu tom, sem usar ferramentas. Base: "
            + get_template(template_id)["intro_prompt"] + "\nSeu nome: " + label)


def test_the_intro_format_the_fake_reads_is_the_one_luvebot_sends():
    source = (Path(__file__).resolve().parents[2] / "backend/bot_controls.py").read_text()
    assert f"INTRO_MARKER = '{fake_openai.INTRO_MARKER}'" in source and "'\\nSeu nome: ' + display['label']" in source


@pytest.mark.parametrize("label,template_id", [("Chefe de Gabinete", "chief-of-staff"), ("Vendas", "sales"), ("Engenheiro Dev", "dev"),
                                               ("Sales", "sales"), ("Dev Engineer", "dev"), ("Chief of Staff", "chief-of-staff")])
def test_each_demo_bot_introduces_itself_in_its_own_words_and_uses_no_tool(model, label, template_id):
    reply = model(user(intro_prompt(label, template_id)))
    assert reply["content"] == fake_openai.INTROS[label] and "tool_calls" not in reply
    assert label.split()[-1] in reply["content"]


def test_any_other_bot_introduces_itself_by_name(model):
    assert model(user(intro_prompt("Pesquisa", "research")))["content"].startswith("Oi, eu sou Pesquisa.")


DOCS = (("crie um doc .md de teste", "teste-edicao.md"), ("create a test .md doc", "teste-edicao.md"),
        ("atualize a página de teste", "pages/teste-edicao.md"), ("update the test page", "pages/teste-edicao.md"))


@pytest.mark.parametrize("key,path", DOCS)
def test_the_documents_scenarios_write_the_file_and_answer_with_its_path(model, key, path):
    name, args = tool_call(model(user(f"Por favor, {key}.")))
    assert name == "terminal" and path in args["command"]
    assert path in model(user(f"Por favor, {key}."), *TOOL_REPLY)["content"]


@pytest.mark.parametrize("key,path", DOCS)
def test_the_documents_commands_are_canonical_and_no_built_in_rule_asks_about_them(key, path):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from backend.rules import Action, _view, glob_match
    from backend.rules_builtin import FAMILIES
    view = _view(Action(bot="", tool="terminal", command=fake_openai.SCENARIOS[key]["command"]))
    assert view.clean
    assert not [f[0] for f in FAMILIES for g in f[4] for v in view.variants if glob_match(g, v)]


@pytest.mark.parametrize("key,goal", [("investigue com um subagente", "PT_GOAL"), ("investigate with a subagent", "EN_GOAL")])
def test_the_bot_delegates_to_a_real_hermes_subagent_that_answers_with_a_summary(model, key, goal):
    goal = getattr(fake_openai, goal)
    name, args = tool_call(model(user(f"Dev, {key} e me conte a causa.")))
    assert name == "delegate_task" and args["goal"] == goal and args["context"]
    child = model({"role": "system", "content": "You are a focused subagent."}, user(goal))   # Hermes's child: the goal is its message
    assert child["content"] == fake_openai.SUBAGENT_GOALS[goal] and "tool_calls" not in child   # a summary, never a second delegation
    # the delegation is asynchronous in Hermes: the Bot says it delegated, it never claims a cause before the child reports
    assert "pedidos.js:88" not in model(user(f"Dev, {key} e me conte a causa."), *TOOL_REPLY)["content"]


def test_delegate_task_is_not_caught_by_a_built_in_rule():
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from backend.rules import canon_name, glob_match
    from backend.rules_builtin import FAMILIES
    name = canon_name("delegate_task")[0]
    assert not [f[0] for f in FAMILIES for g in f[3] if glob_match(g, name)]


ASK = "Dev, investigue com um subagente e me conte a causa."
HANDLE = ({"role": "assistant", "content": "", "tool_calls": [{"id": "d", "type": "function", "function": {"name": "delegate_task", "arguments": "{}"}}]},
          {"role": "tool", "tool_call_id": "d", "content": '{"status": "started", "delegation_id": "dlg-1"}'},
          {"role": "assistant", "content": "Deleguei a investigação a um subagente do Hermes."})


@pytest.mark.parametrize("role", ["user", "system", "tool"])
def test_the_bot_relays_the_childs_real_summary_when_hermes_delivers_it_and_never_delegates_again(model, role):
    summary = fake_openai.SUBAGENT_GOALS[fake_openai.PT_GOAL]
    done = {"role": role, "content": f"[async_delegation] dlg-1 completed. Result: {summary}"}
    if role == "tool":
        done["tool_call_id"] = "d"
    reply = model(user(ASK), *HANDLE, done)
    assert "tool_calls" not in reply and reply["content"] == "O subagente terminou: " + summary
