// ════════════════════════════════════════════════════════════════
// AURUM — Fiscal Engine E2E Test Suite
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('const fifoEngine = (() => {');
const endMarker = 'window.aurumFifoEngine = fifoEngine;';
const end = html.indexOf(endMarker);
if (start < 0 || end < 0) { console.error('Could not locate engine in index.html'); process.exit(1); }
let engineSrc = html.slice(start, end);
const fifoEngine = eval(engineSrc + '\nfifoEngine;');
let passed = 0, failed = 0;
const failures = [];
function approx(a, b, tol = 0.01) { return Math.abs(a - b) <= tol; }
function assert(cond, msg) { if (cond) { passed++; } else { failed++; failures.push(msg); console.log('  XX ' + msg); } }
function ts(dateStr) { return Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000); }
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
function run(name, fn) { console.log('\n> ' + name); try { fn(); } catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('  XX threw: ' + e.message); } }

run('S1: Buy 1 ETH @1000, sell @1500 within 365d -> G gain 500', () => {
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
run('S2: Buy 1 ETH @1000, sell @2000 after 400d -> G1 exempt', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 2000, txType: 'sell', date: '2025-02-05', timestamp: ts('2025-02-05') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w2' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(disp[0].anexoG1 && approx(disp[0].anexoG1.gain, 1000), `should be Anexo G1, gain ${disp[0].anexoG1 ? disp[0].anexoG1.gain : 'n/a'}`);
    assert(!disp[0].anexoG || disp[0].anexoG.gain === 0, `should NOT be in Anexo G`);
  }
});
run('S3: Buy pre-2023, sell 2024 -> G1', () => {
  const events = [
    ev({ direction: 'in',  asset: 'BTC', amount: 1, priceEUR: 5000,  txType: 'buy',  date: '2022-06-01', timestamp: ts('2022-06-01') }),
    ev({ direction: 'out', asset: 'BTC', amount: 1, priceEUR: 30000, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w3' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  if (disp[0]) assert(disp[0].anexoG1 != null, `pre-2023 acq must be G1`);
});
run('S4: FIFO consumes oldest lot first', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 2000, txType: 'buy', date: '2024-03-01', timestamp: ts('2024-03-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 1800, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w4' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 1000), `FIFO oldest 1000 lot, got basis ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 800), `gain should be 800, got ${disp[0].gainEUR}`);
  }
});
run('S5: ETH->USDC swap permuta -> no taxable disposal', () => {
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
run('S6: Same swap aggressive -> disposal gain 500', () => {
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
  if (ethDisp) assert(approx(ethDisp.gainEUR, 500), `aggressive ETH disposal gain 500, got ${ethDisp.gainEUR}`);
});
run('S7: Supply ETH to AAVE then withdraw -> no disposal, holding preserved', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy',  date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH',      amount: 1, priceEUR: 1200, txType: 'lending_supply', protocolType: 'lending', protocol: 'aave-v3', date: '2024-02-01', timestamp: ts('2024-02-01'), txHash: '0xsup' }),
    ev({ direction: 'in',  asset: 'aEthWETH', amount: 1, priceEUR: 1200, txType: 'receive',         protocolType: 'lending', protocol: 'aave-v3', date: '2024-02-01', timestamp: ts('2024-02-01'), txHash: '0xsup' }),
    ev({ direction: 'out', asset: 'ETH', amount: 1, priceEUR: 1600, txType: 'sell', date: '2024-09-01', timestamp: ts('2024-09-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w7' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `only the final sale is a disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 1000), `basis preserved 1000, got ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 600), `gain should be 600, got ${disp[0].gainEUR}`);
  }
});
run('S8: Cyrillic spam token -> skip', () => {
  const events = [
    ev({ direction: 'in',  asset: 'U\u0405D\u0421', amount: 1000, priceEUR: null, txType: 'receive', assetContract: '0xscam', date: '2024-05-01', timestamp: ts('2024-05-01') }),
    ev({ direction: 'out', asset: 'U\u0405D\u0421', amount: 1000, priceEUR: null, txType: 'send',    assetContract: '0xscam', date: '2024-05-02', timestamp: ts('2024-05-02') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w8' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `spam token should produce no disposals, got ${disp.length}`);
  assert(fifoEngine.isSpamToken(events[0]) === true, `must be detected as spam`);
});
run('S9: USD-T0 legit -> NOT spam', () => {
  const e = ev({ asset: 'USD\u20AE0', assetContract: '0x102d758f688a4c1c5a80b116bd945d4455460282', chain: 'base' });
  assert(fifoEngine.isSpamToken(e) === false, `USD-T0 must NOT be spam`);
});
run('S10: Tiny ETH outflow no lot -> skipped', () => {
  const events = [
    ev({ direction: 'out', asset: 'ETH', amount: 0.0001, priceEUR: 2000, txType: 'send', date: '2024-05-01', timestamp: ts('2024-05-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w10' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `gas/dust ETH should not be a disposal, got ${disp.length}`);
});
run('S11: Sell token never acquired -> no fictitious gain', () => {
  const events = [
    ev({ direction: 'out', asset: 'WBTC', amount: 1, priceEUR: 50000, txType: 'sell', date: '2024-05-01', timestamp: ts('2024-05-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w11' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `no-basis disposal should not record a gain, got ${disp.length}`);
  const warned = (r.warnings || []).some(w => w.type === 'disposal_no_basis_lot');
  assert(warned, `should emit disposal_no_basis_lot warning`);
});
run('S12: Partial lot consumption across two lots', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1000, txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'in',  asset: 'ETH', amount: 1, priceEUR: 1200, txType: 'buy', date: '2024-02-01', timestamp: ts('2024-02-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1.5, priceEUR: 1500, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w12' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  const totalBasis = disp.reduce((s, d) => s + d.basisEUR, 0);
  const totalGain = disp.reduce((s, d) => s + d.gainEUR, 0);
  assert(approx(totalBasis, 1600, 1), `basis should be ~1600, got ${totalBasis}`);
  assert(approx(totalGain, 650, 1), `gain should be ~650, got ${totalGain}`);
});
run('S13: Airdrop received -> zero basis lot, no Anexo E', () => {
  const events = [
    ev({ direction: 'in', asset: 'ARB', amount: 1000, priceEUR: 1.2, txType: 'airdrop', date: '2024-03-01', timestamp: ts('2024-03-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w13' });
  const anexoE = (r.summary && r.summary.byYear && r.summary.byYear[2024]) ? r.summary.byYear[2024].anexoE.totalEUR : 0;
  assert(anexoE === 0, `airdrop must NOT be Cat. E income, got ${anexoE}`);
  const arbLot = (r.lots || []).find(l => l.asset === 'ARB');
  assert(arbLot != null, `airdrop should open a lot`);
  if (arbLot) assert(approx(arbLot.basisEURPerUnit || arbLot.basisPerUnit || 0, 0), `airdrop lot basis must be 0`);
});
run('S14: Airdrop sold to FIAT -> full proceeds taxed', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ARB', amount: 1000, priceEUR: 1.0, txType: 'airdrop', date: '2024-03-01', timestamp: ts('2024-03-01') }),
    ev({ direction: 'out', asset: 'ARB', amount: 1000, priceEUR: 1.5, txType: 'sell',    date: '2024-09-01', timestamp: ts('2024-09-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w14' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal`);
  if (disp[0]) {
    assert(approx(disp[0].basisEUR, 0), `airdrop basis must be 0, got ${disp[0].basisEUR}`);
    assert(approx(disp[0].gainEUR, 1500), `gain should be full proceeds 1500, got ${disp[0].gainEUR}`);
  }
});
run('S15: Staking reward in EUR -> Category E income at receipt', () => {
  const events = [
    ev({ direction: 'in', asset: 'EUR', amount: 500, priceEUR: 1, txType: 'staking_reward', date: '2024-04-01', timestamp: ts('2024-04-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w15' });
  const anexoE = (r.summary && r.summary.byYear && r.summary.byYear[2024]) ? r.summary.byYear[2024].anexoE.totalEUR : 0;
  assert(approx(anexoE, 500), `fiat staking reward must be Cat. E income 500, got ${anexoE}`);
});
run('S16: Staking reward in CRYPTO -> deferred', () => {
  const events = [
    ev({ direction: 'in', asset: 'ETH', amount: 0.5, priceEUR: 2000, txType: 'staking_reward', date: '2024-04-01', timestamp: ts('2024-04-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w16' });
  const anexoE = (r.summary && r.summary.byYear && r.summary.byYear[2024]) ? r.summary.byYear[2024].anexoE.totalEUR : 0;
  assert(anexoE === 0, `crypto staking reward must NOT be Cat. E, got ${anexoE}`);
  const ethLot = (r.lots || []).find(l => l.asset === 'ETH');
  assert(ethLot != null, `should open a lot for the crypto reward`);
});
run('S17: Disposal exceeding indexed lots -> proceeds scaled (no phantom gain)', () => {
  const events = [
    ev({ direction: 'in',  asset: 'ETH', amount: 0.01, priceEUR: 2000, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH', amount: 1.0,  priceEUR: 2000, date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w17' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain < 50, `partial-basis disposal must not invent a large gain, got ${totalGain.toFixed(2)}`);
});
run('S18: Stablecoin out without fiat off-ramp -> not taxed', () => {
  const events = [
    ev({ direction: 'in',  asset: 'USDC', amount: 5000, priceEUR: 0.70, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'USDC', amount: 5000, priceEUR: 0.86, date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w18' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain === 0, `stablecoin transfer must not be taxed, got ${totalGain.toFixed(2)}`);
});
run('S18b: Stablecoin out explicitly marked as fiat sale -> IS taxed', () => {
  const events = [
    ev({ direction: 'in',  asset: 'USDC', amount: 5000, priceEUR: 0.70, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'USDC', amount: 5000, priceEUR: 0.86, txType: 'sell', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w18b' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain > 100, `explicit fiat sale should realize the FX gain, got ${totalGain.toFixed(2)}`);
});

run('S19: On-chain isolated OUT of SOL/token -> NOT taxed (transfer, not sale)', () => {
  const events = [
    ev({ direction: 'in',  asset: 'SOL', chain: 'solana', amount: 10, priceEUR: 50, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'SOL', chain: 'solana', amount: 10, priceEUR: 150, txType: 'transfer_out', _source: 'solana-onchain', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w19' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain === 0, `on-chain isolated out should NOT be taxed, got gain ${totalGain.toFixed(2)}`);
});

run('S19b: CEX sell to FIAT (EUR) -> IS taxed (real fiat sale)', () => {
  // Venda REAL a fiat: SOL → EUR numa exchange. Aqui sim tributa.
  const events = [
    ev({ direction: 'in',  asset: 'SOL', chain: 'solana', amount: 10, priceEUR: 50, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'SOL', chain: 'solana', amount: 10, priceEUR: 150, type: 'sell', txType: 'sell', source: 'cex_import', priceNote: 'cex_fiat', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w19b' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain > 500, `CEX sale to fiat should realize the gain (~1000), got ${totalGain.toFixed(2)}`);
});

run('S19c: CEX crypto-to-crypto trade (SOL->BTC) -> NOT taxed (permuta, FIFO resets)', () => {
  // Troca cripto-cripto DENTRO da exchange (sem fiat) → permuta, NÃO tributa.
  // O parser de CEX marca isto como side='swap' (txType:'swap'), não 'sell'.
  const events = [
    ev({ direction: 'in',  asset: 'SOL', chain: 'solana', amount: 10, priceEUR: 50, date: '2024-01-01', timestamp: ts('2024-01-01') }),
    // Permuta SOL→BTC: dois legs swap no mesmo txHash
    ev({ direction: 'out', asset: 'SOL', chain: 'solana', amount: 10, type: 'swap', txType: 'swap', txHash: 'cexswap1', source: 'cex_import', date: '2024-06-01', timestamp: ts('2024-06-01') }),
    ev({ direction: 'in',  asset: 'BTC', chain: 'bitcoin', amount: 0.05, type: 'swap', txType: 'swap', txHash: 'cexswap1', source: 'cex_import', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w19c' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain === 0, `crypto-to-crypto trade in CEX should NOT be taxed (permuta), got ${totalGain.toFixed(2)}`);
});

run('S20: Multi-leg swap (2 outs -> 1 in) carries basis of ALL out legs', () => {
  const events = [
    ev({ direction: 'in', asset: 'ETH',  chain: 'eth', amount: 1,    priceEUR: 2000, txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'in', asset: 'USDC', chain: 'eth', amount: 1000, priceEUR: 1,    txType: 'buy', date: '2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction: 'out', asset: 'ETH',  chain: 'eth', amount: 1,    type:'swap', txType:'swap', txHash:'ml1', date: '2024-06-01', timestamp: ts('2024-06-01') }),
    ev({ direction: 'out', asset: 'USDC', chain: 'eth', amount: 1000, type:'swap', txType:'swap', txHash:'ml1', date: '2024-06-01', timestamp: ts('2024-06-01') }),
    ev({ direction: 'in',  asset: 'WBTC', chain: 'eth', amount: 0.05, priceEUR: 60000, type:'swap', txType:'swap', txHash:'ml1', date: '2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'w20' });
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain === 0, `multi-leg permuta should not be taxed, got ${totalGain.toFixed(2)}`);
  const wbtcLot = (r.lots || []).find(l => l.asset === 'WBTC');
  assert(wbtcLot, 'WBTC lot should exist');
  const wbtcBasis = wbtcLot.basisEURPerUnit * 0.05;
  assert(Math.abs(wbtcBasis - 3000) < 1, `WBTC basis should be 3000 (2000 ETH + 1000 USDC), got ${wbtcBasis.toFixed(2)}`);
});
run('S21: Categoria B — atividade alta (200 swaps) -> entrada neutra (sem nível)', () => {
  const events = [ ev({ direction:'in', asset:'ETH', amount:1000, priceEUR:1, txType:'buy', date:'2024-01-01', timestamp: ts('2024-01-01') }) ];
  for (let i = 0; i < 200; i++) {
    events.push(ev({ direction:'out', asset:'ETH',  amount:1, type:'swap', txType:'swap', txHash:'sw'+i, date:'2024-02-01', timestamp: ts('2024-02-01') }));
    events.push(ev({ direction:'in',  asset:'USDC', amount:1, type:'swap', txType:'swap', txHash:'sw'+i, date:'2024-02-01', timestamp: ts('2024-02-01') }));
  }
  const r = fifoEngine.process(events, { walletId: 'wB1', swapMode: 'permuta' });
  const flags = r.summary.categoryBFlags || [];
  const f = flags.find(f => f.fiscalYear === 2024);
  assert(f != null, `expected an educational Cat B entry for 2024, got ${flags.length} entries`);
  assert(f && f.level === undefined, `entry must be neutral (no warn/info level), got level=${f ? f.level : 'n/a'}`);
  assert(f && f.swapsCount >= 1, `should record swap activity as neutral context, got ${f ? f.swapsCount : 'n/a'}`);
});

run('S22: Categoria B — atividade moderada (70 swaps) -> entrada neutra (sem nível)', () => {
  const events = [ ev({ direction:'in', asset:'ETH', amount:1000, priceEUR:1, txType:'buy', date:'2024-01-01', timestamp: ts('2024-01-01') }) ];
  for (let i = 0; i < 70; i++) {
    events.push(ev({ direction:'out', asset:'ETH',  amount:1, type:'swap', txType:'swap', txHash:'sw'+i, date:'2024-02-01', timestamp: ts('2024-02-01') }));
    events.push(ev({ direction:'in',  asset:'USDC', amount:1, type:'swap', txType:'swap', txHash:'sw'+i, date:'2024-02-01', timestamp: ts('2024-02-01') }));
  }
  const r = fifoEngine.process(events, { walletId: 'wB2', swapMode: 'permuta' });
  const flags = r.summary.categoryBFlags || [];
  const f2024 = flags.find(f => f.fiscalYear === 2024);
  assert(f2024 != null, `expected an educational Cat B entry for 2024`);
  assert(f2024 && f2024.level === undefined, `entry must be neutral (no level), got ${f2024 ? f2024.level : 'none'}`);
});

run('S23: Categoria B — só aquisições, sem alienações/permutas -> sem entrada', () => {
  const events = [
    ev({ direction:'in', asset:'ETH', amount:1, priceEUR:1000, txType:'buy', date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'in', asset:'BTC', amount:1, priceEUR:5000, txType:'buy', date:'2024-03-01', timestamp: ts('2024-03-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wB3' });
  const flags = r.summary.categoryBFlags || [];
  assert(flags.length === 0, `a year with only acquisitions (no disposals/swaps) should have no Cat B entry, got ${flags.length}`);
});

run('S24: Categoria B — venda de volume alto -> entrada neutra, volume como contexto', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:100, priceEUR:2000, txType:'buy',  date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:100, priceEUR:2000, txType:'sell', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wB4' });
  const flags = r.summary.categoryBFlags || [];
  const f = flags.find(f => f.fiscalYear === 2024);
  assert(f != null, `expected an educational Cat B entry for the year with a large sale`);
  assert(f && f.level === undefined, `entry must be neutral (no warn), got ${f ? f.level : 'none'}`);
  assert(f && f.volumeEUR >= 100000, `volume should be recorded as neutral context, got ${f ? f.volumeEUR : 'n/a'}`);
  assert(f && f.salesCount >= 1, `sale should be counted, got ${f ? f.salesCount : 'n/a'}`);
});

run('S25: Card DEBIT spend (taxTreatment disposal) -> real mais-valia via FIFO', () => {
  // simula o evento sintético que _cardSpendsToEvents gera para um gasto de débito:
  // comprei 1 ETH @1000, gastei-o no cartão (débito) quando valia 1500 -> ganho 500 (Cat G)
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',  date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'sale', date:'2024-06-01', timestamp: ts('2024-06-01'), source:'card_spend', userOverride:{txType:'sale'} }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wcard1' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `expected 1 disposal, got ${disp.length}`);
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.anexoG.gain, 500), `expected Anexo G gain 500, got ${yr ? yr.anexoG.gain : 'none'}`);
});

run('S26: Card spend on asset held >365d -> Anexo G1 (isento)', () => {
  // gasto de débito mas o ativo foi detido >365 dias -> isento (G1), não G
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',  date:'2023-01-01', timestamp: ts('2023-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'sale', date:'2024-06-01', timestamp: ts('2024-06-01'), source:'card_spend', userOverride:{txType:'sale'} }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wcard2' });
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.anexoG.gain, 0), `expected Anexo G gain 0 (exempt), got ${yr ? yr.anexoG.gain : 'none'}`);
  assert(yr && yr.anexoG1.gain > 0, `expected Anexo G1 gain > 0 (exempt held >365d), got ${yr ? yr.anexoG1.gain : 'none'}`);
});

run('S27: Liquidação — leitura permuta (default) -> NÃO tributa', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',         date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wliq1' }); // sem greyAreas -> default permuta
  const totalGain = (r.disposals || []).reduce((s, d) => s + (d.gainEUR || 0), 0);
  assert(totalGain === 0, `liquidação permuta não deve tributar, got gain ${totalGain.toFixed(2)}`);
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `permuta -> 0 disposals, got ${disp.length}`);
});

run('S28: Liquidação — leitura alienação -> Cat G ganho 500', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',         date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wliq2', greyAreas: { liquidation: 'disposal' } });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `alienação -> 1 disposal, got ${disp.length}`);
  if (disp[0]) {
    assert(disp[0].kind === 'liquidation', `kind deve ser 'liquidation', got ${disp[0].kind}`);
    assert(approx(disp[0].gainEUR, 500), `ganho deve ser 500, got ${disp[0].gainEUR}`);
  }
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.anexoG.gain, 500), `Anexo G ganho 500, got ${yr ? yr.anexoG.gain : 'none'}`);
});

run('S29: Liquidação alienação de ativo detido >365d -> Anexo G1 (isento)', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',         date:'2023-01-01', timestamp: ts('2023-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wliq3', greyAreas: { liquidation: 'disposal' } });
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.anexoG.gain, 0), `Anexo G ganho 0 (isento), got ${yr ? yr.anexoG.gain : 'none'}`);
  assert(yr && yr.anexoG1.gain > 0, `Anexo G1 ganho > 0 (isento >365d), got ${yr ? yr.anexoG1.gain : 'none'}`);
});

run('S30: Liquidação forçada NÃO conta como atividade habitual (Cat B)', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',         date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wliq4', greyAreas: { liquidation: 'disposal' } });
  const flags = r.summary.categoryBFlags || [];
  assert(flags.length === 0, `uma liquidação forçada não é trading habitual -> sem entrada Cat B, got ${flags.length}`);
});

run('S31: compareLiquidationReadings -> devolve as duas leituras com o delta certo', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',         date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const c = fifoEngine.compareLiquidationReadings(events, { walletId: 'wcmp' });
  assert(approx(c.permuta.taxableGainG, 0), `permuta -> 0 ganho tributável, got ${c.permuta.taxableGainG}`);
  assert(approx(c.alienacao.taxableGainG, 500), `alienação -> 500 ganho tributável, got ${c.alienacao.taxableGainG}`);
  assert(approx(c.deltaTaxableGainG, 500), `delta ganho deve ser 500, got ${c.deltaTaxableGainG}`);
  assert(approx(c.deltaIndicativeTax28, 140), `delta imposto indicativo ~140 (500*0.28), got ${c.deltaIndicativeTax28}`);
});

run('S32: Liquidação manual casa basis ao nível do ativo (cross-chain)', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', chain:'eth',      amount:1, priceEUR:1000, txType:'buy',         date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', chain:'arbitrum', amount:1, priceEUR:1500, txType:'liquidation', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wliq5', greyAreas: { liquidation: 'disposal' } });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 1, `cross-chain liquidation deve achar o lote ETH (eth) e criar 1 disposal, got ${disp.length}`);
  if (disp[0]) assert(approx(disp[0].gainEUR, 500), `ganho 500 (basis do lote eth), got ${disp[0].gainEUR}`);
});

run('S33: Alienação tem fiscalSource foreign por defeito -> Anexo J Q9.4A', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',  date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'sell', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wsrc1' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp[0] && disp[0].fiscalSource === 'foreign', `default deve ser foreign, got ${disp[0] && disp[0].fiscalSource}`);
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.bySource.foreign.taxableGain, 500), `foreign taxableGain 500 (Anexo J), got ${yr ? yr.bySource.foreign.taxableGain : 'none'}`);
  assert(yr && approx(yr.bySource.national.taxableGain, 0), `national deve ser 0, got ${yr ? yr.bySource.national.taxableGain : 'none'}`);
});

