require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
let APP_VERSION = 'unknown';
try {
  APP_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
} catch (e) {
  console.error('[startup] Failed to read version from package.json:', e.message);
}

const validateRouter = require('./routes/validate');
const companiesRouter = require('./routes/companies');
const notesRouter = require('./routes/notes');
const entitiesRouter = require('./routes/entities');
const memberActivityRouter = require('./routes/memberActivity');
const teamMembershipRouter = require('./routes/teamMembership');
const teamsCrudRouter      = require('./routes/teamsCrud');
const membersTeamsMgmtRouter = require('./routes/membersTeamsMgmt');
const usersRouter          = require('./routes/users');
const authRouter           = require('./routes/auth');
const feedbackRouter       = require('./routes/feedback');
const notesMergeRouter          = require('./routes/notesMerge');
const companiesDuplicateCleanupRouter = require('./routes/companiesDuplicateCleanup');
const fieldValueDeleteRouter          = require('./routes/fieldValueDelete');

const shouldCompress = (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('text/event-stream')) {
    return false;
  }
  return compression.filter(req, res);
};

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
app.use(compression({ filter: shouldCompress }));

// Serve index.html with version injected server-side (async /api/config fetch fails silently on GCP)
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace('id="app-version">', `id="app-version"> · v${APP_VERSION}`)
  .replace('href="style.css"', `href="style.css?v=${APP_VERSION}"`)
  .replace(/src="([\w-]+\.js)"/g, `src="$1?v=${APP_VERSION}"`);
app.get(['/', '/index.html'], (_req, res) => res.type('html').send(indexHtml));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use(express.json({ limit: '25mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 h — matches PB OAuth access token lifetime
  },
}));

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('[startup] FATAL: SESSION_SECRET env var is not set. Refusing to start with insecure default.');
  process.exit(1);
}

// Health, config, and auth status are exempt from rate limiting
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/auth/status', (req, res) => {
  if (req.session?.pbToken) {
    res.json({ connected: true, method: 'oauth', useEu: req.session.useEu ?? false });
  } else {
    res.json({ connected: false });
  }
});
app.use('/auth', authRouter);
app.get('/api/config', (_req, res) => {
  res.json({
    version:            APP_VERSION,
    feedbackUrl:        process.env.FEEDBACK_URL || null,
    issueUrl:           process.env.ISSUE_URL    || null,
    feedbackFormEnabled: !!(process.env.PB_FEEDBACK_TOKEN || (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL && process.env.FEEDBACK_RECIPIENT_EMAIL)),
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

if (process.env.NODE_ENV !== 'test') {
  app.use(burstLimiter);
  app.use(sustainedLimiter);
  app.use(speedLimiter);
}

app.use('/api/validate', validateRouter);
app.use('/api', companiesRouter);
app.use('/api/users', usersRouter);
app.use('/api/notes', notesRouter);
app.use('/api/entities', entitiesRouter);
app.use('/api/member-activity', memberActivityRouter);
app.use('/api/team-membership', teamMembershipRouter);
app.use('/api/teams-crud', teamsCrudRouter);
app.use('/api/members-teams-mgmt', membersTeamsMgmtRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/notes-merge', notesMergeRouter);
app.use('/api/companies-duplicate-cleanup', companiesDuplicateCleanupRouter);
app.use('/api/tag-values', fieldValueDeleteRouter);

// Static pages
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});

// Fallback to index.html for client-side routing
app.get('*', (req, res) => {
  // Don't serve index.html for what looks like a missing static file
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PBToolkit v${APP_VERSION} running on port ${PORT}`);
  });
}

module.exports = app;
