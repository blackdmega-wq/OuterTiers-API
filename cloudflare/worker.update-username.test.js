import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    const sql = this.sql.replace(/\s+/g, " ").trim();
    if (/INSERT OR IGNORE INTO players \(guild_id, user_id, username, uuid, updated_at\)/i.test(sql)) {
      const [guildId, userId, username, uuid, updatedAt] = this.params;
      const existing = this.db.players.find(player =>
        player.guild_id === guildId && player.user_id === userId,
      );
      if (!existing) {
        this.db.players.push({
          id: this.db.nextId++,
          guild_id: guildId,
          user_id: userId,
          username,
          uuid,
          updated_at: updatedAt,
        });
      }
    }

    if (/UPDATE players SET username = \?, uuid = COALESCE\(\?, uuid\), updated_at = \? WHERE id = \?/i.test(sql)) {
      const [username, uuid, updatedAt, id] = this.params;
      const player = this.db.players.find(row => row.id === id);
      if (player) {
        player.username = username;
        player.uuid = uuid || player.uuid;
        player.updated_at = updatedAt;
      }
    }
    return { success: true };
  }

  async all() {
    const sql = this.sql.replace(/\s+/g, " ").trim();
    if (/SELECT \* FROM players WHERE guild_id = \? AND user_id = \? LIMIT 1/i.test(sql)) {
      const [guildId, userId] = this.params;
      const row = this.db.players.find(player =>
        player.guild_id === guildId && player.user_id === userId,
      );
      return { results: row ? [row] : [] };
    }
    if (/SELECT \* FROM players WHERE guild_id = \? AND lower\(uuid\) = lower\(\?\) LIMIT 1/i.test(sql)) {
      const [guildId, uuid] = this.params;
      const row = this.db.players.find(player =>
        player.guild_id === guildId && String(player.uuid || "").toLowerCase() === String(uuid).toLowerCase(),
      );
      return { results: row ? [row] : [] };
    }
    if (/SELECT username, uuid FROM players WHERE id = \? LIMIT 1/i.test(sql)) {
      const [id] = this.params;
      const row = this.db.players.find(player => player.id === id);
      return { results: row ? [{ username: row.username, uuid: row.uuid }] : [] };
    }
    return { results: [] };
  }
}

class MockD1 {
  constructor() {
    this.players = [];
    this.nextId = 1;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }
}

async function sendUpdate(DB, { uuid }) {
  const response = await worker.fetch(
    new Request("https://api.test/api/webhook/tier", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-secret": "test-secret",
      },
      body: JSON.stringify({
        type: "update-username",
        guildId: "guild-1",
        userId: "player-1",
        username: "Player_One",
        uuid,
        forceIdentityUpdate: true,
      }),
    }),
    { DB, WEBSITE_API_SECRET: "test-secret" },
  );
  return { response, body: await response.json() };
}

test("creates a minimal website player row when the verified identity is new", async () => {
  const DB = new MockD1();
  const result = await sendUpdate(DB, { uuid: "01234567-89ab-cdef-0123-456789abcdef" });

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    ok: true,
    updated: 1,
    username: "Player_One",
    uuid: "0123456789abcdef0123456789abcdef",
  });
  assert.equal(DB.players.length, 1);
  assert.equal(DB.players[0].guild_id, "guild-1");
  assert.equal(DB.players[0].user_id, "player-1");
});

test("does not create a website player row when no valid UUID is available", async () => {
  const DB = new MockD1();
  const result = await sendUpdate(DB, { uuid: null });

  assert.equal(result.response.status, 404);
  assert.equal(result.body.error, "Player not found");
  assert.equal(DB.players.length, 0);
});