run('S34: Evento marcado fiscalSource national -> Anexo G Q18A', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',  date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:1500, txType:'sell', date:'2024-06-01', timestamp: ts('2024-06-01'), fiscalSource:'national' }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wsrc2' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp[0] && disp[0].fiscalSource === 'national', `deve ser national, got ${disp[0] && disp[0].fiscalSource}`);
  const yr = r.summary.byYear[2024];
  assert(yr && approx(yr.bySource.national.taxableGain, 500), `national taxableGain 500 (Anexo G), got ${yr ? yr.bySource.national.taxableGain : 'none'}`);
  assert(yr && approx(yr.bySource.foreign.taxableGain, 0), `foreign deve ser 0, got ${yr ? yr.bySource.foreign.taxableGain : 'none'}`);
});

run('S35: Isento ≥365d NÃO entra no split de fonte (vai a Anexo G1 Q7)', () => {
  const events = [
    ev({ direction:'in',  asset:'ETH', amount:1, priceEUR:1000, txType:'buy',  date:'2023-01-01', timestamp: ts('2023-01-01') }),
    ev({ direction:'out', asset:'ETH', amount:1, priceEUR:2000, txType:'sell', date:'2024-06-01', timestamp: ts('2024-06-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wsrc3' });
  const yr = r.summary.byYear[2024];
  assert(yr && yr.anexoG1.gain > 0, `isento deve ir a G1, got ${yr ? yr.anexoG1.gain : 'none'}`);
  assert(yr && approx(yr.bySource.foreign.taxableGain, 0) && approx(yr.bySource.national.taxableGain, 0), `split de fonte deve ficar a 0 (é isento)`);
});

run('S36: Permuta crypto↔crypto regista volume no motor (não tributado)', () => {
  const txh = '0xswapvol';
  const events = [
    ev({ direction:'in',  asset:'ETH',  amount:1,    priceEUR:1500, txType:'buy',  date:'2024-01-01', timestamp: ts('2024-01-01') }),
    ev({ direction:'out', asset:'ETH',  amount:1,    priceEUR:2000, txType:'swap', date:'2025-06-01', timestamp: ts('2025-06-01'), txHash: txh }),
    ev({ direction:'in',  asset:'USDC', amount:2000, priceEUR:1,    txType:'swap', date:'2025-06-01', timestamp: ts('2025-06-01'), txHash: txh }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wpv', swapMode: 'permuta' });
  const disp = (r.disposals || []).filter(d => d.qtyDisposed > 1e-9);
  assert(disp.length === 0, `permuta não deve gerar alienação, got ${disp.length}`);
  const yr = r.summary.byYear[2025];
  assert(yr && yr.permutaVolumeEUR > 0, `permutaVolumeEUR deve ser > 0, got ${yr ? yr.permutaVolumeEUR : 'none'}`);
  assert(yr && yr.permutaCount >= 1, `permutaCount deve ser >= 1, got ${yr ? yr.permutaCount : 'none'}`);
});

run('S37: Airdrop > €500 sinaliza Imposto do Selo (10% via DMIS)', () => {
  const events = [
    ev({ direction:'in', asset:'AAA', amount:1, priceEUR:1000, txType:'airdrop', date:'2026-03-10', timestamp: ts('2026-03-10') }),
    ev({ direction:'in', asset:'BBB', amount:1, priceEUR:200,  txType:'airdrop', date:'2026-04-02', timestamp: ts('2026-04-02') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wsd' });
  const sd = r.summary.byYear[2026] && r.summary.byYear[2026].stampDuty;
  assert(sd, 'stampDuty deve existir em byYear[2026]');
  if (sd) {
    assert(sd.count === 2, `2 airdrops registados, got ${sd.count}`);
    assert(sd.liableCount === 1, `só o >€500 é tributável, got ${sd.liableCount}`);
    assert(sd.applies === true, `Selo deve aplicar-se`);
    assert(approx(sd.dueEUR, 100), `Selo = 1000*10% = 100, got ${sd.dueEUR}`);
    assert(approx(sd.grossEUR, 1200), `bruto = 1200, got ${sd.grossEUR}`);
  }
});

run('S38: Airdrop de €500 exatos NÃO excede o limiar (sem Selo)', () => {
  const events = [
    ev({ direction:'in', asset:'CCC', amount:1, priceEUR:500, txType:'airdrop', date:'2026-05-01', timestamp: ts('2026-05-01') }),
  ];
  const r = fifoEngine.process(events, { walletId: 'wsd2' });
  const sd = r.summary.byYear[2026] && r.summary.byYear[2026].stampDuty;
  assert(sd, 'stampDuty deve existir');
  if (sd) {
    assert(sd.liableCount === 0, `€500 exato não excede, got ${sd.liableCount}`);
    assert(sd.applies === false, `Selo NÃO deve aplicar-se a ≤€500`);
    assert(approx(sd.dueEUR, 0), `sem Selo, got ${sd.dueEUR}`);
  }
});

console.log('\n' + '='.repeat(60));
console.log(`RESULT: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
if (failed > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
else { console.log('ALL FISCAL E2E TESTS PASSED'); }