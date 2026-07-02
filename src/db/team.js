'use strict';

const { query } = require('./pool');

const ROLES = ['operator', 'viewer'];

// The workspace a signed-in account belongs to. Returns null when the account
// is not on anyone's team (i.e. it's an owner account).
async function membershipFor(email) {
  const { rows } = await query(
    `SELECT owner_id, role FROM team_members WHERE email = $1 ORDER BY created_at ASC LIMIT 1`,
    [String(email || '').toLowerCase()],
  );
  return rows[0] ? { ownerId: rows[0].owner_id, role: rows[0].role } : null;
}

async function listMembers(ownerId) {
  const { rows } = await query(
    `SELECT t.id, t.email, t.role, t.created_at,
            (u.id IS NOT NULL) AS joined
       FROM team_members t
       LEFT JOIN users u ON u.email = t.email
      WHERE t.owner_id = $1
      ORDER BY t.created_at ASC`,
    [ownerId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    joined: r.joined === true,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
  }));
}

async function addMember(ownerId, email, role) {
  const e = String(email || '').trim().toLowerCase();
  const r = ROLES.includes(role) ? role : 'operator';
  const { rows } = await query(
    `INSERT INTO team_members (owner_id, email, role) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, email) DO UPDATE SET role = EXCLUDED.role
     RETURNING id`,
    [ownerId, e, r],
  );
  return rows[0] ? rows[0].id : null;
}

async function removeMember(ownerId, memberId) {
  await query(`DELETE FROM team_members WHERE id = $1 AND owner_id = $2`, [memberId, ownerId]);
}

module.exports = { ROLES, membershipFor, listMembers, addMember, removeMember };
