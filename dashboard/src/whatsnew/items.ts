// dashboard/src/whatsnew/items.ts
// What's new, written by hand (contract whats-new-v0.md): what a person can use or see in each version, in plain words, in two languages, with WHERE to find it
// in the words of the screen. Fixes and security stay in the CHANGELOG; each item here agrees with the CHANGELOG of its version. Portuguese is the source and English
// a faithful translation. `where` is a path of screen labels joined by " › " (each label as the dictionary writes it; "(um Bot)" and "(a Bot)" stand for "open one");
// `go` is only a WHOLE tab of the shell, never a deeper place. An item the CHANGELOG lists as built but not proven on a real Hermes says so in its `note`.
// The items of the private screens are not here: they reach the screen through the extension point (`extraNews`).
import type { NewsItem, NewsVersionInfo, Pair } from "./types";

export type { NewsItem, NewsVersion, NewsVersionInfo, Pair } from "./types";

/** Newest first. A version is "released" only when the Maestro flips it (with its date) at the release. */
export const NEWS_VERSIONS: readonly NewsVersionInfo[] = [
  { version: "v0.3", status: "unreleased" },
  { version: "v0.2", status: "unreleased" },
  { version: "v0.1", status: "released", date: "2026-10-03" },
];

const NOT_REAL: Pair = { pt: "Ainda não provado num Hermes de verdade.", en: "Not proven on a real Hermes yet." };
const NOT_PHONE: Pair = { pt: "Ainda não testado em celular de verdade nem no Safari.", en: "Not tested on a real phone or in Safari yet." };

