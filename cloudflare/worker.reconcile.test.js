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
    this.db.schemaRuns++;
    return { success: true };
  }

  async all() {
    return { results: [] };
  }
}

class MockD1 {
  constructor() {
    this.batches = [];
    this.schemaRuns = 0;
    this.events = new Set();
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.map(({ sql, params }) => ({ sql, params })));
    return statements.map((statement) => {
      if (/^SELECT id FROM tier_results/i.test(statement.sql.trim()) && statement.params.length === 2) {
        const key = `${statement.params[0]}:${statement.params[1]}`;
        return { results: this.events.has(key) ? [{ id: 1 }] : [] };
      }

      if (/INSERT OR IGNORE INTO tier_results/i.test(statement.sql)) {
        const sourceChannelId = statement.params[11];
        const sourceMessageId = statement.params[12];
        this.events.add(`${sourceChannelId}:${sourceMessageId}`);
      }
      return { results: [] };
    });
  }
}

const results = [
  { guildId: "guild-1", userId: "player-1", username: "CutieSad", uuid: "00000000000000000000000000000001", mode: "axe", tier: "LT3", createdAt: 100, sourceChannelId: "channel-1", sourceMessageId: "message-axe" },
  { guildId: "guild-1", userId: "player-1", username: "CutieSad", uuid: "00000000000000000000000000000001", mode: "mace", tier: "HT5", createdAt: 200, sourceChannelId: "channel-1", sourceMessageId: "message-mace" },
  { guildId: "guild-1", userId: "player-1", username: "CutieSad", uuid: "00000000000000000000000000000001", mode: "sword", tier: "LT2", createdAt: 300, sourceChannelId: "channel-1", sourceMessageId: "message-sword" },
];

test("reconciliation batches D1 reads and writes, and replays do not duplicate history", async () => {
  const DB = new MockD1();
  const env = { DB, WEBSITE_API_SECRET: "test-secret" };

  async function send() {
    const response = await worker.fetch(
      new Request("https://api.test/api/webhook/reconcile-tiers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-secret": "test-secret",
        },
        body: JSON.stringify({ results }),
      }),
      env,
    );
    return { response, body: await response.json() };
  }

  const first = await send();
  assert.equal(first.response.status, 200);
  assert.deepEqual(first.body, { ok: true, updated: 3, inserted: 3, skipped: 0 });
  assert.equal(DB.batches.length, 2, "duplicate checks and all writes should use one D1 batch each");
  assert.equal(DB.batches[0].length, results.length);

  const writes = DB.batches[1];
  assert.equal(writes.filter((statement) => /INSERT INTO players/i.test(statement.sql)).length, 1);
  assert.equal(writes.filter((statement) => /INSERT OR IGNORE INTO tier_results/i.test(statement.sql)).length, 3);
  const playerUpsert = writes.find((statement) => /INSERT INTO players/i.test(statement.sql));
  assert.match(playerUpsert.sql, /axe_tier/);
  assert.match(playerUpsert.sql, /mace_tier/);
  assert.match(playerUpsert.sql, /sword_tier/);
  assert.equal(playerUpsert.params[5], "LT2", "current tier should follow the newest result timestamp");

  const replay = await send();
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, { ok: true, updated: 3, inserted: 0, skipped: 3 });
  assert.equal(DB.batches.length, 4);
  assert.equal(
    DB.batches[3].filter((statement) => /INSERT OR IGNORE INTO tier_results/i.test(statement.sql)).length,
    0,
  );
});