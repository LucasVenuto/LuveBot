# O ícone do LuveBot na Tela de Início do iPhone: o que foi medido (2026-10-31)

Pilha nativa (sem Docker), Hermes v0.22.5 (`bf0203a7`) com o login do painel ligado (`HERMES_DASHBOARD_PUBLIC_URL` não loopback), plugin copiado do main `cfa3020`
(ANTES) e com este patch (DEPOIS). Tudo SEM cookie e com o User-Agent do iOS (`CFNetwork/1494.0.7 Darwin/23.4.0`), que é como o iPhone busca o ícone.

## 1. O ícone e o manifest saem sem sessão? SIM (a hipótese do 401 / redirect para o login está refutada)

| Pedido (sem cookie) | Resposta |
|---|---|
| `/dashboard-plugins/luvebot/icons/apple-touch-icon.png` | 200 `image/png` 23857 bytes |
| `.../icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `favicon-32.png` | 200 `image/png` |
| `.../icons/icon.svg` | 200 `image/svg+xml` |
| `.../pwa.json`, `.../sw.js` | 200 `application/json`, 200 `application/javascript` |
| as mesmas com `?profile=default`, `/dashboard-plugins/@default/...`, `/@vendas/...` | 200 `image/png` |
| com `Host: harness.test`, `X-Forwarded-Proto: https`, `X-Forwarded-Host`, `X-Forwarded-Prefix: /hermes`, `Range`, sem User-Agent | 200 (206 no Range) `image/png` |

Por quê: o Hermes serve `/dashboard-plugins/...` "sem autenticação de propósito" (só com lista de sufixos) e o portão libera o prefixo
(`hermes_cli/web_routers/dashboard_ui.py` `serve_plugin_asset`, `hermes_cli/dashboard_auth/middleware.py` `_GATE_PUBLIC_PREFIXES`). Nenhuma rota de dados foi afrouxada; controles negativos:

| Pedido (sem cookie) | Resposta |
|---|---|
| `/api/plugins/luvebot/health`, `/bots`, `/approvals` | 401 `application/json` |
| `/` | 302 para `/login?next=%2F` |
| `/dashboard-plugins/luvebot/plugin_api.py`, `.../dashboard/plugin_api.py`, `.../icons/` (pasta) | 404 |
| `/dashboard-plugins/luvebot/../../../../etc/passwd` | 302 para o login |
| `/dashboard-plugins/nao-existe/icons/apple-touch-icon.png` | 404 |

Achados laterais: `HEAD` no ícone dá 405 (a rota só aceita GET); o ícone que o iOS tenta na RAIZ quando não acha link (`/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png`) dá 302 para o login: um plugin não pode servir a raiz do domínio, então o que vale é o link no `<head>` e o manifest.

## 2. Com caminho-base (proxy com prefixo) os `src` absolutos do `pwa.json` quebravam? SIM

`manifest-ANTES.txt` / `manifest-DEPOIS.txt` (`manifest_probe.py`: resolve cada `src` e o `start_url` contra o endereço do manifest, como o navegador, e baixa cada ícone
tirando o prefixo como o proxy): ANTES, com `/hermes` ou `/a/b`, o `start_url` ia para `/` e os 4 ícones eram pedidos na RAIZ do domínio, fora do Hermes (10 problemas);
DEPOIS, com nenhum prefixo, `/hermes` e `/a/b`: 4 ícones PNG com as dimensões reais iguais às declaradas (180, 192, 512, 512) e `start_url` no prefixo (tudo certo).
Também saiu do manifest a entrada SVG com `sizes: "any"` (o iPhone não desenha SVG e uma entrada "any" é a primeira que ele pode escolher).

## 3. O `<link rel=apple-touch-icon>` do próprio Hermes vem antes e ganha? NÃO existe

O `index.html` do Hermes (com sessão, com e sem `X-Forwarded-Prefix`) só tem `<link rel="icon" href="/favicon.ico">` e `<title>Hermes Agent - Dashboard</title>`: nem `apple-touch-icon`
nem `manifest`. O link do LuveBot é o único, e não havia nome: o iPhone usaria o título do Hermes. Agora há `apple-mobile-web-app-title` = LuveBot (só se o host não deu um).

## 4. O iOS lê o link injetado em tempo de execução? Isto o navegador daqui NÃO prova

No Chrome real (CDP, 390 x 844, com login): ANTES e DEPOIS o `manifest` e o `apple-touch-icon` já estavam no `<head>` no MESMO milissegundo do primeiro desenho do app
(1005 ms e 1028 ms, mesma rodada), e o ícone injetado carrega como 180x180. Ou seja, injetar "mais cedo" não muda nada que se meça; a chamada ficou no carregamento do bundle só
porque é de graça e não depende do React montar. Se o iOS lê links injetados na hora do "Adicionar à Tela de Início" só o iPhone do CEO confirma.

## O que só o iPhone do CEO confirma

1. Que o ícone do Luve (e o nome LuveBot) aparece na janela "Adicionar à Tela de Início". Antes: remover o ícone antigo da Tela de Início e apagar os dados do site no Safari
   (Ajustes > Safari > Avançado > Dados de Sites; o iOS guarda a tentativa que falhou), abrir o endereço no Safari (não pelo ícone antigo), esperar o LuveBot carregar e só então Compartilhar > Adicionar.
2. Que o servidor real entrega o que a pilha entregou. Rodar de qualquer computador (só lê, sem login): `scripts/check_home_screen_icon.sh https://ENDERECO-DO-SERVIDOR[/prefixo]`.
   Se algo atrás do Hermes (proxy com senha, certificado não confiável pelo iPhone, bloqueio por cookie) negar o ícone sem cookie, é ali que a conta fecha, e nenhum código do plugin resolve.
