import json, struct, sys, urllib.request, urllib.error
from urllib.parse import urljoin, urlsplit
B = "http://127.0.0.1:19119"
UA = {"User-Agent": "CFNetwork/1494.0.7 Darwin/23.4.0"}
def get(path):
    req = urllib.request.Request(B + path, headers=UA)
    try:
        r = urllib.request.urlopen(req, timeout=15); return r.status, r.headers.get("content-type"), r.read()
    except urllib.error.HTTPError as e: return e.code, e.headers.get("content-type"), b""
st, ct, body = get("/dashboard-plugins/luvebot/pwa.json")
print("pwa.json sem sessão:", st, ct); m = json.loads(body)
print("start_url", m["start_url"], "| scope", m["scope"], "| tipos:", sorted({i["type"] for i in m["icons"]}))
bad = 0
for prefix in ("", "/hermes", "/a/b"):
    murl = f"https://bot.exemplo.com{prefix}/dashboard-plugins/luvebot/pwa.json"      # onde o navegador buscou o manifest
    root = urlsplit(urljoin(murl, m["start_url"])).path
    ok_root = root == (prefix + "/")
    print(f"\nprefixo {prefix or '(nenhum)'!r}: start_url -> {root} {'ok' if ok_root else 'ERRADO'}"); bad += not ok_root
    for i in m["icons"]:
        full = urlsplit(urljoin(murl, i["src"])).path                                  # o que o navegador pede ao proxy
        if prefix and not full.startswith(prefix + "/"):                               # o endereço absoluto ignora o prefixo
            bad += 1; print(f"  FAIL {full:<58} o navegador pede na RAIZ do domínio, fora de {prefix}: não chega ao Hermes ({i['type']}, {i['sizes']})"); continue
        hermes_path = full[len(prefix):]                                               # o proxy tira o prefixo antes do Hermes
        st, ct, data = get(hermes_path)
        dims = (struct.unpack(">II", data[16:24]) if data[:8] == b"\x89PNG\r\n\x1a\n" else None)
        want = None if i["sizes"] == "any" else tuple(int(x) for x in i["sizes"].split("x"))
        good = st == 200 and ct == i["type"] and (dims == want if want else ct == "image/svg+xml") and (ct == "image/png" or ct == "image/svg+xml")
        bad += not good
        print(f"  {'ok  ' if good else 'FAIL'} {full:<58} {st} {ct} {dims} declarado {i['sizes']} {i.get('purpose','-')}")
print("\nRESULTADO:", "tudo certo" if not bad else f"{bad} problema(s)"); sys.exit(1 if bad else 0)
