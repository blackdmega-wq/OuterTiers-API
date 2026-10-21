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
    this.db.runs.push({ sql: this.sql, params: this.params });
    return { success: true, meta: { changes: 1 } };
  }

  async all() {
    if (/SELECT \* FROM players ORDER BY updated_at DESC, id DESC/i.test(this.sql)) {
      this.db.playerListReads++;
      return { results: this.db.players };
    }
    if (/SELECT \* FROM players WHERE lower\(username\)/i.test(this.sql)) {
      return { results: [this.db.player] };
    }
    if (/SELECT mode, tier, created_at FROM tier_results/i.test(this.sql)) {
      return { results: this.db.history };
    }
    if (/FROM punishments WHERE guild_id = \? AND user_id = \? AND active = 1/i.test(this.sql)) {
      return { results: this.db.punishments };
    }
    return { results: [] };
  }
}

class MockD1 {
  constructor(playerData, historyRows, punishmentRows = []) {
    this.player = playerData;
    this.players = playerData ? [playerData] : [];
    this.playerListReads = 0;
    this.history = historyRows;
    this.punishments = punishmentRows;
    this.runs = [];
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
  assert.equal(body.id, "17", "id remains the internal player row ID");
  assert.equal(body.user_id, "player-1", "canonical Discord ID is exposed separately");
  assert.deepEqual(body.tierDates, { sword: 1_650_000_000 });
  assert.equal(body.punishmentStatus, null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("profile punishment status ignores expired rows and gives blacklist precedence only while active", async () => {
  const now = Date.now();
  const response = await worker.fetch(
    new Request("https://api.test/api/players/DateTester"),
    {
      DB: new MockD1(player, [], [
        { type: "restrict", active: 1, expiry_mode: "expires", expires_at: now + 60_000 },
        { type: "blacklist", active: 1, expiry_mode: "expires", expires_at: now - 1 },
      ]),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.punishmentStatus, "restricted");
});

test("appealable punishments remain visible after their date", async () => {
  const response = await worker.fetch(
    new Request("https://api.test/api/players/DateTester"),
    {
      DB: new MockD1(player, [], [
        { type: "blacklist", active: 1, expiry_mode: "appealable", expires_at: Date.now() - 1 },
      ]),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.punishmentStatus, "blacklisted");
});

test("pardon webhook can clear only the requested sanction type", async () => {
  const DB = new MockD1(player, []);
  const response = await worker.fetch(
    new Request("https://api.test/api/webhook/pardon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        userId: "player-1",
        type: "restrict",
        allMatching: true,
        pardonedAt: Date.now(),
      }),
    }),
    { DB },
  );

  assert.equal(response.status, 200);
  const update = DB.runs.find((entry) => /UPDATE punishments SET active = 0/.test(entry.sql));
  assert.ok(update);
  assert.match(update.sql, /AND type = \?/);
  assert.equal(update.params.at(-1), "restrict");
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

test("player list cache reuses entries despite legacy refresh parameters", async () => {
  const cacheEntries = new Map();
  const cache = {
    async match(request) {
      return cacheEntries.get(request.url)?.clone();
    },
    async put(request, response) {
      cacheEntries.set(request.url, response.clone());
    },
  };
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: { default: cache },
  });

  try {
    const DB = new MockD1(player, []);
    const env = { DB };
    const first = await worker.fetch(
      new Request("https://cache-test.example/api/players?refresh=first"),
      env,
    );
    const firstBody = await first.json();
    const second = await worker.fetch(
      new Request("https://cache-test.example/api/players?refresh=second"),
      env,
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(first.headers.get("cache-control"), /max-age=900/);
    assert.deepEqual(await second.json(), firstBody);
    assert.equal(DB.playerListReads, 1, "the second request must not read D1 again");
  } finally {
    if (originalCaches) {
      Object.defineProperty(globalThis, "caches", originalCaches);
    } else {
      delete globalThis.caches;
    }
  }
});

test("player punishment history bypasses the public edge cache", async () => {
  const cacheCalls = { matches: 0, puts: 0 };
  const cache = {
    async match() {
      cacheCalls.matches++;
      return new Response(JSON.stringify({ punishments: [{ type: "stale" }] }), {
        headers: { "content-type": "application/json" },
      });
    },
    async put() {
      cacheCalls.puts++;
    },
  };
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: { default: cache },
  });

  try {
    const env = { DB: new MockD1(player, []) };
    const url = "https://cache-test.example/api/players/DateTester/history";
    const first = await worker.fetch(new Request(url), env);
    const second = await worker.fetch(new Request(url), env);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual((await first.json()).punishments, []);
    assert.equal(cacheCalls.matches, 0, "history requests must not read a stale cache entry");
    assert.equal(cacheCalls.puts, 0, "history responses must not be cached");
  } finally {
    if (originalCaches) {
      Object.defineProperty(globalThis, "caches", originalCaches);
    } else {
      delete globalThis.caches;
    }
  }
});
