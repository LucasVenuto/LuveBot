"""Sanitization acceptance (T2.10s / MAESTRO Portão 2 / Red Team #3).

Asserts in REAL Chromium against the real harness (DASHBOARD :9119, fake-openai model scenario T210_HTML):
(a) Turn reaches confirmed terminal status 'Concluído'.
(b) Hostile text appears strictly as visible plain text in response, tool card, and Terminal panel (minimum occurrences verified).
(c) Legitimate link exists, is safely configured, and is clickable (opens https://example.com/ok).
(d) Negative control proving assertions strictly fail on a scenario without hostile content.
"""
import pytest
from playwright.sync_api import expect

from conftest import open_conversation, open_luvebot, send, tool_card

TRIGGER_PROMPT = "T210_HTML: execute hostile markup scenario"
BENIGN_PROMPT = "Mensagem benigna sem marcacao hostil"
SAFE_LINK_URL = "https://example.com/ok"
FORBIDDEN_TAGS = "script, iframe, object, embed, form, svg"


def _check_no_forbidden_tags(locator, context_name):
    count = locator.locator(FORBIDDEN_TAGS).count()
    assert count == 0, f"Found forbidden tags ({FORBIDDEN_TAGS}) inside {context_name}: count={count}"


def _check_no_on_attributes(locator, context_name):
    bad = locator.evaluate("""(root) => {
        const elements = [root, ...root.querySelectorAll('*')];
        const violations = [];
        for (const el of elements) {
            for (const attr of el.attributes) {
                if (attr.name.toLowerCase().startsWith('on')) {
                    violations.push({ tag: el.tagName, attr: attr.name, value: attr.value });
                }
            }
        }
        return violations;
    }""")
    assert bad == [], f"Found inline event handler (on*) attributes inside {context_name}: {bad}"


def _check_safe_hrefs(locator, context_name):
    hrefs = locator.evaluate("""(root) => {
        const links = root.querySelectorAll('a[href]');
        return Array.from(links).map(a => a.getAttribute('href'));
    }""")
    for href in hrefs:
        assert href.startswith(("http://", "https://", "mailto:")), f"Unsafe href inside {context_name}: {href}"


def assert_hostile_occurrences(msg_card, tool_box, terminal_panel):
    """Enforces minimum occurrences of hostile vectors rendered strictly as plain text."""
    msg_text = msg_card.inner_text()
    assert msg_text.count("<script>window.__pwn_script=1</script>") >= 1
    assert msg_text.count("<img src=x onerror=") >= 1
    assert msg_text.count("<svg onload=") >= 1
    assert msg_text.count("<iframe srcdoc=") >= 1
    assert msg_text.count("<div onmouseover=") >= 1
    assert msg_text.count("javascript:") >= 2
    assert msg_text.count("data:text/html") >= 1

    tool_text = tool_box.inner_text()
    assert tool_text.count("<script>window.__pwn_tool_script=1</script>") >= 2
    assert tool_text.count("<img src=x onerror=") >= 2
    assert tool_text.count("<svg onload=") >= 2

    terminal_text = terminal_panel.inner_text()
    assert terminal_text.count("<script>window.__pwn_tool_script=1</script>") >= 2
    assert terminal_text.count("<img src=x onerror=") >= 2
    assert terminal_text.count("<svg onload=") >= 2


