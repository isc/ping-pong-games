#!/usr/bin/env node
// Harnais d'eval : rejoue des transcripts reels contre le vrai LLM (Charras/Ollama) et verifie que
// l'interpretation produit les actions attendues. Sert a valider les changements de prompt/schema
// sans avoir a retester a la main au micro a chaque fois.
//
// Usage:
//   node evals/run.mjs
//   LLM_BASE_URL=http://192.168.1.50:11434 LLM_MODEL=gemma4:12b node evals/run.mjs
//   node evals/run.mjs --filter "pattern"   # ne lance que les cas dont le nom contient "pattern"

import { LlmInterpreter } from '../llm.js';
import { CASES } from './cases.mjs';

const BASE_URL = process.env.LLM_BASE_URL || 'http://100.72.204.126:11434';
const MODEL = process.env.LLM_MODEL || 'gemma4:12b';
const filterArg = process.argv.indexOf('--filter');
const filter = filterArg !== -1 ? process.argv[filterArg + 1] : null;

// Les logs [LLM]/[STT] de llm.js sont utiles en debug navigateur mais polluent la sortie ici --
// on les coupe pendant l'eval, sauf si EVAL_VERBOSE=1.
const realConsoleLog = console.log;
if (!process.env.EVAL_VERBOSE) {
  console.log = () => {};
}

async function runCase(testCase) {
  const llm = new LlmInterpreter({ baseUrl: BASE_URL, model: MODEL });
  const results = [];
  const t0 = Date.now();
  for (const transcript of testCase.turns) {
    results.push(await llm.interpret(transcript));
  }
  const elapsedMs = Date.now() - t0;
  testCase.expect(results);
  return { results, elapsedMs };
}

async function main() {
  const cases = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;
  realConsoleLog(`Serveur LLM: ${BASE_URL}  Modele: ${MODEL}  Cas: ${cases.length}/${CASES.length}\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const testCase of cases) {
    process.stdout.write(`  ${testCase.name} ... `);
    try {
      const { results, elapsedMs } = await runCase(testCase);
      realConsoleLog(`OK (${elapsedMs}ms)`);
      passed++;
    } catch (err) {
      realConsoleLog(`ECHEC`);
      failed++;
      failures.push({ name: testCase.name, err });
    }
  }

  realConsoleLog(`\n${passed}/${cases.length} reussis, ${failed} echecs\n`);

  if (failures.length) {
    realConsoleLog('Details des echecs :\n');
    for (const { name, err } of failures) {
      realConsoleLog(`--- ${name} ---`);
      realConsoleLog(err.message);
      realConsoleLog('');
    }
  }

  console.log = realConsoleLog;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.log = realConsoleLog;
  realConsoleLog('Erreur fatale dans le harnais:', err);
  process.exit(1);
});
