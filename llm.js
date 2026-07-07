// Interprete le langage naturel (transcrit par Web Speech API) via le LLM auto-heberge
// sur le serveur "Charras" (Ollama, cf. home-infra/charras/README.md), servi en HTTPS via
// `tailscale funnel` + un reverse-proxy nginx qui expose Ollama sous /llm/ (meme origine que
// la page -- evite le mixed-content HTTPS->HTTP et le CORS). Voir home-infra/charras/SETUP.md.
// Le reverse-proxy exige un header X-Api-Key (cf. `apiKey`) pour ecarter les scanners/bots qui
// tomberaient sur le sous-domaine *.ts.net public -- pas une vraie authentification, juste un
// filtre contre l'abus opportuniste (le pilotage du robot passe par le Bluetooth du telephone,
// pas par ce serveur, donc le risque reel ici est la conso GPU, pas le robot).
//
// Utilise l'API NATIVE Ollama (/api/chat), pas l'endpoint compatible OpenAI (/v1/chat/completions) :
// bug Ollama connu (issue #15293, toujours ouverte en 2026-07) ou `think` n'est pas transmis a Gemma 4
// via l'endpoint OpenAI-compatible -- on brulait donc 200 tokens de "reflexion" invisible sans jamais
// pouvoir la desactiver. Via /api/chat, `think:false` fonctionne reellement.

const SYSTEM_PROMPT = `Tu pilotes un robot lance-balles de ping-pong (Butterfly Amicus) pendant que l'utilisateur joue.
Il te parle en langage naturel, les mains occupees : il ne peut pas taper ni cliquer, seulement parler et ecouter.
Une seule phrase peut contenir PLUSIEURS demandes a la fois (ex: "remets au milieu et ralentis et relance") --
tu dois alors renvoyer PLUSIEURS actions dans l'ordre, pas en choisir une seule.

Chaque action de la liste "actions" est un objet avec ces champs :
- "action": un des types ci-dessous
- "shot_type": null | "forehand" (coup droit) | "backhand" (revers) -- uniquement pour "shot"
- "zone": null | "left" | "right" | "center" -- uniquement pour "shot"
- "positions": null | liste de {"shot_type":..., "zone":...} -- uniquement pour "pattern"

Types d'action :
- "increase_speed" / "decrease_speed" : changer la frequence des balles (balles par minute). Par defaut,
  "plus vite" / "moins vite" SANS autre precision concerne la frequence, pas la vitesse de balle -- ne demande
  PAS de clarification pour cette phrase simple, applique directement l'action.
- "stop" : arreter immediatement le lancer de balles.
- "resume" : relancer l'exercice en cours (une seule balle/position, sans changer la config actuelle).
- "shot" : envoyer des balles a un endroit precis. Pour "backhand", zone = "left"|"right"|"center" est
  obligatoire. Pour "forehand", zone reste null. Si l'utilisateur demande a la fois de repositionner ET
  de (re)lancer (ex: "active le lanceur et au milieu"), renvoie DEUX actions : un "shot" pour la position
  puis un "resume" pour relancer -- ne mets jamais zone/shot_type sur l'action "resume" elle-meme.
- "pattern" : l'utilisateur veut un exercice qui ALTERNE entre plusieurs positions en boucle (ex: "une
  balle a gauche, une a droite", "un exercice avec coup droit puis revers au centre"). Remplis
  "positions" avec la sequence de {"shot_type","zone"} demandee (2 a 10 positions), laisse "shot_type"/
  "zone" a null au niveau de l'action elle-meme.
- "clarify" : si la demande est vraiment ambigue (ex: revers sans zone precisee, ou une phrase qui suggere
  explicitement la vitesse de la balle plutot que la frequence, ou toute demande hors de ces actions),
  renvoie une SEULE action "clarify" (rien d'autre dans la liste) et pose UNE question courte et precise
  en francais dans "question" (au niveau racine, pas dans l'action). N'invente pas de choix par defaut ici.
- "none" : la phrase n'est pas une commande pour le robot (bruit, conversation hors-sujet) ; liste vide.

Reponds TOUJOURS avec un unique objet JSON, sans balises markdown ni texte autour, exactement de cette forme :
{"actions": [{"action": "increase_speed|decrease_speed|stop|resume|shot|pattern|clarify|none", "shot_type": null|"forehand"|"backhand", "zone": null|"left"|"right"|"center", "positions": null|[{"shot_type":...,"zone":...}]}], "question": null|"...", "say": "courte confirmation orale en francais pour l'ensemble, ou vide"}

Ne fais AUCUN raisonnement ni brouillon avant de repondre : produis directement et immediatement le JSON final,
sans etapes intermediaires. La reponse doit tenir en une seule ligne courte.`;

// Fenetre glissante plutot qu'un historique illimite ou une remise a zero systematique : garde assez
// d'echanges recents pour des suivis en langage naturel ("moins vite" -> "encore un peu" -> "encore un
// peu plus" sans repeter "vitesse" a chaque fois), mais borne la taille du prompt (on a vu prompt_tokens
// grimper de 534 a 1017 sur une seule session sans ca) et finit par evacuer une remarque hors-sujet
// captee par erreur plutot que de la trainer indefiniment.
const MAX_HISTORY_MESSAGES = 8; // ~4 echanges (user+assistant)

