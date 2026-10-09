const express = require('express');
const path = require('path');
const CleanCode = require('./public/js/cleancode.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// The browser UI runs the same engine locally (public/js/cleancode.js);
// these routes expose it as a JSON API, e.g.
//   curl -X POST localhost:3000/minify -H 'Content-Type: application/json' \
//        -d '{"code":"let  a = 1 ; // hi","language":"js"}'

const parseError = (res, err) => res.status(422).json({
  error: `Couldn't parse the input: ${err.message}`,
  line: err.line || null,
  col: err.col || null,
});

// ── API Routes ─────────────────────────────────────────────────────────

app.post(['/minify', '/api/minify'], (req, res) => {
  const { code, language } = req.body || {};
  if (!code || !language) {
    return res.status(400).json({ error: 'Both "code" and "language" fields are required.' });
  }
  if (!['js', 'css'].includes(language)) {
    return res.status(400).json({ error: 'Language must be "js" or "css".' });
  }
  try {
    res.json(CleanCode.minify(code, language)); // { output, originalSize, minifiedSize, verified }
  } catch (err) {
    parseError(res, err);
  }
});

app.post(['/symbol-table', '/api/symbol-table'], (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: '"code" field is required.' });
  try {
    const symbols = CleanCode.analyzeSymbols(code);
    res.json({ symbols, count: symbols.length });
  } catch (err) {
    parseError(res, err);
  }
});

app.post(['/syntax-check', '/api/syntax-check'], (req, res) => {
  const { code, language = 'js' } = req.body || {};
  if (!code) return res.status(400).json({ error: '"code" field is required.' });
  res.json(CleanCode.checkSyntax(code, language)); // { valid, errors, parser }
});

app.get('/api/health', (req, res) => res.json({ ok: true, parser: CleanCode.hasParser ? 'acorn' : 'none' }));

// ── Start server (locally) / export for Vercel ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✨ CleanCode Minifier running → http://localhost:${PORT}`);
  });
}

module.exports = app;
