// Cas de test derives des vrais transcripts de la session avec Charly (2026-07-06, cf. conversation).
// Chaque cas est une sequence de "turns" (une seule LlmInterpreter partagee sur toute la sequence,
// pour couvrir les enchainements multi-tours comme clarify -> reponse). `expect` recoit le tableau
// des resultats (un par turn, meme forme que ce que renvoie LlmInterpreter#interpret) et doit lever
// une exception (via assert) si le comportement n'est pas celui attendu.

import assert from 'node:assert/strict';

function actionTypes(result) {
  return result.actions.map((a) => a.action);
}

export const CASES = [
  {
    name: 'resume simple',
    turns: ["allez go tu peux envoyer des balles"],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['resume']);
    },
  },
  {
    name: 'stop simple',
    turns: ['arrête le lanceur de balle'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['stop']);
    },
  },
  {
    name: 'stop (formulation alternative)',
    turns: ['non j\'ai dit stop'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['stop']);
    },
  },
  {
    name: 'ralentir simple',
    turns: ['moins vite les balles'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['decrease_speed']);
    },
  },
  {
    name: 'accelerer simple',
    turns: ['plus vite'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['increase_speed']);
    },
  },
  {
    name: 'zone seule et ambigue -> clarify',
    turns: ['un peu plus de côté les balles'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['clarify']);
      assert.ok(r.question && r.question.length > 0, 'question de clarification attendue');
    },
  },
  {
    name: '"de côté" seul -> clarify',
    turns: ['de côté'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['clarify']);
    },
  },
  {
    name: 'clarify puis reponse (gauche) -> shot backhand left',
    turns: ['un peu plus de côté les balles', 'à gauche'],
    expect([, r2]) {
      assert.deepEqual(actionTypes(r2), ['shot']);
      assert.equal(r2.actions[0].zone, 'left');
    },
  },
  {
    name: 'exercice alternance gauche/droite explicite -> pattern (pas clarify)',
    turns: ['il faut que tu fasses un exercice avec une balle à gauche une balle à droite'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['pattern']);
      const positions = r.actions[0].positions;
      assert.ok(Array.isArray(positions) && positions.length === 2, 'attendu 2 positions');
      const zones = positions.map((p) => p.zone);
      assert.ok(zones.includes('left') && zones.includes('right'), 'attendu gauche + droite');
    },
  },
  {
    name: 'une de chaque cote (gauche puis droite) -> pattern',
    turns: ['une de chaque côté à gauche puis à droite'],
    expect([r]) {
      assert.deepEqual(actionTypes(r), ['pattern']);
      const positions = r.actions[0].positions;
      assert.ok(Array.isArray(positions) && positions.length >= 2, 'attendu au moins 2 positions');
    },
  },
  {
    name: 'commande composee (recentrer + ralentir + relancer) -> 3 actions',
    turns: ['on remet les balles au milieu et ralenti la cadence des balles et relance le lanceur'],
    expect([r]) {
      const types = actionTypes(r);
      assert.ok(types.includes('shot'), 'attendu une action shot (recentrage)');
      assert.ok(types.includes('decrease_speed'), 'attendu une action decrease_speed');
      assert.ok(types.includes('resume'), 'attendu une action resume');
      const shotAction = r.actions.find((a) => a.action === 'shot');
      assert.equal(shotAction.zone, 'center');
    },
  },
  {
    name: 'commande composee (activer + centrer) -> shot(center) puis resume',
    turns: ['bah oui mais vas-y active le lanceur et au milieu'],
    expect([r]) {
      const types = actionTypes(r);
      assert.ok(types.includes('resume'), 'attendu une action resume');
      assert.ok(types.includes('shot'), 'attendu une action shot (centrage)');
      const shotAction = r.actions.find((a) => a.action === 'shot');
      assert.equal(shotAction.zone, 'center');
      // le "resume" ne doit jamais porter de zone/shot_type (cf. system prompt)
      const resumeAction = r.actions.find((a) => a.action === 'resume');
      assert.equal(resumeAction.zone, null);
    },
  },
  {
    name: 'tir au centre sans shot_type explicite (bug historique: retombait sur forehand)',
    turns: ['si tu as pas au centre là'],
    expect([r]) {
      // Le point important: si une action "shot" est produite, sa zone doit etre "center", pas null
      // avec un shot_type qui ferait retomber sur forehand cote app.js (cf. bug corrige 2026-07-06).
      const shotAction = r.actions.find((a) => a.action === 'shot');
      if (shotAction) assert.equal(shotAction.zone, 'center');
    },
  },
  {
    name: 'bruit de fond hors-sujet -> none (pas de crash, pas de fausse commande)',
    turns: ['mais papa ça fait gentil mais ça'],
    expect([r]) {
      // Liste vide ou [{action:'none'}] sont equivalents a l'execution (app.js ne fait rien dans
      // les deux cas) -- seul compte l'absence de toute action "reelle" (commande au robot).
      const real = actionTypes(r).filter((t) => t !== 'none');
      assert.deepEqual(real, []);
    },
  },
  {
    name: 'coup droit simple sans zone -> shot forehand',
    turns: ["j'aimerais que tu envoies les balles tout droit donc au milieu tout droit"],
    expect([r]) {
      const types = actionTypes(r);
      assert.ok(types.includes('shot'));
    },
  },
];
