import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = this.sqlText = sql.replace(/\s+/g, " ").trim();
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
    if (/SELECT \* FROM players WHERE guild_id = \? AND user_id = \? LIMIT 1/i.test(this.sqlText)) {
      const [guildId, userId] = this.params;
      const row = this.db.players.find(player => player.guild_id === guildId && player.user_id === userId);
      return { results: row ? [{ ...row }] : [] };
    }
    return { results: [] };
  }

  async run() {
    if (/INSERT INTO players \(/i.test(this.sqlText)) {
      const columns = [
        "guild_id", "user_id", "username", "discord_username", "uuid", "region",
        "current_tier", "peak_tier", "ogvanilla_tier", "vanilla_tier", "uhc_tier",
        "pot_tier", "nethop_tier", "smp_tier", "sword_tier", "axe_tier", "mace_tier",
        "speed_tier", "spear_mace_tier", "minecart_tier", "diamond_smp_tier", "updated_at",
      ];
      const record = Object.fromEntries(columns.map((column, index) => [column, this.params[index]]));
      const existing = this.db.players.find(player =>
        player.guild_id === record.guild_id && player.user_id === record.user_id,
      );
      if (existing) Object.assign(existing, record);
      else this.db.players.push({ id: this.db.nextPlayerId++, ...record });
    } else if (/INSERT INTO punishments \(/i.test(this.sqlText) && /\bSELECT\b/i.test(this.sqlText)) {
      const [newUserId, guildId, oldUserId] = this.params;
      const sourceRows = this.db.punishments.filter(row =>
        row.guild_id === guildId && row.user_id === oldUserId,
      );
      for (const source of sourceRows) {
        const exists = this.db.punishments.some(target =>
          target.guild_id === source.guild_id
          && target.user_id === newUserId
          && target.type === source.type
          && target.created_at === source.created_at
          && target.reason === source.reason
          && target.duration_ms === source.duration_ms
          && target.expires_at === source.expires_at
          && target.moderator_id === source.moderator_id,
        );
        if (!exists) this.db.punishments.push({ ...source, id: this.db.nextPunishmentId++, user_id: newUserId });
      }
    } else if (/UPDATE tier_results SET user_id = \?/i.test(this.sqlText)) {
      const [newUserId, guildId, oldUserId] = this.params;
      for (const row of this.db.tierResults) {
        if (row.guild_id === guildId && row.user_id === oldUserId) row.user_id = newUserId;
      }
    } else if (/INSERT OR IGNORE INTO player_name_history .*SELECT source/i.test(this.sqlText)) {
      const [newUserId, guildId, oldUserId] = this.params;
      const sourceRows = this.db.nameHistory.filter(row =>
        row.guild_id === guildId && row.user_id === oldUserId,
      );
      for (const source of sourceRows) {
        const exists = this.db.nameHistory.some(target =>
          target.guild_id === guildId
          && target.user_id === newUserId
          && target.username.toLowerCase() === source.username.toLowerCase(),
        );
        if (!exists) this.db.nameHistory.push({ ...source, user_id: newUserId });
      }
    } else if (/DELETE FROM player_name_history WHERE guild_id = \? AND user_id = \?/i.test(this.sqlText)) {
      const [guildId, userId] = this.params;
      this.db.nameHistory = this.db.nameHistory.filter(row =>
        row.guild_id !== guildId || row.user_id !== userId,
      );
    } else if (/DELETE FROM players WHERE guild_id = \? AND user_id = \?/i.test(this.sqlText)) {
      const [guildId, userId] = this.params;
      this.db.players = this.db.players.filter(player =>
        player.guild_id !== guildId || player.user_id !== userId,
      );
    }
    return { success: true };
  }
}

class MockD1 {
  constructor({ players = [], punishments = [], tierResults = [], nameHistory = [] } = {}) {
    this.players = players.map(row => ({ ...row }));
    this.punishments = punishments.map(row => ({ ...row }));
    this.tierResults = tierResults.map(row => ({ ...row }));
    this.nameHistory = nameHistory.map(row => ({ ...row }));
    this.nextPlayerId = 100;
    this.nextPunishmentId = 100;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }
}

const uuid = "0123456789abcdef0123456789abcdef";
const oldPlayer = {
  id: 1,
  guild_id: "guild-1",
  user_id: "old-discord",
  username: "Player_One",
  discord_username: "old-account",
  uuid,
  region: "EU",
  current_tier: "HT2",
  peak_tier: "HT1",
  updated_at: 100,
};

async function postTransfer(DB, path, body) {
  const response = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-secret": "test-secret" },
      body: JSON.stringify(body),
    }),
    { DB, WEBSITE_API_SECRET: "test-secret" },
  );
  return { response, body: await response.json() };
}

