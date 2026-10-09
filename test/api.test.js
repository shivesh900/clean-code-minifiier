const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server.js');

let server, base;
before(() => new Promise((resolve) => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
after(() => server.close());

const post = (route, body) => fetch(base + route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('POST /minify returns verified output', async () => {
  const r = await post('/minify', { code: 'let  a = 1 ; // hi\nconsole.log( a )', language: 'js' });
  assert.equal(r.status, 200);
  assert.equal(r.body.output, 'let a=1;console.log(a)');
  assert.equal(r.body.verified, true);
});

test('POST /minify validates input', async () => {
  assert.equal((await post('/minify', { code: 'x' })).status, 400);
  assert.equal((await post('/minify', { code: 'x', language: 'py' })).status, 400);
  assert.equal((await post('/minify', { code: 'let s = "open', language: 'js' })).status, 422);
});

test('POST /symbol-table and /syntax-check', async () => {
  const s = await post('/symbol-table', { code: 'function f(a) { return a }' });
  assert.equal(s.body.count, 2);
  const c = await post('/api/syntax-check', { code: 'if (x { }' });
  assert.equal(c.body.valid, false);
});

test('serves the UI', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /CleanCode/);
});