export const NEWS_ITEMS: readonly NewsItem[] = [
  // ---------------------------------------------------------------- v0.3
  {
    id: "v03-model", since: "v0.3",
    title: { pt: "Trocar o modelo do Bot", en: "Change the Bot's model" },
    what: { pt: "Escolha outro provedor e outro modelo para o Bot; vale a partir da próxima mensagem, também nas conversas do LuveBot que já estão abertas.", en: "Pick another provider and model for the Bot; it applies from your next message, in LuveBot conversations that are already open too." },
    where: { pt: "Perfil › Identidade e instruções › 3. Modelo", en: "Profile › Identity and instructions › 3. Model" },
    note: { pt: "O aviso de modelo caro ainda não foi provado num Hermes de verdade.", en: "The expensive-model warning is not proven on a real Hermes yet." },
  },
  {
    id: "v03-instructions", since: "v0.3",
    title: { pt: "Editar as instruções do Bot", en: "Edit the Bot's instructions" },
    what: { pt: "Leia e edite o texto de instruções do Bot (SOUL.md); nada é salvo até você clicar em salvar.", en: "Read and edit the Bot's instructions text (SOUL.md); nothing is saved until you click save." },
    where: { pt: "Perfil › Identidade e instruções › 2. Instruções (SOUL.md)", en: "Profile › Identity and instructions › 2. Instructions (SOUL.md)" },
    note: { pt: "Só leitura se o texto esconde uma chave. Ainda não provado num Hermes de verdade.", en: "Read-only if the text hides a key. Not proven on a real Hermes yet." },
  },
  {
    id: "v03-evidence", since: "v0.3",
    title: { pt: "Evidência nas respostas", en: "Evidence in answers" },
    what: { pt: "Peça ao Bot, no editor de instruções, para mostrar de onde tirou as respostas importantes; a conversa marca que o LuveBot não conferiu.", en: "Ask the Bot, in the instructions editor, to show where it got important answers; the chat marks that LuveBot did not check them." },
    where: { pt: "(um Bot) › Escrito pelo Bot. O LuveBot não conferiu.", en: "(a Bot) › Written by the Bot. LuveBot did not check it." },
    note: NOT_REAL,
  },
  {
    id: "v03-skip-question", since: "v0.3",
    title: { pt: "Pular uma pergunta do Bot", en: "Skip a Bot's question" },
    what: { pt: "Quando o Bot pergunta algo que você não quer responder, clique em Pular e ele segue o trabalho sem a resposta.", en: "When a Bot asks something you would rather not answer, click Skip and it carries on without an answer." },
    where: { pt: "(um Bot) › O Bot está esperando a sua resposta › Pular", en: "(a Bot) › The Bot is waiting for your answer › Skip" },
  },
  {
    id: "v03-teach-skill", since: "v0.3",
    title: { pt: "Ensinar uma skill pela conversa", en: "Teach a skill from a chat" },
    what: { pt: "Transforme uma conversa que deu certo numa skill nova, que nasce desligada até você revisar o texto e ligar.", en: "Turn a chat that went well into a new skill, born switched off until you review the text and turn it on." },
    where: { pt: "(um Bot) › Mais ações desta mensagem › Salvar como skill", en: "(a Bot) › More actions for this message › Save as a skill" },
    note: NOT_REAL,
  },
  {
    id: "v03-edit-skill", since: "v0.3",
    title: { pt: "Editar uma skill existente", en: "Edit an existing skill" },
    what: { pt: "Abra o texto de uma skill, veja o que mudou antes de salvar e saiba se ela está ligada; só salva depois de você ler até o fim.", en: "Open a skill's text, see what changed before saving and know whether it is on; it only saves after you have read to the end." },
    where: { pt: "Perfil › Skills deste Bot › (uma skill) › Ver › Editar", en: "Profile › This Bot's skills › (a skill) › View › Edit" },
    note: { pt: "Só onde o servidor diz que a skill pode ser editada. Ainda não provado num Hermes de verdade.", en: "Only where the server says the skill can be edited. Not proven on a real Hermes yet." },
  },
  {
    id: "v03-routine-suggestions", since: "v0.3", go: "rotinas",
    title: { pt: "Sugestões de rotina do Hermes", en: "Routine suggestions from Hermes" },
    what: { pt: "Quando o Hermes propõe uma automação, ela aparece em Rotinas e em Hoje: você cria a rotina pausada, cria e inicia, ou dispensa.", en: "When Hermes proposes an automation it shows up in Routines and in Today: you create it paused, create and start it, or dismiss it." },
    where: { pt: "Rotinas e Agendamentos › Sugestão do Hermes", en: "Routines & Schedules › Suggestion from Hermes" },
    note: { pt: "Sem botão no menu: use Abrir ou ⌘K › Ver Rotinas.", en: "No menu button: use Open or ⌘K › View Routines." },
  },
  {
    id: "v03-own-image", since: "v0.3",
    title: { pt: "Foto própria para o Bot", en: "Your own picture for the Bot" },
    what: { pt: "Envie uma imagem, recorte num quadrado e use como rosto do Bot; a imagem é refeita no servidor, sem os dados escondidos do arquivo.", en: "Send an image, crop it to a square and use it as the Bot's face; the server redraws it, without the file's hidden data." },
    where: { pt: "Perfil › Identidade e instruções › 1. Identidade › Enviar imagem", en: "Profile › Identity and instructions › 1. Identity › Send an image" },
    note: NOT_REAL,
  },
  {
    id: "v03-voice-keys-off", since: "v0.3",
    title: { pt: "Desligar as chaves de voz", en: "Turn off the voice keys" },
    what: { pt: "Enquanto estiver ligado, o Hermes entrega ao navegador as chaves dos serviços de voz; este cartão desliga isso com um clique.", en: "While it is on, Hermes hands the voice services' keys to the browser; this card turns that off with one click." },
    where: { pt: "Perfil › Chaves de voz no navegador", en: "Profile › Voice keys in the browser" },
    note: { pt: "Só desliga. Para ligar de novo, use o Hermes.", en: "It only turns off. To turn it on again, use Hermes." },
  },
  {
    id: "v03-screen-in-words", since: "v0.3",
    title: { pt: "A aba Tela explica o que acontece", en: "The Screen tab says what is going on" },
    what: { pt: "Em vez de ficar em branco, a aba Tela diz por que não há tela, quem está no controle, se o link caiu ou se você só pode olhar.", en: "Instead of staying blank, the Screen tab says why there is no screen, who has control, whether the link dropped or you can only watch." },
    where: { pt: "(um Bot) › Painel de trabalho › Tela", en: "(a Bot) › Work panel › Screen" },
    note: { pt: "A tela ao vivo só existe em servidores Linux.", en: "The live screen only exists on Linux servers." },
  },
  {
    id: "v03-attach-hint", since: "v0.3",
    title: { pt: "Aviso ao anexar numa sala", en: "A hint when attaching in a room" },
    what: { pt: "Ao anexar um arquivo, uma linha calma diz o que cada Bot da sala consegue fazer com aquele tipo de arquivo; nunca bloqueia o envio.", en: "When you attach a file, a calm line says what each Bot in the room can do with that kind of file; it never blocks sending." },
    where: { pt: "Salas › (uma sala) › Anexar arquivo", en: "Rooms › (a room) › Attach a file" },
  },
  {
    id: "v03-notify-question", since: "v0.3", go: "config",
    title: { pt: "Aviso quando um Bot espera você", en: "Alert when a Bot waits for you" },
    what: { pt: "Receba uma notificação quando um Bot esperar você fora do navegador: uma pergunta, uma senha ou uma aprovação em outro canal.", en: "Get a notification when a Bot waits for you outside the browser: a question, a password or an approval in another channel." },
    where: { pt: "Configurações › Geral › Notificações", en: "Settings › General › Notifications" },
    note: { pt: "Marque “um Bot esperar uma resposta sua…”; precisa do app instalado e do servidor configurado.", en: "Tick “a Bot waits for an answer from you…”; it needs the installed app and the server set up." },
  },
  {
    id: "v03-steer-note", since: "v0.3",
    title: { pt: "A orientação que o Bot recebeu", en: "The guidance the Bot received" },
    what: { pt: "Quando você nega um pedido dando o motivo, o motivo vira uma nota dentro do turno do Bot, que aparece ao reabrir a conversa.", en: "When you deny a request and give a reason, it becomes a note inside the Bot's turn, shown when you reopen the conversation." },
    where: { pt: "(um Bot) › Orientação enviada ao Bot", en: "(a Bot) › Guidance sent to the Bot" },
    note: { pt: "Só na conversa direta, ao reabrir; vale também para tarefas do Kanban e Bots que delegam.", en: "Only in a direct chat, on reopening; also for Kanban tasks and Bots that delegate." },
  },

  // ---------------------------------------------------------------- v0.2
  {
    id: "v02-open-files", since: "v0.2",
    title: { pt: "Abrir imagens e páginas do Bot", en: "Open the Bot's images and pages" },
    what: { pt: "Abra imagens, SVG e páginas HTML dos arquivos do Bot sem baixar; as páginas abrem isoladas, sem scripts e sem nada da internet.", en: "Open images, SVG and HTML pages from the Bot's files without downloading; pages open isolated, with no scripts and no internet." },
    where: { pt: "(um Bot) › Painel de trabalho › Arquivos", en: "(a Bot) › Work panel › Files" },
    note: NOT_PHONE,
  },
  {
    id: "v02-room-files", since: "v0.2",
    title: { pt: "Arquivos na sala, nos dois sentidos", en: "Files in rooms, both ways" },
    what: { pt: "Mande arquivos para os Bots numa sala e receba na sala os arquivos que eles geram.", en: "Send files to the Bots in a room and receive in the room the files they make." },
    where: { pt: "Salas › (uma sala) › Anexar arquivo", en: "Rooms › (a room) › Attach a file" },
  },
  {
    id: "v02-pages", since: "v0.2",
    title: { pt: "Editor de páginas", en: "Page editor" },
    what: { pt: "Edite as páginas do Bot com barra de botões e atalhos; abrir e fechar uma página nunca muda um byte dela.", en: "Edit the Bot's pages with a toolbar and shortcuts; opening and closing a page never changes a byte of it." },
    where: { pt: "(um Bot) › Páginas", en: "(a Bot) › Pages" },
    note: NOT_PHONE,
  },
  {
    id: "v02-page-review", since: "v0.2",
    title: { pt: "Revisar antes de salvar", en: "Review before saving" },
    what: { pt: "Quando um Bot grava uma página, o LuveBot mostra o que ele quer gravar e só grava depois da sua aprovação.", en: "When a Bot writes a page, LuveBot shows what it wants to write and only writes after your approval." },
    where: { pt: "(um Bot) › Páginas › Revisar antes de salvar", en: "(a Bot) › Pages › Review before saving" },
    note: { pt: "Vale só para as ferramentas de arquivo do Hermes, não para o terminal.", en: "It covers Hermes's file tools only, not the terminal." },
  },
  {
    id: "v02-skills", since: "v0.2",
    title: { pt: "Skills de cada Bot", en: "Each Bot's skills" },
    what: { pt: "Veja e ligue ou desligue o que cada Bot sabe fazer, uma skill de cada vez.", en: "See and turn on or off what each Bot can do, one skill at a time." },
    where: { pt: "Perfil › Skills deste Bot", en: "Profile › This Bot's skills" },
  },
  {
    id: "v02-approval-wait", since: "v0.2",
    title: { pt: "Tempo para responder aprovações", en: "Time to answer approvals" },
    what: { pt: "Escolha quanto tempo um Bot espera pela sua resposta antes de o pedido ser negado, de 5 minutos a 4 horas.", en: "Choose how long a Bot waits for your answer before the request is denied, from 5 minutes to 4 hours." },
    where: { pt: "Perfil › Tempo para responder aprovações", en: "Profile › Time to answer approvals" },
  },
  {
    id: "v02-memory", since: "v0.2",
    title: { pt: "Memória editável", en: "Editable memory" },
    what: { pt: "Veja e edite, item por item, o que o Bot guardou na memória.", en: "See and edit, item by item, what the Bot has kept in memory." },
    where: { pt: "Perfil › Memória deste Bot", en: "Profile › This Bot's memory" },
  },
  {
    id: "v02-inactivity", since: "v0.2", go: "config",
    title: { pt: "Pausa por inatividade", en: "Pause when away" },
    what: { pt: "Pause as rotinas se ninguém abrir o LuveBot por alguns dias; isso nunca passa por cima de um teto de gasto.", en: "Pause routines if nobody opens LuveBot for some days; this never overrides a spending cap." },
    where: { pt: "Configurações › Geral › Pausa por inatividade", en: "Settings › General › Pause when away" },
    note: { pt: "Vem desligada e só pausa rotinas.", en: "It comes off, and it only pauses routines." },
  },
  {
    id: "v02-pin-order", since: "v0.2",
    title: { pt: "Fixar, ocultar e reordenar Bots", en: "Pin, hide and reorder Bots" },
    what: { pt: "Deixe a lista de Bots do seu jeito: fixe no topo, oculte ou mude a ordem.", en: "Arrange the list of Bots your way: pin to the top, hide or change the order." },
    where: { pt: "Bots › Opções de (um Bot) › Fixar no topo", en: "Bots › Options for (a Bot) › Pin to the top" },
  },
  {
    id: "v02-free-mode", since: "v0.2",
    title: { pt: "Modo Livre", en: "Free mode" },
    what: { pt: "Deixe um Bot trabalhar sem pedir: o LuveBot deixa de perguntar, mas as regras Bloquear e Devolver continuam parando o Bot.", en: "Let a Bot work without asking: LuveBot stops asking, but the Block and Handback rules still stop the Bot." },
    where: { pt: "Perfil › Aprovações › Livre: não pedir aprovação", en: "Profile › Approvals › Free: do not ask for approval" },
    note: { pt: "Os pedidos do próprio Hermes continuam valendo.", en: "Hermes's own requests still apply." },
  },
  {
    id: "v02-free-passes", since: "v0.2",
    title: { pt: "O que o modo Livre deixou passar", en: "What Free mode let through" },
    what: { pt: "Veja a lista do que um Bot fez sem pedir enquanto estava no modo Livre.", en: "See the list of what a Bot did without asking while it was in Free mode." },
    where: { pt: "Perfil › Executado sem pedir", en: "Profile › Run without asking" },
  },
  {
    id: "v02-rule-conditions", since: "v0.2", go: "regras",
    title: { pt: "Condições nas regras", en: "Conditions in rules" },
    what: { pt: "Faça uma regra valer só para um certo arquivo ou para quem recebe uma tarefa; cada regra avisa o que ela não consegue ver.", en: "Make a rule apply only to a certain file or to whoever receives a task; each rule warns what it cannot see." },
    where: { pt: "Configurações › Regras", en: "Settings › Rules" },
  },
  {
    id: "v02-rule-suggestions", since: "v0.2", go: "regras",
    title: { pt: "Sugestões de regra", en: "Rule suggestions" },
    what: { pt: "O LuveBot sugere regras a partir dos pedidos que você já aprovou, para você criar com um clique.", en: "LuveBot suggests rules from the requests you have already approved, for you to create in one click." },
    where: { pt: "Configurações › Regras › Sugestões de regra", en: "Settings › Rules › Rule suggestions" },
  },
  {
    id: "v02-simulator-hermes", since: "v0.2", go: "regras",
    title: { pt: "Simulador com o filtro do Hermes", en: "Simulator with Hermes's own filter" },
    what: { pt: "O simulador mostra também o que o filtro de comandos do próprio Hermes faria com um comando.", en: "The simulator also shows what Hermes's own command filter would do with a command." },
    where: { pt: "Configurações › Regras › Simulador", en: "Settings › Rules › Simulator" },
  },
  {
    id: "v02-voice", since: "v0.2",
    title: { pt: "Voz: Rádio e Chamada", en: "Voice: Radio and Call" },
    what: { pt: "Segure para falar (Rádio) ou converse em tempo real (Chamada); a voz nunca aprova nada.", en: "Hold to talk (Radio) or talk in real time (Call); voice never approves anything." },
    where: { pt: "(um Bot) › Rádio: segure para falar", en: "(a Bot) › Radio: hold to talk" },
    note: { pt: "A Chamada precisa de chave da OpenAI e conta no teto. Voz real ainda não provada.", en: "The Call needs an OpenAI key and counts on the cap. Real voice not proven yet." },
  },
  {
    id: "v02-threads", since: "v0.2",
    title: { pt: "Threads e reações", en: "Threads and reactions" },
    what: { pt: "Responda a uma mensagem numa conversa à parte e reaja com um emoji; a reação é uma por mensagem, para todos.", en: "Reply to a message in a side conversation and react with an emoji; a reaction is one per message, for everybody." },
    where: { pt: "(um Bot) › Responder em conversa", en: "(a Bot) › Reply in a thread" },
  },
  {
    id: "v02-research", since: "v0.2", go: "rotinas",
    title: { pt: "Pesquisa proativa", en: "Proactive research" },
    what: { pt: "Crie uma rotina de pesquisa que o Bot faz sozinho, só lendo a web, e traz o resumo para o histórico e para Hoje.", en: "Create a research routine the Bot does by itself, only reading the web, and brings the summary to the history and to Today." },
    where: { pt: "Rotinas e Agendamentos › Nova pesquisa", en: "Routines & Schedules › New research" },
    note: { pt: "Nasce pausada: você liga quando quiser.", en: "It is born paused: you turn it on when you want." },
  },
  {
    id: "v02-bot-suggestion", since: "v0.2",
    title: { pt: "Sugestão de Bot", en: "Bot suggestion" },
    what: { pt: "Quando um Bot sugere criar outro, a conversa mostra um cartão para você conferir o nome, o papel e o modelo e confirmar.", en: "When a Bot suggests creating another, the chat shows a card for you to check the name, role and model and confirm." },
    where: { pt: "(um Bot) › Sugestão: criar o Bot “(nome)”", en: "(a Bot) › Suggestion: create the Bot “(name)”" },
  },
  {
    id: "v02-timeline", since: "v0.2", go: "atividade",
    title: { pt: "Linha do tempo e horários", en: "Timeline and hours" },
    what: { pt: "Veja a atividade ao longo do dia numa linha do tempo e quais horários são os mais movimentados.", en: "See the activity over the day on a timeline and which hours are the busiest." },
    where: { pt: "Atividade › Linha do tempo", en: "Activity › Timeline" },
  },
  {
    id: "v02-push", since: "v0.2", go: "config",
    title: { pt: "Notificações no celular", en: "Phone notifications" },
    what: { pt: "Receba avisos no aparelho quando um Bot pedir algo; a tela de bloqueio nunca mostra o que ele quer fazer.", en: "Get alerts on your device when a Bot asks for something; the lock screen never shows what it wants to do." },
    where: { pt: "Configurações › Geral › Notificações", en: "Settings › General › Notifications" },
    note: { pt: "Precisa do app na Tela de Início. O teste chegou num iPhone de verdade; um pedido real ainda não.", en: "Needs the app on the Home Screen. The test reached a real iPhone; a real Bot request not yet." },
  },
  {
    id: "v02-needs-you-outside", since: "v0.2", go: "hoje",
    title: { pt: "Precisa de você, também fora do LuveBot", en: "Needs you, outside LuveBot too" },
    what: { pt: "Veja em Hoje o que um Bot espera de você em outro lugar, como uma pergunta feita num canal de mensagens.", en: "See in Today what a Bot is waiting on you for somewhere else, such as a question asked in a messaging channel." },
    where: { pt: "Hoje › Precisa de você", en: "Today › Needs you" },
  },
  {
    id: "v02-projection", since: "v0.2", go: "custos",
    title: { pt: "Projeção do gasto do mês", en: "Projected spending for the month" },
    what: { pt: "Veja quanto o mês deve custar se o ritmo de hoje continuar, no total e por Bot.", en: "See what the month should cost if today's pace continues, in total and per Bot." },
    where: { pt: "Configurações › Custos", en: "Settings › Costs" },
  },
  {
    id: "v02-plan-quota", since: "v0.2", go: "custos",
    title: { pt: "Cota do plano", en: "Plan quota" },
    what: { pt: "Veja quanto da cota do seu plano já foi usada, quando o Hermes informa.", en: "See how much of your plan's quota has been used, when Hermes reports it." },
    where: { pt: "Configurações › Custos › Cota do plano", en: "Settings › Costs › Plan quota" },
    note: { pt: "Só aparece quando o Hermes informa a cota.", en: "It only shows when Hermes reports the quota." },
  },
  {
    id: "v02-luve-studio", since: "v0.2",
    title: { pt: "Crie seu Luve", en: "Create your Luve" },
    what: { pt: "Monte o rosto do Bot num estúdio de quatro passos, com prévia em 3D, e baixe como imagem.", en: "Build the Bot's face in a four-step studio, with a 3D preview, and download it as an image." },
    where: { pt: "Perfil › Identidade e instruções › 1. Identidade › Criar seu Luve", en: "Profile › Identity and instructions › 1. Identity › Create your Luve" },
    note: NOT_PHONE,
  },
  {
    id: "v02-my-luve", since: "v0.2", go: "config",
    title: { pt: "Meu Luve", en: "My Luve" },
    what: { pt: "Escolha o rosto que representa você nas conversas.", en: "Choose the face that represents you in chats." },
    where: { pt: "Configurações › Geral › Meu Luve", en: "Settings › General › My Luve" },
  },

  // ---------------------------------------------------------------- v0.1
  {
    id: "v01-today", since: "v0.1", go: "hoje",
    title: { pt: "Hoje", en: "Today" },
    what: { pt: "Veja numa tela só o que precisa de você, o que está em andamento e o que já terminou.", en: "See on a single screen what needs you, what is in progress and what has finished." },
    where: { pt: "Hoje", en: "Today" },
  },
  {
    id: "v01-chat", since: "v0.1",
    title: { pt: "Conversar com um Bot", en: "Talk to a Bot" },
    what: { pt: "Escreva para um Bot e acompanhe a resposta e cada passo que ele dá, enquanto acontece.", en: "Write to a Bot and follow the answer and each step it takes, as it happens." },
    where: { pt: "Bots › (um Bot)", en: "Bots › (a Bot)" },
  },
  {
    id: "v01-create-bot", since: "v0.1",
    title: { pt: "Criar um Bot a partir de um modelo", en: "Create a Bot from a template" },
    what: { pt: "Escolha um modelo pronto e o Bot nasce com nome e apresentação, pronto para conversar.", en: "Pick a ready-made template and the Bot is born with a name and an introduction, ready to talk." },
    where: { pt: "Bots › Novo Bot", en: "Bots › New Bot" },
  },
  {
    id: "v01-approve-in-chat", since: "v0.1",
    title: { pt: "Aprovar sem sair da conversa", en: "Approve without leaving the chat" },
    what: { pt: "Quando um Bot pede para fazer algo sensível, o pedido aparece na conversa e você decide ali mesmo.", en: "When a Bot asks to do something sensitive, the request shows up in the chat and you decide right there." },
    where: { pt: "(um Bot) › Pedido de aprovação", en: "(a Bot) › Approval request" },
  },
  {
    id: "v01-work-panel", since: "v0.1",
    title: { pt: "Painel de trabalho", en: "Work panel" },
    what: { pt: "Veja ao vivo o que o Bot está fazendo: a atividade, o terminal e os arquivos dele.", en: "Watch live what the Bot is doing: its activity, its terminal and its files." },
    where: { pt: "(um Bot) › Painel de trabalho", en: "(a Bot) › Work panel" },
  },
  {
    id: "v01-approvals", since: "v0.1", go: "aprovacoes",
    title: { pt: "Caixa de aprovações", en: "Approval inbox" },
    what: { pt: "Decida num só lugar os pedidos dos Bots: permitir uma vez, negar dando o motivo, ou vários de uma vez.", en: "Decide the Bots' requests in one place: allow once, deny with a reason, or several at once." },
    where: { pt: "Aprovações", en: "Approvals" },
  },
  {
    id: "v01-rules", since: "v0.1", go: "regras",
    title: { pt: "Regras para os Bots", en: "Rules for your Bots" },
    what: { pt: "Defina o que cada Bot pode fazer, o que pede a sua aprovação e o que fica bloqueado; cada regra diz se vale de verdade.", en: "Set what each Bot may do, what asks for your approval and what is blocked; each rule says whether it really holds." },
    where: { pt: "Configurações › Regras", en: "Settings › Rules" },
  },
  {
    id: "v01-simulator", since: "v0.1", go: "regras",
    title: { pt: "Testar uma regra antes de ligar", en: "Test a rule before turning it on" },
    what: { pt: "Guarde a regra como rascunho e use o simulador para ver o que ela faria com um comando.", en: "Keep the rule as a draft and use the simulator to see what it would do with a command." },
    where: { pt: "Configurações › Regras › Simulador", en: "Settings › Rules › Simulator" },
  },
  {
    id: "v01-activity", since: "v0.1", go: "atividade",
    title: { pt: "Atividade em lista e em Kanban", en: "Activity as a list and a Kanban" },
    what: { pt: "Acompanhe tudo o que os Bots estão fazendo e já fizeram, numa lista ou num quadro Kanban.", en: "Follow everything the Bots are doing and have done, in a list or on a Kanban board." },
    where: { pt: "Atividade", en: "Activity" },
  },
  {
    id: "v01-routines", since: "v0.1", go: "rotinas",
    title: { pt: "Rotinas com histórico completo", en: "Routines with full history" },
    what: { pt: "Veja as tarefas que um Bot faz sozinho em horários marcados, com todo o histórico de cada uma.", en: "See the tasks a Bot does by itself at set times, with the full history of each." },
    where: { pt: "Rotinas e Agendamentos", en: "Routines & Schedules" },
  },
  {
    id: "v01-costs", since: "v0.1", go: "custos",
    title: { pt: "Custos com teto que pausa", en: "Costs with a cap that pauses" },
    what: { pt: "Acompanhe quanto cada Bot gasta e ponha um teto: ao chegar nele, o Bot é pausado de verdade.", en: "Follow how much each Bot spends and set a cap: when it reaches it, the Bot is really paused." },
    where: { pt: "Configurações › Custos", en: "Settings › Costs" },
  },
  {
    id: "v01-rooms", since: "v0.1",
    title: { pt: "Salas com vários Bots", en: "Rooms with several Bots" },
    what: { pt: "Converse com vários Bots numa sala, chame um deles com @ e passe tarefas de um para outro.", en: "Talk to several Bots in a room, call one with @ and hand tasks from one to another." },
    where: { pt: "Salas › Nova sala", en: "Rooms › New Room" },
  },
  {
    id: "v01-map", since: "v0.1", go: "mapa",
    title: { pt: "Mapa do time", en: "Team map" },
    what: { pt: "Veja os Bots e quem passou tarefa para quem, num desenho do time.", en: "See the Bots and who handed tasks to whom, in a drawing of the team." },
    where: { pt: "Mapa", en: "Team Map" },
  },
  {
    id: "v01-search", since: "v0.1",
    title: { pt: "Busca rápida (⌘K)", en: "Quick search (⌘K)" },
    what: { pt: "Aperte ⌘K (ou Ctrl+K) para achar Bots, salas, páginas, arquivos e rotinas sem sair do lugar.", en: "Press ⌘K (or Ctrl+K) to find Bots, rooms, pages, files and routines without leaving where you are." },
    where: { pt: "Buscar", en: "Search" },
  },
  {
    id: "v01-settings", since: "v0.1", go: "config",
    title: { pt: "Idioma e app instalável", en: "Language and installable app" },
    what: { pt: "Troque entre português e inglês e instale o LuveBot como um app no seu aparelho.", en: "Switch between Portuguese and English and install LuveBot as an app on your device." },
    where: { pt: "Configurações › Geral", en: "Settings › General" },
  },
  {
    id: "v01-screen", since: "v0.1",
    title: { pt: "Tela ao vivo (experimental)", en: "Live screen (experimental)" },
    what: { pt: "Veja a tela do computador do Bot e assuma o controle quando precisar.", en: "See the Bot's computer screen and take control when you need to." },
    where: { pt: "(um Bot) › Painel de trabalho › Tela", en: "(a Bot) › Work panel › Screen" },
    note: { pt: "Experimental. Só funciona em servidores Linux.", en: "Experimental. It only works on Linux servers." },
  },
];
