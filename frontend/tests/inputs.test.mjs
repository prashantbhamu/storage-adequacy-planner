import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/inputs.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { EMPTY_STORAGE, checkInputs, toSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const filled = {
  ...EMPTY_STORAGE, charge_power_gw: '81', discharge_power_gw: '81', energy_gwh: '410', rte_percent: '83.6',
  max_cycles_per_accounting_day: '1', initial_soc_percent: '20', final_soc_percent: '20',
};

test('an untouched form is incomplete but shows no errors', () => {
  const result = checkInputs(EMPTY_STORAGE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors, {});
});

test('a complete form is valid and converts to numeric settings', () => {
  assert.equal(checkInputs(filled).valid, true);
  assert.deepEqual(toSettings(filled, false), {
    charge_from_surplus_only: false, charge_power_gw: 81, discharge_power_gw: 81, energy_gwh: 410, rte_percent: 83.6,
    max_cycles_per_accounting_day: 1, initial_soc_percent: 20, final_soc_percent: 20, min_soc_percent: 0, max_soc_percent: 100,
  });
});

test('SOC levels must sit inside the operating range', () => {
  const { errors, valid } = checkInputs({ ...filled, min_soc_percent: '30' });
  assert.equal(valid, false);
  assert.equal(errors.initial_soc_percent, 'Outside the SOC range.');
  assert.equal(checkInputs({ ...filled, min_soc_percent: '60', max_soc_percent: '50' }).errors.max_soc_percent, 'Must exceed the minimum.');
});

test('efficiency, positivity and sizing skips', () => {
  assert.equal(checkInputs({ ...filled, rte_percent: '120' }).errors.rte_percent, 'At most 100%.');
  assert.equal(checkInputs({ ...filled, energy_gwh: '0' }).errors.energy_gwh, 'Must be greater than zero.');
  const sizing = checkInputs({ ...filled, energy_gwh: '' }, ['energy_gwh']);
  assert.equal(sizing.valid, true);
  assert.equal('energy_gwh' in toSettings({ ...filled, energy_gwh: '' }, true, ['energy_gwh']), false);
});
