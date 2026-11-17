import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function pureModule(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected dependency ' + name);
    return dependencies[name];
  } });
  return exports;
}
const hours = await pureModule('../src/hours.ts');
const dto = await pureModule('../src/services/dto.ts', { '../hours': hours });
const intent = await pureModule('../src/services/sampleAssist.ts');
const fixture = JSON.parse(await readFile(new URL('../server/internal/goodfork/testdata/hours.json', import.meta.url), 'utf8'));
hours.validateSchedule(fixture.schedule);
for (const scenario of fixture.cases) {
  assert.equal(hours.hoursStatus(fixture.schedule, new Date(scenario.at)).state === 'open', scenario.open, scenario.at);
}
const roundTrip = hours.readSchedule(fixture.schedule.timezone, fixture.schedule.week.map(hours.periodText),
  fixture.schedule.exceptions.map(row => row.date + ' ' + hours.periodText(row.periods)).join('\n'));
assert.equal(JSON.stringify(roundTrip), JSON.stringify(fixture.schedule));
assert.equal(hours.hoursStatus(null).state, 'unknown');
assert.throws(() => hours.readSchedule('Missing/Timezone', Array(7).fill('Closed'), ''));
assert.throws(() => hours.readSchedule('UTC', Array(7).fill('09:00-18:00, 17:00-20:00'), ''));
assert.throws(() => hours.readSchedule('UTC', Array(7).fill('Closed'), '2026-02-31 Closed'));
assert.equal(intent.sampleIntent('not Italian', {}, []).ambiguous, true);
assert.equal(intent.sampleIntent('ramen open now', {}, []).filters.openNow, true);
assert.equal(dto.validDTO('posts/example', { id: 'example' }), false);
assert.equal(dto.validDTO('places?offset=0', { items: [{ id: 'example', hours: 4 }] }), false);
assert.equal(dto.validDTO('me/visits/example', { id: 'example', score: 'nine' }), false);
assert.equal(dto.validDTO('feed?kind=clips', { items: [{ id: 'example', author: null }] }), false);
console.log('Shared hours fixtures, round-trip editor, negation, and malformed DTO checks passed');
