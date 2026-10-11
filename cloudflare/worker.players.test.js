import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

const player = {
  id: 17,
  guild_id: "guild-1",
  user_id: "player-1",
  username: "DateTester",
  uuid: "00000000000000000000000000000017",
  region: "EU",
  current_tier: "LT3",
  peak_tier: "HT2",
  ogvanilla_tier: null,
  vanilla_tier: null,
  uhc_tier: null,
  pot_tier: null,
  nethop_tier: null,
  smp_tier: null,
  sword_tier: "LT3",
  axe_tier: null,
  mace_tier: null,
  speed_tier: null,
  spear_mace_tier: null,
  minecart_tier: null,
  diamond_smp_tier: null,
  updated_at: 1_700_000_000_000,
};

const history = [
  { mode: "sword", tier: "LT3", created_at: 1_700_000_000_000 },
  { mode: "sword", tier: "LT3", created_at: 1_650_000_000_000 },
  { mode: "sword", tier: "HT4", created_at: 1_600_000_000_000 },
];

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
    return { success: true };
  }

  async all() {
    if (/SELECT \* FROM players WHERE lower\(username\)/i.test(this.sql)) {
      return { results: [this.db.player] };
    }
    if (/SELECT mode, tier, created_at FROM tier_results/i.test(this.sql)) {
      return { results: this.db.history };
    }
    return { results: [] };
  }
}

class MockD1 {
  constructor(playerData, historyRows) {
    this.player = playerData;
    this.history = historyRows;
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }
}

test("player response exposes the start of the current per-mode tier streak in Unix seconds", async () => {
  const response = await worker.fetch(
    new Request("https://api.test/api/players/DateTester"),
    { DB: new MockD1(player, history) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tierDates, { sword: 1_650_000_000 });
});

test("player response does not invent a date when history does not match the current tier", async () => {
  const response = await worker.fetch(
    new Request("https://api.test/api/players/DateTester"),
    {
      DB: new MockD1(player, [
        { mode: "sword", tier: "HT4", created_at: 1_600_000_000_000 },
      ]),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tierDates, {});
});
