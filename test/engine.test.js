const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../public/js/cleancode.js');

const run = (code) => {
  const logs = [];
  vm.runInNewContext(code, { console: { log: (...a) => logs.push(a.join(' ')) } });
  return logs.join('\n');
};

test('regression: identifiers that start with keywords are not split', () => {
  const src = 'const information = 1; let offset = 2; let newValue = 3; function format(x){ return x }\nconsole.log(information + offset + newValue, format(4))';
  const out = C.minifyJS(src);
  assert.ok(!/in formation|of fset|new Value|for mat/.test(out), out);
  assert.equal(run(out), run(src));
});

test('strings, regex literals and template literals are preserved', () => {
  const src = [
    'const url = "https://example.com // not a comment"; // real comment',
    "const re = /\\/\\/[a-z]+ +$/g, s = 'it\\'s';",
    'const t = `sum: ${ 1 + 2 } and ${ `nested ${ "x" }` }`;',
    'console.log(url, re.source, s, t)',
  ].join('\n');
  const out = C.minifyJS(src);
  assert.equal(run(out), run(src));
  assert.ok(!out.includes('real comment'));
});

test('automatic semicolon insertion is respected', () => {
  const src = [
    'let a = 1',
    'let b = a',
    '++b',
    'function f() {',
    '  return',
    '  42',
    '}',
    'const g = x => x * 2',
    'let n = 5 - -1',
    'let m = 5 + +"1"',
    'console.log(a, b, f(), g(3), n, m)',
  ].join('\n');
  const out = C.minifyJS(src);
  assert.equal(run(out), run(src));
  assert.equal(C.sameProgram(src, out), true);
});

test('minify() reports sizes and verifies the AST', () => {
  const r = C.minify('/* header */\nfunction add(a, b) {\n  // add two numbers\n  return a + b;\n}\n', 'js');
  assert.equal(r.output, 'function add(a,b){return a+b;}');
  assert.equal(r.verified, true);
  assert.ok(r.minifiedSize < r.originalSize);
});

test('every JavaScript file in this repo, plus the acorn parser itself, minifies to the same AST', () => {
  const files = [
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, '..', 'public', 'script.js'),
    path.join(__dirname, '..', 'public', 'js', 'cleancode.js'),
    path.join(path.dirname(require.resolve('acorn')), 'acorn.js'),
    path.join(__dirname, '..', 'public', 'vendor', 'acorn.min.js'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const r = C.minify(src, 'js');
    assert.equal(r.verified, true, `not verified: ${f}`);
  }
});

test('CSS: comments and whitespace go, meaning stays', () => {
  const src = `/* c */
  a :hover > b + c { color : red ; width: calc(100% - 2px) ; }
  @media screen and (max-width : 600px) { .x , .y { margin : 0 auto !important ; } }
  .u { background: url( "a b.png" ) no-repeat; content: "a  ;  b" }`;
  const out = C.minifyCSS(src);
  assert.equal(out,
    'a :hover>b+c{color:red;width:calc(100% - 2px)}' +
    '@media screen and (max-width:600px){.x,.y{margin:0 auto !important}}' +
    '.u{background:url("a b.png") no-repeat;content:"a  ;  b"}');
});

test('CSS output is equivalent to the input (css-tree round trip)', () => {
  const csstree = require('css-tree');
  const norm = (s) => csstree.generate(csstree.parse(s, { parseCustomProperty: true }));
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.equal(norm(C.minifyCSS(src)), norm(src));
});

test('symbol table finds variables, functions, classes, params and scope', () => {
  const syms = C.analyzeSymbols(`
const TAX = 0.18;
function total(price, qty = 1) { let sub = price * qty; return sub * (1 + TAX); }
class Cart { add() {} }
const greet = (name) => 'hi ' + name;
let { a, b: renamed } = { a: 1, b: 2 };
`);
  const by = Object.fromEntries(syms.map((s) => [s.name, s]));
  assert.equal(by.TAX.type, 'Variable');
  assert.equal(by.total.type, 'Function');
  assert.equal(by.price.type, 'Parameter');
  assert.equal(by.price.scope, 'total');
  assert.equal(by.sub.scope, 'total');
  assert.equal(by.Cart.type, 'Class');
  assert.equal(by.greet.type, 'Function');
  assert.ok(by.a && by.renamed);
});

test('syntax checker reports brackets and real parse errors with positions', () => {
  const brackets = C.checkSyntax('function f( {\n  return 1\n}');
  assert.equal(brackets.valid, false);
  assert.equal(brackets.errors[0].type, 'unclosed');
  const parse = C.checkSyntax('let x = = 2;');
  assert.equal(parse.valid, false);
  assert.equal(parse.errors[0].type, 'syntax');
  assert.equal(parse.errors[0].line, 1);
  assert.deepEqual(C.checkSyntax('const ok = [1, 2].map((n) => n * 2);').errors, []);
  assert.equal(C.checkSyntax('.a { color: red; ', 'css').valid, false);
});
