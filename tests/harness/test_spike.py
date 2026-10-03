"""Portão 0 probes against a running, unmodified Hermes; no HTTP mocks."""
import json
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, parse_qs

import pytest
from playwright.sync_api import sync_playwright

DASHBOARD = "http://127.0.0.1:9119"
API = "http://127.0.0.1:8642"
CREDS = json.loads(Path("/spike/credentials.json").read_text())


def get(url, key=None):
    headers = {"Authorization": "Bearer " + key} if key else {}
    try:
        with urlopen(Request(url, headers=headers), timeout=5) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


@pytest.fixture(scope="module", autouse=True)
def real_hermes_ready():
    deadline = time.monotonic() + 180
    last_error = None
    while time.monotonic() < deadline:
        try:
            dash_status, _ = get(DASHBOARD + "/api/auth/providers")
            api_status, _ = get(API + "/p/vendas/v1/capabilities", CREDS["vendas_api_key"])
            if dash_status == 200 and api_status == 200:
                return
            last_error = (dash_status, api_status)
        except (URLError, TimeoutError, ConnectionError) as error:
            last_error = type(error).__name__
        time.sleep(1)
    pytest.fail(f"Real Hermes did not become ready: {last_error}")


@pytest.fixture(scope="module")
def human_browser():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        login = context.request.post(DASHBOARD + "/auth/password-login", data={
            "provider": "basic", "username": CREDS["username"],
            "password": CREDS["password"], "next": "/"})
        assert login.status == 200
        assert login.json()["ok"] is True
        assert any(cookie["name"] == "hermes_session_at" for cookie in context.cookies())
        print("\nHuman password login: HTTP 200, real session cookie present (value omitted)")
        yield context
        browser.close()


def test_plugin_route_requires_dashboard_session():
    status, payload = get(DASHBOARD + "/api/plugins/t0-spike/probe")
    print(f"\nGET /api/plugins/t0-spike/probe without session -> HTTP {status}: {json.dumps(payload)}")
    assert status == 401


def test_plugin_router_responds_with_human_session(human_browser):
    response = human_browser.request.get(DASHBOARD + "/api/plugins/t0-spike/probe")
    print(f"\nGET /api/plugins/t0-spike/probe with session -> HTTP {response.status}: {response.text()}")
    assert response.status == 200
    assert response.json() == {"spike": "t0-spike", "result": "real-plugin-router"}


def test_manifest_override_replaces_home_in_real_browser(human_browser):
    manifests = human_browser.request.get(DASHBOARD + "/api/dashboard/plugins").json()
    spike = next(item for item in manifests if item["name"] == "t0-spike")
    page = human_browser.new_page()
    page.goto(DASHBOARD + "/")
    marker = page.get_by_test_id("luvebot-spike-home")
    marker.wait_for(timeout=20000)
    assert marker.inner_text() == "LuveBot disposable T0 spike home"
    location = urlsplit(page.url)
    assert location.path == "/"
    assert location.netloc == "127.0.0.1:9119"
    assert parse_qs(location.query).get("profile") == ["default"]
    assert spike["tab"].get("override") == "/"
    page.screenshot(path="/spike/evidence/home.png", full_page=True)
    print("\nActual Chromium / -> manifest tab.override=/; rendered: " + marker.inner_text())
    page.close()


def test_sdk_is_available_in_real_browser(human_browser):
    page = human_browser.new_page()
    page.goto(DASHBOARD + "/")
    page.get_by_test_id("luvebot-spike-home").wait_for(timeout=60000)
    sdk = page.evaluate("""() => {
        const sdk = window.__HERMES_PLUGIN_SDK__;
        return {version: sdk?.sdkVersion, react: typeof sdk?.React?.createElement,
                authenticatedFetch: typeof sdk?.authedFetch};
    }""")
    print("\nwindow.__HERMES_PLUGIN_SDK__: " + json.dumps(sdk))
    assert sdk["version"] == "1.1.0"
    assert sdk["react"] == "function"
    assert sdk["authenticatedFetch"] == "function"
    page.close()


@pytest.mark.parametrize("profile", ["default", "vendas"])
def test_capabilities_respond_for_both_real_profiles(profile):
    route = f"/p/{profile}/v1/capabilities"
    key = CREDS["api_key" if profile == "default" else "vendas_api_key"]
    status, capabilities = get(API + route, key)
    print(f"\nGET {route} -> HTTP {status}: " + json.dumps({
        "object": capabilities.get("object"), "auth": capabilities.get("auth"),
        "run_submission": capabilities.get("features", {}).get("run_submission")}))
    assert status == 200
    assert capabilities["object"] == "hermes.api_server.capabilities"
    assert capabilities["auth"] == {"type": "bearer", "required": True}
    assert capabilities["features"]["run_submission"] is True
    unauthorized, _ = get(API + route)
    assert unauthorized == 401
    assert key not in json.dumps(capabilities)
    print(f"GET {route} without API key -> HTTP {unauthorized}")


def test_real_hermes_uses_local_fake_model_provider():
    _, before = get("http://fake-openai:8000/health")
    payload = json.dumps({"model": "hermes", "messages": [
        {"role": "user", "content": "Say hello without using any tools."}], "stream": False}).encode()
    request = Request(API + "/p/default/v1/chat/completions", data=payload, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + CREDS["api_key"]})
    with urlopen(request, timeout=90) as response:
        status, result = response.status, json.loads(response.read())
    _, after = get("http://fake-openai:8000/health")
    content = result["choices"][0]["message"]["content"]
    print(f"\nReal Hermes chat -> HTTP {status}, content={content!r}, local model requests increased="
          + str(after["requests_seen"] > before["requests_seen"]))
    assert status == 200
    assert content == "Harness model response"
    assert after["requests_seen"] > before["requests_seen"]