3. A correção só chega ao servidor com a atualização do plugin (e o `dist` refeito: `npm run build`).

## Retorno do iPhone do CEO (2026-10-31): o ícone apareceu, mas o símbolo ficou pequeno e o fundo preto

O conserto de cima funcionou (o ícone do LuveBot aparece). O que ele viu depois: o mascote pequeno, com margem demais, num fundo preto que não combina com a marca.
As duas coisas tinham causa nos arquivos (`antes-depois.png`, lado a lado, mostra tudo):

| | Antes | Depois |
|---|---|---|
| Largura do mascote (medida nos pixels) | 54% no 180, 59% no 192, 60% no 512, 54% no maskable | 80,6% nos três `any`, 65,4% no maskable (todo dentro do círculo seguro de raio 40%: o mais distante fica a 0,390) |
| Fundo | cartão quase preto (`#0b0f19`) desenhado dentro de uma tela de 512 com 32 px de margem; o 192 e o 512 tinham canais alfa e cantos transparentes, que o iOS pinta de preto (a moldura preta da imagem) | lavanda da marca (`#f1eeff` a `#cfd9ff`), opaca (RGB, sem alfa), de ponta a ponta, a mesma nos quatro arquivos |
| Papel de parede escuro | o cartão preto some | o cartão mantém a borda |

Escolha do fundo: o iOS não troca o ícone de uma página da Tela de Início por tema, então é um fundo só. Testei três fundos da marca nos dois papéis de parede:
o branco-lavanda do kit (`luvebot-app-icon.svg`) perde a borda no papel de parede claro, o periwinkle forte esconde a silhueta do mascote (que é azul) e a lavanda
mantém a borda nos dois e o contorno legível (o azul médio do mascote contra os quatro cantos do fundo fica entre 2,5 e 3,1 para 1, e o azul mais escuro, que é a borda de baixo e da direita, entre 4,7 e 5,7; um logotipo não tem mínimo na WCAG e o teste trava 2,5 no azul médio, que é folga curta de propósito: o arquivo é determinístico).

Como foi feito: o mesmo mascote vetorial do kit de marca, em dois fontes novos (`docs/images/logo/luvebot-home-icon.svg` e `luvebot-home-icon-maskable.svg`), rasterizados pelo Chrome em 1024 e reduzidos
com Pillow (`python3 scripts/build_app_icons.py`; um Chrome com janela de 180 px renderiza em outro tamanho e recorta, e o `file` só confere dimensões: a primeira tentativa saiu errada assim e foi vista a olho).
O script mede o que fez e falha se o mascote não tiver o tamanho do desenho; `tests/unit/pwa/app-icon.test.ts` trava os mesmos números lendo os pixels (os PNGs antigos derrubam os 5 testes).
Três execuções do script dão os mesmos bytes.

O service worker não foi tocado: ele é "cache primeiro" com nome fixo, mas só controla páginas dentro de `/dashboard-plugins/luvebot/` (o painel está em `/`), e o Hermes manda `Cache-Control: no-store` nos arquivos do plugin.
Não mudei `favicon-32.png` nem `icon.svg` (o ícone da aba do navegador, que ainda é o cartão escuro): é decisão de marca, e fica para quem pedir.

### O que só o iPhone do CEO confirma

1. Que o ícone novo agrada na Tela de Início (tamanho do símbolo, lavanda no claro e no escuro).
2. O iOS não atualiza o ícone de uma página já adicionada: é preciso remover o ícone atual e adicionar de novo (e, se aparecer o antigo, apagar os dados do site no Safari, como no roteiro acima), depois que o plugin for atualizado no servidor.

