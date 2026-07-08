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
- "parameter": null | "cadence" | "ball_speed" | "trajectory" | "spin" | "side_spin" -- uniquement pour "adjust"
- "direction": null | "increase" | "decrease" -- uniquement pour "adjust"
- "magnitude": null | "small" | "normal" | "large" -- uniquement pour "adjust" (defaut "normal")
- "shot_type": null | "forehand" (coup droit) | "backhand" (revers) -- uniquement pour "shot"
- "zone": null | "left" | "right" | "center" -- uniquement pour "shot"
- "positions": null | liste de {"shot_type":..., "zone":...} -- uniquement pour "pattern"

Types d'action :
- "adjust" : regler UN parametre continu du robot par crans relatifs (jamais de valeur absolue). Choisis
  "parameter" et "direction" ("increase" = plus, "decrease" = moins, le long de l'axe naturel du parametre),
  et "magnitude" ("small" pour "un peu"/"legerement", "large" pour "beaucoup", sinon "normal") :
  * "cadence" : le RYTHME (nombre de balles par minute). C'est le defaut de TOUT mot de tempo --
    "plus vite"/"moins vite", "plus/moins rapide", "plus lent", "plus souvent", "plus de balles",
    "change le rythme/la frequence" -- MEME suivi de "les balles" ("moins vite les balles" = cadence).
    Applique-le directement, NE demande PAS de clarification. (La vitesse de la balle elle-meme se dit
    autrement : voir ball_speed.)
  * "ball_speed" : la PUISSANCE/force de frappe de la balle, ET sa PROFONDEUR -- sur ce robot c'est la
    puissance qui determine a quelle distance la balle retombe (pas de reglage "profondeur" separe).
    Reserve-le aux mots de FORCE ou de DISTANCE : "frappe plus fort", "plus puissant", "tape plus fort",
    "plus loin"/"moins loin", "plus profond"/"trop court"/"trop long" -> "ball_speed". "moins loin"/
    "trop long" = direction "decrease". (Un simple "plus vite" SANS notion de force = cadence, pas ca.)
  * "trajectory" : la HAUTEUR / l'angle de l'arc. "plus haut"/"plus bas", "plus d'angle", "passe plus
    haut au-dessus du filet", "trajectoire plus haute/basse" -> "trajectory". "plus haut" = "increase".
  * "spin" : l'effet avant/arriere. "increase" = plus de TOPSPIN/lifte ; "decrease" = plus de COUPE/
    backspin/chope. ("mets du lifte" -> increase ; "coupe la balle"/"backspin" -> decrease.)
  * "side_spin" : l'effet LATERAL (rotation laterale de la balle), UNIQUEMENT si l'utilisateur parle
    explicitement d'EFFET/de rotation sur le cote ("mets de l'effet a droite", "brosse la balle sur le
    cote", "effet lateral", "fais-la tourner vers la gauche"). "increase" = vers la droite, "decrease"
    = vers la gauche. ATTENTION : un simple mot de POSITION n'est PAS du side_spin. En particulier
    "de cote", "sur le cote", "un peu plus de cote", "plus sur le cote", "decale un peu" designent un
    PLACEMENT gauche/droite, PAS un effet : comme ils ne precisent pas gauche OU droite, ils sont
    AMBIGUS -> renvoie "clarify" et demande "a gauche ou a droite ?". Ne choisis side_spin QUE si le mot
    "effet", "rotation", "tourne", "brosse" (ou "sidespin") est present.
- "stop" : arreter immediatement le lancer de balles.
- "resume" : relancer l'exercice en cours (une seule balle/position, sans changer la config actuelle).
- "shot" : envoyer des balles a un endroit precis. "coup droit"=forehand, "revers"=backhand : ce sont
  les deux COTES opposes de la table, ils se suffisent a eux-memes. La "zone" (left/right/center) est
  OPTIONNELLE et ne sert QUE si l'utilisateur precise explicitement OU (ex: "un revers a gauche",
  "coup droit au milieu") -- sinon laisse zone=null. N'INVENTE JAMAIS "center" (ni une autre zone) pour
  un "revers"/"coup droit" simple : "revers" seul = {shot_type:"backhand", zone:null}, "coup droit" seul
  = {shot_type:"forehand", zone:null}. Si l'utilisateur demande a la fois de repositionner ET de (re)lancer
  (ex: "active le lanceur et au milieu"), renvoie DEUX actions : un "shot" pour la position puis un
  "resume" pour relancer -- ne mets jamais zone/shot_type sur l'action "resume" elle-meme.
  IMPORTANT : une reponse directionnelle breve -- "a gauche", "a droite", "au milieu", "plutot a gauche"
  -- surtout en REPONSE a une question de placement que tu viens de poser, est un PLACEMENT : renvoie
  "shot" (shot_type "backhand", zone correspondante), JAMAIS un side_spin (qui exige un mot d'effet).
- "pattern" : l'utilisateur veut un exercice qui ALTERNE entre plusieurs positions en boucle (ex: "une
  balle a gauche, une a droite", "alternance coup droit / revers"). Remplis "positions" avec la sequence
  de {"shot_type","zone"} demandee (2 a 10 positions) -- pour "alternance coup droit et revers" c'est
  [{"shot_type":"forehand","zone":null},{"shot_type":"backhand","zone":null}], SANS inventer de zone.
  Laisse "shot_type"/"zone" a null au niveau de l'action elle-meme.
- "clarify" : si la demande est vraiment ambigue (ex: "change l'effet" sans dire lequel, une position
  "de cote" sans gauche/droite, ou toute demande hors de ces actions), renvoie une SEULE action "clarify"
  (rien d'autre
  dans la liste) et pose UNE question courte et precise en francais dans "question" (au niveau racine, pas
  dans l'action). N'invente pas de choix par defaut ici. Mais NE clarifie PAS ce que tu peux mapper via
  "adjust" (hauteur, vitesse/distance, effet) : produis directement l'action.
- "report" : l'utilisateur DEMANDE les reglages actuels (il ne veut rien changer), ex: "on est a
  combien de balles par minute ?", "c'est quoi la vitesse la ?", "quels sont les reglages ?", "on en
  est ou ?". Renvoie une action "report" ; "parameter" cible un reglage precis (cadence|ball_speed|
  spin|side_spin|trajectory) ou reste null pour un resume general. Laisse "say" VIDE : l'app remplira
  la reponse chiffree elle-meme (toi tu ne connais pas les valeurs courantes).
- "none" : la phrase n'est pas une commande pour le robot (bruit, conversation hors-sujet) ; liste vide.

Une phrase peut combiner plusieurs "adjust" (ex: "envoie plus haut et moins loin" -> un adjust
trajectory/increase ET un adjust ball_speed/decrease). Renvoie-les tous, dans l'ordre.

REGLE PRIORITAIRE (elle l'emporte sur tout le reste) : les mots "gauche", "droite", "milieu", "centre"
designent une POSITION sur la table -> action "shot" (shot_type "backhand", zone left/right/center).
Ils ne declenchent JAMAIS un side_spin. Le side_spin n'existe que si le mot "effet"/"rotation"/"tourne"/
"brosse" est explicitement present. Donc une reponse comme "a gauche" (surtout apres ta question
"a gauche ou a droite ?") = shot zone "left", jamais side_spin.

Reponds TOUJOURS avec un unique objet JSON, sans balises markdown ni texte autour, exactement de cette forme :
{"actions": [{"action": "adjust|stop|resume|shot|pattern|report|clarify|none", "parameter": null|"cadence"|"ball_speed"|"trajectory"|"spin"|"side_spin", "direction": null|"increase"|"decrease", "magnitude": null|"small"|"normal"|"large", "shot_type": null|"forehand"|"backhand", "zone": null|"left"|"right"|"center", "positions": null|[{"shot_type":...,"zone":...}]}], "question": null|"...", "say": "courte confirmation orale en francais pour l'ensemble, ou vide"}

Ne fais AUCUN raisonnement ni brouillon avant de repondre : produis directement et immediatement le JSON final,
sans etapes intermediaires. La reponse doit tenir en une seule ligne courte.`;

// Fenetre glissante plutot qu'un historique illimite ou une remise a zero systematique : garde assez
// d'echanges recents pour des suivis en langage naturel ("moins vite" -> "encore un peu" -> "encore un
// peu plus" sans repeter "vitesse" a chaque fois), mais borne la taille du prompt (on a vu prompt_tokens
// grimper de 534 a 1017 sur une seule session sans ca) et finit par evacuer une remarque hors-sujet
// captee par erreur plutot que de la trainer indefiniment.
const MAX_HISTORY_MESSAGES = 8; // ~4 echanges (user+assistant)

// Ollama decharge le modele de la VRAM apres ~5 min d'inactivite (OLLAMA_KEEP_ALIVE par defaut) -> le
// 1er appel d'une session doit le recharger a froid (plusieurs secondes, parfois "Failed to fetch").
// On envoie keep_alive sur chaque requete pour qu'il reste resident toute la session, et on precharge
// le modele a l'ouverture de l'ecoute (cf. warmup()).
const KEEP_ALIVE = '30m';

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
   * Precharge le modele en VRAM cote Ollama (messages vides = "load only", cf. API Ollama) pour eviter
   * le rechargement a froid du 1er vrai appel. Non bloquant : a appeler des l'ouverture de l'ecoute,
   * le modele est pret le temps que l'utilisateur se mette en place.
   */
  async warmup() {
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}) },
        body: JSON.stringify({ model: this.model, messages: [], stream: false, keep_alive: KEEP_ALIVE }),
      });
      console.log('[LLM] warmup status', res.status);
      return res.ok;
    } catch (err) {
      console.log('[LLM] warmup echoue (non bloquant):', err);
      return false;
    }
  }

  /**
   * @param {string} transcript - texte transcrit par la reconnaissance vocale
   * @returns {Promise<{actions: Array<{action:string, parameter:?string, direction:?string, magnitude:?string, shot_type:?string, zone:?string, positions:?Array<{shot_type:?string,zone:?string}>}>, question:?string, say:string}>}
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
      keep_alive: KEEP_ALIVE, // garde le modele en VRAM toute la session (pas de rechargement a froid)
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
        // X-Api-Key seulement s'il est defini : en prod le reverse-proxy l'exige, mais le harnais
        // d'eval tape Ollama en direct (sans cle) et un header a `undefined` ferait planter fetch.
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}) },
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
        parameter: a.parameter ?? null,
        direction: a.direction ?? null,
        magnitude: a.magnitude ?? null,
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
