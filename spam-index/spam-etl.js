#!/usr/bin/env node
// ============================================================================
// spam-etl.js — Constrói o índice de tokens spam para o D1 (Taxesly).
// ----------------------------------------------------------------------------
// O que faz:
//   1. Lê as listas GoldRush "yes" (confirmadas) já clonadas em SRC_DIR.
//   2. Parseia cada linha "- <chain>/<addr>/<score>".
//   3. (Incremental) Compara com o snapshot da semana passada → só os NOVOS.
//   4. Gera ficheiros SQL em lotes (INSERT OR IGNORE, 500 linhas/instrução).
//   5. Escreve o novo snapshot para a próxima semana.
//
// Idempotente: INSERT OR IGNORE → re-correr nunca duplica nem rebenta.
// Memória: usa leitura linha-a-linha (readline), não carrega ficheiros inteiros.
// ============================================================================

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SRC_DIR      = process.env.SRC_DIR      || path.join(__dirname, 'goldrush', 'src', 'lists', 'erc20');
const OUT_DIR      = process.env.OUT_DIR      || path.join(__dirname, 'sql_out');
const SNAPSHOT_IN  = process.env.SNAPSHOT_IN  || path.join(__dirname, 'snapshot.txt');
const SNAPSHOT_OUT = process.env.SNAPSHOT_OUT || path.join(__dirname, 'snapshot.new.txt');
const SRC_NAME     = process.env.SRC_NAME     || 'goldrush';

const ROWS_PER_STATEMENT = 500;     // < 100 KB por instrução (limite D1)
const ROWS_PER_FILE      = 500000;  // ~17 ficheiros para 8.1M (robusto vs 1 ficheiro gigante)

// Ficheiros GoldRush "yes" (confirmados, score >= 20). NFTs ficam de fora de propósito.
const FILES = [
  'eth_mainnet_token_spam_contracts_yes.yaml',
  'base_mainnet_token_spam_contracts_yes.yaml',
  'bsc_mainnet_token_spam_contracts_yes_1.yaml',
  'bsc_mainnet_token_spam_contracts_yes_2.yaml',
  'pol_mainnet_token_spam_contracts_yes.yaml',
  'op_mainnet_token_spam_contracts_yes.yaml',
  'gnosis_mainnet_token_spam_contracts_yes.yaml',
];

// Linha de dados: "- <chainId>/<0x...40hex>/<score>"
const LINE_RE = /^-\s*(\d+)\/(0x[0-9a-fA-F]{40})\/(\d+)\s*$/;

function esc(s) { return String(s).replace(/'/g, "''"); }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) Carregar snapshot anterior (se existir) → Set de "chain:addr".
  const prev = new Set();
  if (fs.existsSync(SNAPSHOT_IN)) {
    const rl = readline.createInterface({ input: fs.createReadStream(SNAPSHOT_IN), crlfDelay: Infinity });
    for await (const line of rl) { const k = line.trim(); if (k) prev.add(k); }
  }
  const firstRun = prev.size === 0;
  console.log(`[etl] snapshot anterior: ${prev.size.toLocaleString()} chaves ${firstRun ? '(PRIMEIRA EXECUÇÃO — seed completo)' : ''}`);

  // 2) Ler as listas → mapa current: "chain:addr" -> {chain, addr, score}
  //    (mapa para deduplicar entre ficheiros; fica o score mais alto.)
  const current = new Map();
  let parsed = 0, skipped = 0;
  for (const fname of FILES) {
    const fpath = path.join(SRC_DIR, fname);
    if (!fs.existsSync(fpath)) { console.warn(`[etl] AVISO: ficheiro em falta ${fname}`); continue; }
    const rl = readline.createInterface({ input: fs.createReadStream(fpath), crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      const m = LINE_RE.exec(line);
      if (!m) { if (line && line[0] === '-') skipped++; continue; }
      const chain = parseInt(m[1], 10);
      const addr = m[2].toLowerCase();
      const score = parseInt(m[3], 10);
      const key = chain + ':' + addr;
      const ex = current.get(key);
      if (!ex || score > ex.score) current.set(key, { chain, addr, score });
      n++; parsed++;
    }
    console.log(`[etl]   ${fname}: ${n.toLocaleString()} entradas`);
  }
  console.log(`[etl] total parseado: ${parsed.toLocaleString()} | únicos: ${current.size.toLocaleString()} | linhas '-' ignoradas: ${skipped}`);

  // 3) Diferença → só os NOVOS desde a última semana.
  const toInsert = [];
  for (const [key, v] of current) { if (!prev.has(key)) toInsert.push(v); }
  console.log(`[etl] novos a inserir: ${toInsert.length.toLocaleString()}`);

  // 4) Gerar SQL em lotes/ficheiros.
  let fileIdx = 0, rowInFile = 0, out = null, statements = 0;
  function openFile() {
    fileIdx++;
    const p = path.join(OUT_DIR, `seed_${String(fileIdx).padStart(3, '0')}.sql`);
    out = fs.createWriteStream(p);
    out.write('PRAGMA defer_foreign_keys = true;\n');
    rowInFile = 0;
    return p;
  }
  if (toInsert.length > 0) openFile();
  for (let i = 0; i < toInsert.length; i += ROWS_PER_STATEMENT) {
    if (rowInFile >= ROWS_PER_FILE) { out.end(); openFile(); }
    const batch = toInsert.slice(i, i + ROWS_PER_STATEMENT);
    const values = batch.map(v => `(${v.chain},'${esc(v.addr)}',${v.score},'${SRC_NAME}')`).join(',');
    out.write(`INSERT OR IGNORE INTO spam (chain,addr,score,src) VALUES ${values};\n`);
    rowInFile += batch.length;
    statements++;
  }
  if (out) out.end();
  console.log(`[etl] gerados ${fileIdx} ficheiro(s) SQL, ${statements.toLocaleString()} instruções em ${OUT_DIR}`);

  // 5) Escrever novo snapshot (todas as chaves atuais) para a próxima semana.
  const snap = fs.createWriteStream(SNAPSHOT_OUT);
  for (const key of current.keys()) snap.write(key + '\n');
  snap.end();
  await new Promise(r => snap.on('finish', r));
  console.log(`[etl] snapshot novo: ${current.size.toLocaleString()} chaves -> ${SNAPSHOT_OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
