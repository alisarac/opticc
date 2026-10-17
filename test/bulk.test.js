'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chunk, merge } = require('../scripts/bulk');

// Mixed layout on purpose: inline and multi-line arrays, 4-space and 2-space indents.
const SRC = `{
  "ace": {
    "up": {
      "en": ["A spark \\"here\\".", "Fresh energy."],
      "tr": []
    },
    "down": {
        "en": [
          "Delays.",
          "Stalled."
        ]
    }
  },
  "two": {"up": {"en": ["Planning."], "tr": ["Planlama."]}}
}
`;
const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-bulk-'));
  const src = path.join(dir, 'src.json');
  fs.writeFileSync(src, SRC);
  return { src, work: path.join(dir, 'work') };
};
const upper = v => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? x.toUpperCase() : x)));
const answer = (work, m, fn = upper) => m.chunks.forEach(c => {
  const input = JSON.parse(fs.readFileSync(path.join(work, c.in), 'utf8'));
  fs.writeFileSync(path.join(work, c.out), JSON.stringify(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fn(v)]))));
});

test('only missing targets are chunked; merge fills or adds them and keeps the layout', () => {
  const { src, work } = setup();
  const m = chunk(src, '*.*.en', work, { to: 'tr' });
  assert.strictEqual(m.total, 2, 'two.up already has tr');
  answer(work, m);
  assert.deepStrictEqual(merge(work), { merged: 2, total: 2, bad: [], retry: [] });
  assert.strictEqual(fs.readFileSync(src, 'utf8'), SRC
    .replace('"tr": []', '"tr": ["A SPARK \\"HERE\\".", "FRESH ENERGY."]')
    .replace(`"Stalled."
        ]`, `"Stalled."
        ],
        "tr": [
          "DELAYS.",
          "STALLED."
        ]`));
});

test('small chunks split; a missing or misshapen answer is reported and not written', () => {
  const { src, work } = setup();
  const m = chunk(src, '*.*.en', work, { to: 'tr', all: true, kb: 0.05 });
  assert.strictEqual(m.chunks.length, 3);
  answer(work, m, v => v.slice(0, 1).map(s => s.toLowerCase()));
  fs.writeFileSync(path.join(work, m.chunks[1].out), JSON.stringify({ 'ace.down.en': ['Delays.', 'Stalled.'].map(s => s.toLowerCase()) }));
  fs.unlinkSync(path.join(work, m.chunks[2].out));
  const r = merge(work);
  assert.deepStrictEqual(r, { merged: 1, total: 3, bad: ['ace.up.en'], retry: ['chunk-001.json', 'chunk-003.json'] });
  assert.match(fs.readFileSync(src, 'utf8'), /"Stalled\."\n {8}\],\n {8}"tr": \[\n {10}"delays\.",\n {10}"stalled\."\n {8}\]/);
  answer(work, m); // retry: the manifest now lists only chunks 1 and 3
  assert.deepStrictEqual(merge(work), { merged: 2, total: 2, bad: [], retry: [] });
  assert.match(fs.readFileSync(src, 'utf8'), /"tr": \["A SPARK \\"HERE\\".", "FRESH ENERGY."\]/);
});

test('in-place transform without --to', () => {
  const { src, work } = setup();
  answer(work, chunk(src, 'two.up.tr', work));
  merge(work);
  assert.match(fs.readFileSync(src, 'utf8'), /"tr": \["PLANLAMA\."\]/);
});

test('merge stops when the source changed after chunking', () => {
  const { src, work } = setup();
  answer(work, chunk(src, '*.*.en', work, { to: 'tr' }));
  fs.appendFileSync(src, ' ');
  assert.throws(() => merge(work), /changed since chunking/);
});

test('--into fills an ARB file: missing keys appended, @metadata skipped, lost placeholders rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opticc-bulk-'));
  const en = path.join(dir, 'app_en.arb'), de = path.join(dir, 'app_de.arb'), work = path.join(dir, 'work');
  fs.writeFileSync(en, '{\n  "@@locale": "en",\n  "hi": "Hi",\n  "@hi": {"description": "greeting"},\n  "spent": "{app}, {spent}",\n  "bye": "Bye"\n}\n');
  fs.writeFileSync(de, '{\n  "@@locale": "de",\n  "hi": "Hallo"\n}\n');
  const m = chunk(en, '*', work, { into: de });
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(work, m.chunks[0].in), 'utf8'))), ['spent', 'bye']);
  fs.writeFileSync(path.join(work, m.chunks[0].out), JSON.stringify({ spent: '{app}', bye: 'Tschüss' }));
  assert.deepStrictEqual(merge(work), { merged: 1, total: 2, bad: ['spent'], retry: ['chunk-001.json'] });
  assert.strictEqual(fs.readFileSync(de, 'utf8'), '{\n  "@@locale": "de",\n  "hi": "Hallo",\n  "bye": "Tschüss"\n}\n');
  fs.writeFileSync(de, '{\n  "hi": "Hallo"\n}\n'); // two appends at one spot keep source order
  chunk(en, '*', work, { into: de });
  fs.writeFileSync(path.join(work, 'out-001.json'), JSON.stringify({ spent: '{app}, {spent}', bye: 'Tschüss' }));
  merge(work);
  assert.strictEqual(fs.readFileSync(de, 'utf8'), '{\n  "hi": "Hallo",\n  "spent": "{app}, {spent}",\n  "bye": "Tschüss"\n}\n');
  assert.ok(fs.readFileSync(en, 'utf8').includes('"bye": "Bye"'), 'source untouched');
});