export class LlmInterpreter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl - ex: "/llm" (chemin relatif, reverse-proxy nginx vers Ollama sur Charras)
   * @param {string} opts.model - ex: "gemma4:12b" (cf. home-infra/charras/README.md)
   * @param {string} opts.apiKey - cle attendue par le reverse-proxy (header X-Api-Key), saisie par l'utilisateur
   */
  constructor({ baseUrl, model, apiKey }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.history = [];
  }

  reset() {
    this.history = [];
  }

  /**
   * @param {string} transcript - texte transcrit par la reconnaissance vocale
   * @returns {Promise<{actions: Array<{action:string, shot_type:?string, zone:?string, positions:?Array<{shot_type:?string,zone:?string}>}>, question:?string, say:string}>}
   *   `actions` peut contenir plusieurs entrees (phrase composee, ex: "remets au milieu et relance").
   *   Si une entree a action="clarify", c'est la SEULE entree de la liste et `question` est rempli.
   */
  async interpret(transcript) {
    this.history.push({ role: 'user', content: transcript });
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history];
    const requestBody = {
      model: this.model,
      messages,
      stream: false, // l'API native Ollama streame par defaut ; on veut une reponse JSON unique
      format: 'json', // equivalent natif de response_format:{type:'json_object'} cote OpenAI-compatible
      think: false, // ici transmis correctement (contrairement a /v1/chat/completions, cf. note plus haut)
      options: {
        temperature: 0.1,
        // Plafond dur : sans ca, on a vu le modele partir dans 3600+ tokens de "reflexion" invisible
        // (content final vide) en epuisant toute la fenetre de contexte -- 83s pour rien. Notre JSON
        // ne devrait jamais depasser ~60 tokens ; 200 laisse une marge sans permettre un emballement.
        num_predict: 200,
      },
    };
    console.log('[LLM] requete ->', `${this.baseUrl}/api/chat`, requestBody);
    const t0 = performance.now();

    // Sans timeout, un Ollama qui charge le modele a froid (ou plante) fait attendre indefiniment
    // sans jamais remonter d'erreur -- d'ou l'impression de "ne repond pas du tout".
    const TIMEOUT_MS = 45_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`[LLM] timeout apres ${TIMEOUT_MS}ms sans reponse`);
        throw new Error(
          `Le LLM (${this.baseUrl}) n'a pas repondu en ${TIMEOUT_MS / 1000}s. ` +
            `Peut-etre un chargement a froid du modele sur Charras (OLLAMA_KEEP_ALIVE) -- reessaie, ` +
            `ou verifie l'etat du conteneur Ollama.`
        );
      }
      console.log('[LLM] fetch a echoue (reseau):', err);
      throw new Error(
        `Impossible de joindre le serveur LLM (${this.baseUrl}). ` +
          `Verifie qu'Ollama tourne sur Charras et que le reverse-proxy nginx est up. Detail: ${err.message}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
    const t1 = performance.now();
    console.log(`[LLM] entetes recues apres ${(t1 - t0).toFixed(0)}ms, status:`, res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.log('[LLM] corps erreur:', errText);
      throw new Error(`LLM HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const t2 = performance.now();
    console.log(
      `[LLM] reponse complete apres ${(t2 - t0).toFixed(0)}ms (corps recu en ${(t2 - t1).toFixed(0)}ms)`
    );
    // Format natif Ollama : prompt_eval_count/eval_count (pas usage.*), message direct (pas choices[0]).
    console.log('[LLM] tokens (prompt/completion):', data.prompt_eval_count, data.eval_count);
    console.log('[LLM] reponse brute JSON:', data);
    const content = data.message?.content ?? '';
    if (data.message?.thinking) console.log('[LLM] contenu "thinking" (devrait etre vide/absent):', data.message.thinking);
    console.log('[LLM] contenu du message assistant:', content);
    this.history.push({ role: 'assistant', content });
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.log('[LLM] echec du parsing JSON du contenu:', err);
      // Le modele n'a pas respecte le format JSON (ex: max_tokens atteint sans jamais produire le
      // JSON final, content vide) : on degrade sans planter, mais il faut quand meme un retour oral
      // -- sinon l'utilisateur ne sait pas si sa commande a ete comprise ou totalement perdue.
      return {
        actions: [],
        question: null,
        say: content.trim() || "Desole, je n'ai pas compris.",
      };
    }
    console.log('[LLM] JSON parse:', parsed);
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
    return {
      actions: actions.map((a) => ({
        action: a.action ?? 'none',
        shot_type: a.shot_type ?? null,
        zone: a.zone ?? null,
        positions: Array.isArray(a.positions)
          ? a.positions.map((p) => ({ shot_type: p.shot_type ?? null, zone: p.zone ?? null }))
          : null,
      })),
      question: parsed.question ?? null,
      say: parsed.say ?? '',
    };
  }
}