test("preflight accepts matching UUIDs and refuses a different linked identity", async () => {
  const DB = new MockD1({
    players: [
      oldPlayer,
      { ...oldPlayer, id: 2, user_id: "new-discord", uuid: `01234567-${uuid.slice(8)}` },
    ],
  });
  const valid = await postTransfer(DB, "/api/webhook/account-transfer/preflight", {
    guildId: "guild-1", oldUserId: "old-discord", newUserId: "new-discord", expectedUuid: uuid,
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.ok, true);

  DB.players.find(row => row.user_id === "new-discord").uuid = "fedcba9876543210fedcba9876543210";
  const conflict = await postTransfer(DB, "/api/webhook/account-transfer/preflight", {
    guildId: "guild-1", oldUserId: "old-discord", newUserId: "new-discord", expectedUuid: uuid,
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(DB.players.length, 2, "preflight must not mutate either account");
});

test("copies sanctions and account history while retaining old punishment rows", async () => {
  const DB = new MockD1({
    players: [oldPlayer],
    punishments: [
      {
        id: 1, guild_id: "guild-1", user_id: "old-discord", username: "Player_One",
        type: "blacklist", reason: "Abuse", created_at: 10, active: 1, moderator_id: "mod-1",
      },
      {
        id: 2, guild_id: "guild-1", user_id: "old-discord", username: "Player_One",
        type: "restrict", reason: "Review", created_at: 20, active: 1, moderator_id: "mod-2",
      },
    ],
    tierResults: [{ id: 5, guild_id: "guild-1", user_id: "old-discord" }],
    nameHistory: [{ guild_id: "guild-1", user_id: "old-discord", username: "Old_Name", uuid, observed_at: 5 }],
  });

  const result = await postTransfer(DB, "/api/webhook/account-transfer", {
    guildId: "guild-1", oldUserId: "old-discord", newUserId: "new-discord", expectedUuid: uuid,
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.transferred, true);
  assert.equal(DB.players.length, 1);
  assert.equal(DB.players[0].user_id, "new-discord");
  assert.equal(DB.players[0].current_tier, "HT2");
  assert.equal(DB.punishments.length, 4);
  assert.equal(DB.punishments.filter(row => row.user_id === "old-discord").length, 2);
  assert.equal(DB.punishments.filter(row => row.user_id === "new-discord").length, 2);
  assert.equal(DB.tierResults[0].user_id, "new-discord");
  assert.equal(DB.nameHistory[0].user_id, "new-discord");

  const retry = await postTransfer(DB, "/api/webhook/account-transfer", {
    guildId: "guild-1", oldUserId: "old-discord", newUserId: "new-discord", expectedUuid: uuid,
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(DB.punishments.length, 4);
});

test("rejects a different UUID before changing data", async () => {
  const DB = new MockD1({
    players: [
      oldPlayer,
      { ...oldPlayer, id: 2, user_id: "new-discord", uuid: "fedcba9876543210fedcba9876543210" },
    ],
    punishments: [{ id: 1, guild_id: "guild-1", user_id: "old-discord", type: "blacklist", created_at: 1 }],
  });

  const result = await postTransfer(DB, "/api/webhook/account-transfer", {
    guildId: "guild-1", oldUserId: "old-discord", newUserId: "new-discord", expectedUuid: uuid,
  });

  assert.equal(result.response.status, 409);
  assert.equal(DB.players.length, 2);
  assert.equal(DB.punishments.length, 1);
  assert.equal(DB.punishments[0].user_id, "old-discord");
});