def test_agent_content_rendered_with_strict_sanitization(human):
    context = human()
    page = open_luvebot(context)

    dialogs = []
    network_requests = []

    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    page.on("request", lambda r: network_requests.append(r.url))

    open_conversation(page, "vendas")
    region = page.get_by_role("region", name="Conversa com vendas")

    # The Bot reopens its last conversation (earlier turns load after the page): everything below is read inside THIS turn,
    # the one whose bubble carries the prompt sent here
    send(page, TRIGGER_PROMPT)
    turn = region.locator("[data-turn]").filter(has_text=TRIGGER_PROMPT).last

    # (a) Turn reaches confirmed terminal 'Concluído'
    turn_status = turn.locator("[role=status]")
    expect(turn_status).to_have_text("Concluído", timeout=30_000)
    expect(page.get_by_role("button", name="Enviar")).to_be_visible(timeout=10_000)

    # 1. No dialogs / alerts were ever triggered
    assert dialogs == [], f"Hostile alert/dialog was triggered: {dialogs}"

    # 2. No network requests dispatched to injected hostile destinations
    hostile_requests = [
        url for url in network_requests
        if url.endswith("/x") or "pwn" in url.lower() or url.startswith(("javascript:", "data:"))
    ]
    assert hostile_requests == [], f"Hostile network requests observed: {hostile_requests}"

    # 3. Global window scope: no injected exploit variables exist
    pwn_keys = page.evaluate("() => Object.keys(window).filter(k => k.includes('pwn'))")
    assert pwn_keys == [], f"Hostile payload executed in window scope: {pwn_keys}"

    # 4. Page-level query for active exploit elements across entire document
    assert page.locator("script:has-text('pwn')").count() == 0
    assert page.locator("iframe").count() == 0
    assert page.locator("object, embed").count() == 0
    assert page.locator("svg[onload]").count() == 0
    assert page.locator("img[onerror]").count() == 0
    assert page.locator("[onmouseover]").count() == 0

    # Ensure no form came from agent payload (only the legitimate chat input form exists)
    assert page.locator(".luve-md form, [aria-label='Painel de trabalho'] form").count() == 0
    forms = page.locator("form").all()
    assert len(forms) == 1
    assert forms[0].locator('textarea[aria-label="Mensagem"]').count() == 1

    # 5. Final Answer Card (.luve-md)
    message_card = turn.locator(".luve-md").filter(has_text="Resposta com marcação ativa").first
    expect(message_card).to_be_visible()

    _check_no_forbidden_tags(message_card, "Final Answer Card")
    _check_no_on_attributes(message_card, "Final Answer Card")
    _check_safe_hrefs(message_card, "Final Answer Card")

    # (c) Legitimate link exists, has rel noopener, and is clickable (opens https://example.com/ok in new tab)
    safe_link = message_card.get_by_role("link", name="seguro")
    expect(safe_link).to_be_visible()
    assert safe_link.get_attribute("href") == SAFE_LINK_URL
    assert safe_link.get_attribute("target") == "_blank"
    rel = safe_link.get_attribute("rel") or ""
    assert "noopener" in rel and "noreferrer" in rel

    with context.expect_page() as new_page_info:
        safe_link.click()
    new_page = new_page_info.value
    assert SAFE_LINK_URL in new_page.url
    new_page.close()

    # 6. Tool Card
    tool_button = tool_card(turn)
    expect(tool_button).to_be_visible()
    if tool_button.get_attribute("aria-expanded") == "false":
        tool_button.click()

    tool_box = tool_button.locator("xpath=..")
    _check_no_forbidden_tags(tool_box, "Tool Card")
    _check_no_on_attributes(tool_box, "Tool Card")
    _check_safe_hrefs(tool_box, "Tool Card")

    # 7. Work Panel - Atividade tab
    panel = page.locator('[aria-label="Painel de trabalho"]')
    expect(panel).to_be_visible()

    panel.get_by_role("tab", name="Atividade").click()
    activity_panel = panel.locator('[role="tabpanel"]')
    expect(activity_panel).to_be_visible()

    _check_no_forbidden_tags(activity_panel, "Work Panel (Atividade)")
    _check_no_on_attributes(activity_panel, "Work Panel (Atividade)")
    _check_safe_hrefs(activity_panel, "Work Panel (Atividade)")
    expect(activity_panel).to_contain_text("terminal")
    expect(activity_panel).to_contain_text("<script>window.__pwn_tool_script=1</script>")

    # 8. Work Panel - Terminal tab
    panel.get_by_role("tab", name="Terminal").click()
    terminal_panel = panel.locator('[role="tabpanel"]')
    expect(terminal_panel).to_be_visible()

    _check_no_forbidden_tags(terminal_panel, "Work Panel (Terminal)")
    _check_no_on_attributes(terminal_panel, "Work Panel (Terminal)")
    _check_safe_hrefs(terminal_panel, "Work Panel (Terminal)")

    # (b) Enforce minimum occurrences of hostile vectors in response, tool card, and Terminal panel
    assert_hostile_occurrences(message_card, tool_box, terminal_panel)


def test_negative_control_fails_when_hostile_content_absent(human):
    """Negative control: asserts that assertions strictly fail when hostile content is absent."""
    context = human()
    page = open_luvebot(context)

    open_conversation(page, "vendas")
    region = page.get_by_role("region", name="Conversa com vendas")

    send(page, BENIGN_PROMPT)
    turn = region.locator("[data-turn]").filter(has_text=BENIGN_PROMPT).last

    turn_status = turn.locator("[role=status]")
    expect(turn_status).to_have_text("Concluído", timeout=30_000)

    # Benign response is present
    message_card = turn.locator(".luve-md").first
    expect(message_card).to_contain_text("Harness model response")

    # Panel has no terminal runs
    panel = page.locator('[aria-label="Painel de trabalho"]')
    panel.get_by_role("tab", name="Terminal").click()
    terminal_panel = panel.locator('[role="tabpanel"]')

    # Tool button does not exist for this turn
    assert turn.locator("button[aria-expanded]").filter(has_text="terminal").count() == 0

    # 1. Calling assert_hostile_occurrences on benign elements strictly raises AssertionError
    with pytest.raises(AssertionError):
        assert_hostile_occurrences(message_card, message_card, terminal_panel)

    # 2. Individual hostile payload assertions strictly fail
    with pytest.raises(AssertionError):
        expect(message_card).to_contain_text("<script>window.__pwn_script=1</script>", timeout=1_000)

    with pytest.raises(AssertionError):
        expect(message_card).to_contain_text("<img src=x onerror=", timeout=1_000)

    with pytest.raises(AssertionError):
        expect(message_card).to_contain_text("[markdown perigoso]", timeout=1_000)

    # 3. Legitimate safe link is not present in benign turn
    with pytest.raises(AssertionError):
        expect(message_card.get_by_role("link", name="seguro")).to_be_visible(timeout=1_000)
