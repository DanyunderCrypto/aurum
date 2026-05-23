// ════════════════════════════════════════════════════════════════
// AURUM — Fiscal Engine E2E Test Suite
// Validates FIFO, regime (G/G1), permuta, lending, spam, gas, airdrops
// against controlled scenarios with known expected outcomes.
//
// Run: node test_fiscal_e2e.js
// The engine is extracted from index.html lines 6115-6862 (the fifoEngine IIFE).
// ════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// Extract the engine IIFE from index.html
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('const fifoEngine = (() => {');
const endMarker = 'window.aurumFifoEngine = fifoEngine;';
const end = html.indexOf(endMarker);
if (start < 0 || end < 0) { console.error('Could not locate engine in index.html'); process.exit(1); }
let engineSrc = html.slice(start, end);

// Evaluate the engine in a sandbox. It only needs standard JS — no DOM, no fetch.
const fifoEngine = eval(engineSrc + '\nfifoEngine;');

// ── Test helpers ────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function approx(a, b, tol = 0.01) { return Math.abs(a - b) <= tol; }
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ❌ ' + msg); }
}
function ts(dateStr) { return Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000); }
// Build an event with sensible defaults
function ev(o) {
  return Object.assign({
    id: Math.random().toString(36).slice(2),
    txHash: '0x' + Math.random().toString(16).slice(2, 10),
    chain: 'eth', walletAddress: '0xtest',
    direction: 'in', amount: 0, asset: 'ETH',
    type: 'receive', txType: 'receive',
    date: '2024-01-01', timestamp: ts('2024-01-01'),
    priceEUR: null, category: 'external',
  }, o);
}
function run(name, fn) {
  console.log('\n▸ ' + name);
  try { fn(); } catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  ❌ threw: ' + e.message); }
}

