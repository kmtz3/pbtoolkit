require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');

const fieldsRouter = require('./routes/fields');
const exportRouter = require('./routes/export');
const importRouter = require('./routes/import');
const notesRouter = require('./routes/notes');
const companiesRouter = require('./routes/companies');
const entitiesRouter = require('./routes/entities');
const memberActivityRouter = require('./routes/memberActivity');

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'style-src': ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
    },
  },
}));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health and config are exempt from rate limiting
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => {
  res.json({
    feedbackUrl: process.env.FEEDBACK_URL || null,
    issueUrl:    process.env.ISSUE_URL    || null,
  });
});

// Burst limiter: max 10 requests per second per IP
const burstLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests in a short period, please slow down.' },
});

// Sustained limiter: max 100 requests per 15 minutes per IP
const sustainedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Try again later.' },
});

// Progressive slow-down before the hard cap kicks in
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 50,
  delayMs: (hits) => hits * 200,
});

app.use(burstLimiter);
app.use(sustainedLimiter);
app.use(speedLimiter);

app.use('/api/fields', fieldsRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/notes', notesRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/entities', entitiesRouter);
app.use('/api/member-activity', memberActivityRouter);

// Fallback to index.html for client-side routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`PBToolkit running on port ${PORT}`);
});
