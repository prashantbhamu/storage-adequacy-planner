import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/chartData.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { residualPoints } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const rows = (pairs) => pairs.map(([raw_gap_gw, residual_gap_gw], hour) => ({ timestamp: `2029-04-01 ${String(hour).padStart(2, '0')}:00:00`, raw_gap_gw, residual_gap_gw }));

test('fills only the difference, including negative residuals', () => {
  const result = residualPoints(rows([[100, 60], [-20, 10], [5, 5]]));
  assert.deepEqual(result[0].chargingBand, [60, 100]);
  assert.deepEqual(result[0].dischargingBand, [100, 100]);
  assert.deepEqual(result[2].dischargingBand, [-20, 10]);
  assert.deepEqual(result[4].chargingBand, [5, 5]);
  assert.deepEqual(result[4].dischargingBand, [5, 5]);
});

test('sign changes meet exactly without overlapping blue and orange', () => {
  for (const pairs of [[[100, 60], [20, 40]], [[20, 40], [100, 60]]]) {
    const middle = residualPoints(rows(pairs))[1];
    assert.equal(middle.raw_gap_gw, middle.residual_gap_gw);
    assert.equal(middle.chargingBand[0], middle.chargingBand[1]);
    assert.equal(middle.dischargingBand[0], middle.dischargingBand[1]);
  }
});

test('all hourly observations remain exact and immutable', () => {
  const hourly = rows(Array.from({ length: 24 }, (_, i) => [i * 10 - 20, i % 2 ? i * 7 : i * 12]));
  const saved = JSON.stringify(hourly);
  const result = residualPoints(hourly);
  assert.equal(result.length, 47);
  hourly.forEach((row, hour) => {
    assert.equal(result[hour * 2].hour, hour);
    assert.equal(result[hour * 2].raw_gap_gw, row.raw_gap_gw);
    assert.equal(result[hour * 2].residual_gap_gw, row.residual_gap_gw);
  });
  assert.equal(JSON.stringify(hourly), saved);
});

test('stable point counts for day morphs and no bogus band on unchanged gaps', () => {
  const result = residualPoints(rows(Array.from({ length: 24 }, (_, i) => [i, i])));
  assert.equal(result.length, 47);
  assert.ok(result.every(row => row.chargingBand[0] === row.chargingBand[1] && row.dischargingBand[0] === row.dischargingBand[1]));
});

test('supply and demand view: storage bands between supply lines, shortage only below demand', async () => {
  const src = await readFile(new URL('../src/chartData.ts', import.meta.url), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
  const { levelPoints } = await import(`data:text/javascript;base64,${Buffer.from(out).toString('base64')}`);
  const row = (hour, demand, supply, dispatch) => ({
    timestamp: `2029-04-01 ${String(hour).padStart(2, '0')}:00:00`,
    demand_gw: demand, supply_gw: supply, adjusted_supply_gw: supply + dispatch, dispatch_gw: dispatch,
  });
  // Charging from surplus, then discharging into a deficit that is only partly covered.
  const points = levelPoints([row(0, 100, 150, -30), row(1, 120, 80, 25)]);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0].chargingBand, [120, 150]);
  assert.deepEqual(points[0].shortageBand, [100, 100]);
  assert.deepEqual(points[2].dischargingBand, [80, 105]);
  assert.deepEqual(points[2].shortageBand, [105, 120]);
  // The switch from charging to discharging is split exactly, with no overlap.
  const middle = points[1];
  assert.equal(middle.adjusted_supply_gw, middle.supply_gw);
  assert.equal(middle.chargingBand[0], middle.chargingBand[1]);
  assert.equal(middle.dischargingBand[0], middle.dischargingBand[1]);
});
