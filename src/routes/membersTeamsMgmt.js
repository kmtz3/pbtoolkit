/**
 * Members & Teams Management module
 *
 * GET  /api/members-teams-mgmt/load     — fetch all teams with their members
 * PATCH /api/members-teams-mgmt/team/:id — update team fields (name, handle, description)
 * POST /api/members-teams-mgmt/team/:teamId/add-member    — add member to team
 * POST /api/members-teams-mgmt/team/:teamId/remove-member — remove member from team
 * POST /api/members-teams-mgmt/move-member                — move member between teams
 *
 * Headers: x-pb-token (required), x-pb-eu (optional)
 */

'use strict';

const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');
const { parseApiError } = require('../lib/errorUtils');
const { ensureCache, invalidateCache } = require('../services/teamCache');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/members-teams-mgmt/load
// ---------------------------------------------------------------------------

router.get('/load', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token'];
  const { pbClient } = res.locals;

  // Force refresh so the live editor always shows current state
  if (req.query.refresh === 'true') invalidateCache(token);

  try {
    const entry = await ensureCache(token, pbClient);

    // Build response: teams with embedded member details
    const teams = [...entry.teamsById.values()]
      .map((t) => {
        const memberIds = entry.memberIdsByTeamId.get(t.id) ?? new Set();
        return {
          id:          t.id,
          name:        t.name,
          handle:      t.handle,
          description: t.description,
          members: [...memberIds]
            .map((mid) => entry.membersById.get(mid))
            .filter(Boolean)
            .sort((a, b) => a.email.localeCompare(b.email)),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // All workspace members (for the "add member" autocomplete)
    const allMembers = [...entry.membersById.values()].sort((a, b) => a.email.localeCompare(b.email));

    res.json({ teams, allMembers });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[members-teams-mgmt] load error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to load teams.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/members-teams-mgmt/team/:id
// ---------------------------------------------------------------------------

router.patch('/team/:id', pbAuth, async (req, res) => {
  const { id } = req.params;
  const { name, handle, description } = req.body;
  const { pbClient } = res.locals;

  const fields = {};
  if (name !== undefined)        fields.name        = name;
  if (handle !== undefined)      fields.handle      = handle;
  if (description !== undefined) fields.description = description;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'No fields to update.' });
  }

  try {
    await pbClient.withRetry(
      () => pbClient.pbFetch('patch', `/v2/teams/${id}`, { data: { fields } }),
      `patch team ${id}`
    );
    res.json({ ok: true });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    if (status === 404) {
      return res.status(404).json({ error: 'Team not found.' });
    }
    if (status === 409) {
      return res.status(409).json({ error: 'Handle already taken.' });
    }
    console.error('[members-teams-mgmt] patch team error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/members-teams-mgmt/team/:teamId/add-member
// ---------------------------------------------------------------------------

router.post('/team/:teamId/add-member', pbAuth, async (req, res) => {
  const { teamId } = req.params;
  const { memberId } = req.body;
  const { pbClient } = res.locals;

  if (!memberId) return res.status(400).json({ error: 'memberId is required.' });

  try {
    await pbClient.withRetry(
      () => pbClient.pbFetch('patch', `/v2/teams/${teamId}`, {
        data: {
          patch: [{ op: 'addItems', path: 'members', value: [{ id: memberId }] }],
        },
      }),
      `add member ${memberId} to team ${teamId}`
    );
    res.json({ ok: true });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[members-teams-mgmt] add-member error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/members-teams-mgmt/team/:teamId/remove-member
// ---------------------------------------------------------------------------

router.post('/team/:teamId/remove-member', pbAuth, async (req, res) => {
  const { teamId } = req.params;
  const { memberId } = req.body;
  const { pbClient } = res.locals;

  if (!memberId) return res.status(400).json({ error: 'memberId is required.' });

  try {
    await pbClient.withRetry(
      () => pbClient.pbFetch('patch', `/v2/teams/${teamId}`, {
        data: {
          patch: [{ op: 'removeItems', path: 'members', value: [{ id: memberId }] }],
        },
      }),
      `remove member ${memberId} from team ${teamId}`
    );
    res.json({ ok: true });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[members-teams-mgmt] remove-member error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/members-teams-mgmt/move-member
// ---------------------------------------------------------------------------

router.post('/move-member', pbAuth, async (req, res) => {
  const { memberId, fromTeamId, toTeamId } = req.body;
  const { pbClient } = res.locals;

  if (!memberId || !fromTeamId || !toTeamId) {
    return res.status(400).json({ error: 'memberId, fromTeamId, and toTeamId are required.' });
  }
  if (fromTeamId === toTeamId) {
    return res.json({ ok: true }); // no-op
  }

  try {
    // Add to target team first, then remove from source
    await pbClient.withRetry(
      () => pbClient.pbFetch('patch', `/v2/teams/${toTeamId}`, {
        data: {
          patch: [{ op: 'addItems', path: 'members', value: [{ id: memberId }] }],
        },
      }),
      `add member ${memberId} to team ${toTeamId}`
    );

    await pbClient.withRetry(
      () => pbClient.pbFetch('patch', `/v2/teams/${fromTeamId}`, {
        data: {
          patch: [{ op: 'removeItems', path: 'members', value: [{ id: memberId }] }],
        },
      }),
      `remove member ${memberId} from team ${fromTeamId}`
    );

    res.json({ ok: true });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[members-teams-mgmt] move-member error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/members-teams-mgmt/team  (create)
// ---------------------------------------------------------------------------

router.post('/team', pbAuth, async (req, res) => {
  const { name, handle, description } = req.body;
  const { pbClient } = res.locals;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Team name is required.' });
  }

  const fields = { name: name.trim() };
  if (handle)      fields.handle      = handle.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (description) fields.description = description;

  try {
    const result = await pbClient.withRetry(
      () => pbClient.pbFetch('post', '/v2/teams', {
        data: { type: 'team', fields },
      }),
      `create team ${fields.name}`
    );
    res.json({ ok: true, id: result?.data?.id });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    if (status === 409) {
      return res.status(409).json({ error: 'A team with that handle already exists.' });
    }
    console.error('[members-teams-mgmt] create team error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/members-teams-mgmt/team/:id
// ---------------------------------------------------------------------------

router.delete('/team/:id', pbAuth, async (req, res) => {
  const { id } = req.params;
  const { pbClient } = res.locals;

  try {
    await pbClient.withRetry(
      () => pbClient.pbFetch('delete', `/v2/teams/${id}`),
      `delete team ${id}`
    );
    res.json({ ok: true });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    if (status === 404) {
      return res.status(404).json({ error: 'Team not found.' });
    }
    console.error('[members-teams-mgmt] delete team error:', err.message);
    res.status(500).json({ error: parseApiError(err) });
  }
});

module.exports = router;