// ════════════════════════════════════════════════════════════════
// SCENARIO 1: Simple buy then sell — short-term gain (Anexo G)
// ════════════════════════════════════════════════════════════════
run('S1: Buy 1 ETH @€1000, sell @€1500 within 365d → G gain €500', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 1500, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w1' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(approx(disp[0].proceedsEUR, 1500), `proceeds: ${disp[0].proceedsEUR}`);
    assert(approx(disp[0].basisEUR, 1000), `basis: ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 500), `gain: ${disp[0].gainEUR}`);
    assert(disp[0].anexoG && approx(disp[0].anexoG.gain, 500), `should be Anexo G (short-term)`);
  }
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 2: Long-term hold > 365d → G1 (exempt, declarative)
// ════════════════════════════════════════════════════════════════
run('S2: Buy 1 ETH @€1000, sell @€2000 after 400d → G1 exempt', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 2000, txType: 'sell', date: '2025-02-05', timestamp: ts('2025-02-05') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w2' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(disp[0].anexoG1 && approx(disp[0].anexoG1.gain, 1000), `should be Anexo G1 (long-term), gain ${disp[0].anexoG1 ? disp[0].anexoG1.gain : 'n/a'}`);
    assert(!disp[0].anexoG || disp[0].anexoG.gain === 0, `should NOT be in Anexo G`);
  }
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 3: Pre-2023 acquisition → G1 regardless of holding
// ════════════════════════════════════════════════════════════════
run('S3: Buy pre-2023, sell 2024 → G1 (Art 220 OE/2023)', () => {
  const events = [
    ev({ direction: 'in',  asset: 'BTC', amount: 1, priceEUR: 5000,  txType: 'buy',  date: '2022-06-01', timestamp: ts('2022-06-01') }),
    ev({ direction: 'out', asset: 'BTC', amount: 1, priceEUR: 30000, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w3' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  if (disp[0]) assert(disp[0].anexoG1 != null, `pre-2023 acq must be G1`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 4: FIFO order — oldest lot consumed first
// ════════════════════════════════════════════════════════════════
run('S4: FIFO consumes oldest lot first', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 2000, txType: 'buy', date: '2024-03-01', timestamp: ts('2024-03-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 1800, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w4' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  // Should consume the €1000 lot first → basis 1000, gain 800
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 1000), `FIFO should use oldest €1000 lot, got basis ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 800), `gain should be 800, got ${disp[0].gainEUR}`);
  }
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 5: Crypto↔crypto swap = permuta (NOT a disposal)
// ════════════════════════════════════════════════════════════════
run('S5: ETH→USDC swap in permuta mode → no taxable disposal', () => {
  const txh = '0xswap1';
  const events = [
    ev({ direction: 'in',  asset: 'ETH',  amount: 1,    priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH',  amount: 1,    priceEUR: 1500, txType: 'swap', date: '2024-06-01', timestamp: ts('2024-06-01'), txHash: txh }),
    ev({ direction: 'in',  asset: 'USDC', amount: 1500, priceEUR: 1,    txType: 'swap', date: '2024-06-01', timestamp: ts('2024-06-01'), txHash: txh }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w5', swapMode: 'permuta' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9 && d.kind !== 'airdrop_sale');
  assert(disp.length === 0, `permuta swap should produce 0 disposals, got ${disp.length}`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 6: Aggressive mode — swap IS a disposal
// ════════════════════════════════════════════════════════════════
run('S6: Same swap in aggressive mode → disposal with gain €500', () => {
  const txh = '0xswap2';
  const events = [
    ev({ direction: 'in',  asset: 'ETH',  amount: 1,    priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH',  amount: 1,    priceEUR: 1500, txType: 'swap', date: '2024-06-01', timestamp: ts('2024-06-01'), txHash: txh }),
    ev({ direction: 'in',  asset: 'USDC', amount: 1500, priceEUR: 1,    txType: 'swap', date: '2024-06-01', timestamp: ts('2024-06-01'), txHash: txh }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w6', swapMode: 'aggressive' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length >= 1, `aggressive swap should produce a disposal`);
  const ethDisp = disp.find(d => d.asset === 'ETH');
  if (ethDisp) assert(approx(ethDisp.gainEUR, 500), `aggressive ETH disposal gain should be 500, got ${ethDisp.gainEUR}`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 7: Lending supply/withdraw = NOT alienation, lot preserved
// ════════════════════════════════════════════════════════════════
run('S7: Supply ETH to AAVE then withdraw → no disposal, holding period preserved', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    // supply ETH to AAVE (out) + receive aEthWETH receipt (in) same tx
    ev({ direction: 'out', asset: 'ETH',      amount: 1, priceEUR: 1200, txType: 'lending_supply', protocolType: 'lending', protocol: 'aave-v3', date: '2024-02-01', timestamp: ts('2024-02-01'), txHash: '0xsup' }),
    ev({ direction: 'in',  asset: 'aEthWETH', amount: 1, priceEUR: 1200, txType: 'receive',         protocolType: 'lending', protocol: 'aave-v3', date: '2024-02-01', timestamp: ts('2024-02-01'), txHash: '0xsup' }),
    // sell ETH later (real disposal). If lot preserved from 2024-01-01, holding < 365d → G
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 1600, txType: 'sell', date: '2024-09-01', timestamp: ts('2024-09-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w7' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  // The supply must NOT be a disposal. Only the final sale counts.
  assert(disp.length === 1, `only the final sale is a disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 1000), `basis must be original €1000 (preserved through lending), got ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 600), `gain should be 600, got ${disp[0].gainEUR}`);
  }
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 8: Spam token (unicode homoglyph) → skipped
// ════════════════════════════════════════════════════════════════
run('S8: Cyrillic UЅDС spam token → skip (not in FIFO)', () => {
  const events = [
    ev({ direction: 'in',  asset: 'UЅDС', amount: 1000, priceEUR: null, txType: 'receive', assetContract: '0xscam', date: '2024-05-01', timestamp: ts('2024-05-01') }),
    ev({ direction: 'out', asset: 'UЅDС', amount: 1000, priceEUR: null, txType: 'send',    assetContract: '0xscam', date: '2024-05-02', timestamp: ts('2024-05-02') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w8' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `spam token should produce no disposals, got ${disp.length}`);
  // And classifyEvent should mark it skip
  assert(fifoEngine.isSpamToken(events[0]) === true, `UЅDС must be detected as spam`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 9: Legit USDT0 (₮ symbol) → NOT spam
// ════════════════════════════════════════════════════════════════
run('S9: USD₮0 (legit Tether omnichain) → NOT flagged as spam', () => {
  const e = ev({ asset: 'USD₮0', assetContract: '0x102d758f688a4c1c5a80b116bd945d4455460282', chain: 'base' });
  assert(fifoEngine.isSpamToken(e) === false, `USD₮0 must NOT be spam (legit token)`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 10: Gas/dust micro-ETH outflow → not a disposal
// ════════════════════════════════════════════════════════════════
run('S10: Tiny ETH outflow (0.0001) with no lot → skipped silently', () => {
  const events = [
    ev({ direction: 'out', asset: 'ETH', amount: 0.0001, priceEUR: 2000, txType: 'send', date: '2024-05-01', timestamp: ts('2024-05-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w10' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `gas/dust ETH should not be a disposal, got ${disp.length}`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 11: Disposal with no acquisition lot → no phantom gain
// ════════════════════════════════════════════════════════════════
run('S11: Sell token never acquired → no fictitious gain, warning instead', () => {
  const events = [
    ev({ direction: 'out', asset: 'WBTC', amount: 1, priceEUR: 50000, txType: 'sell', date: '2024-05-01', timestamp: ts('2024-05-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w11' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `no-basis disposal should not record a gain, got ${disp.length}`);
  const warned = (r.warnings || []).some(w => w.type === 'disposal_no_basis_lot');
  assert(warned, `should emit disposal_no_basis_lot warning`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 12: Partial FIFO — sell more than one lot covers
// ════════════════════════════════════════════════════════════════
run('S12: Partial lot consumption across two lots', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1200, txType: 'buy', date: '2024-02-01', timestamp: ts('2024-02-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1.5, priceEUR: 1500, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w12' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  // 1.5 ETH sold: 1 from €1000 lot + 0.5 from €1200 lot = basis 1600, proceeds 2250, gain 650
  const totalBasis = disp.reduce((s, d) => s + d.basisEUR, 0);
  const totalGain = disp.reduce((s, d) => s + d.gainEUR, 0);
  assert(approx(totalBasis, 1600, 1), `basis should be ~1600, got ${totalBasis}`);
  assert(approx(totalGain, 650, 1), `gain should be ~650, got ${totalGain}`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 13: Airdrop received → zero-cost lot, NOT Category E income
// (OCC parecer PT28627: not taxed on receipt)
// ════════════════════════════════════════════════════════════════
run('S13: Airdrop received → zero basis lot, no Anexo E income', () => {
  const events = [
    ev({ direction: 'in', asset: 'ARB', amount: 1000, priceEUR: 1.2, txType: 'airdrop', date: '2024-03-01', timestamp: ts('2024-03-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w13' });
  // Should NOT create a Category E reward entry
  const anexoE = (r.summary && r.summary.byYear && r.summary.byYear[2024]) ? r.summary.byYear[2024].anexoE.totalEUR : 0;
  assert(anexoE === 0, `airdrop must NOT be Cat. E income, got €${anexoE}`);
  // Should open a lot at basis 0
  const arbLot = (r.lots || []).find(l => l.asset === 'ARB');
  assert(arbLot != null, `airdrop should open a lot`);
  if (arbLot) assert(approx(arbLot.basisEURPerUnit || arbLot.basisPerUnit || 0, 0), `airdrop lot basis must be €0`);
});

// ════════════════════════════════════════════════════════════════
// SCENARIO 14: Airdrop sold to FIAT → full proceeds taxed as gain
// ════════════════════════════════════════════════════════════════
run('S14: Airdrop (basis 0) sold to EUR → entire proceeds is the gain', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ARB', amount: 1000, priceEUR: 1.0, txType: 'airdrop', date: '2024-03-01', timestamp: ts('2024-03-01') }),
    ev({ direction: 'out', asset: 'ARB', amount: 1000, priceEUR: 1.5, txType: 'sell',    date: '2024-09-01', timestamp: ts('2024-09-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w14' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 0), `airdrop basis must be 0, got ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 1500), `gain should be full proceeds €1500, got ${disp[0].gainEUR}`);
  }
});

// ── Summary ──────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  · ' + f));
  process.exit(1);
} else {
  console.log('✅ ALL FISCAL E2E TESTS PASSED');
}