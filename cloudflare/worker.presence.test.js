import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

function installCache() {
  const entries = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: {
      default: {
        async match(request) {
          return entries.get(request.url)?.clone();
        },
        async put(request, response) {
          entries.set(request.url, response.clone());
        },
      },
    },
  });

  return () => {
    if (original) {
      Object.defineProperty(globalThis, "caches", original);
    } else {
      delete globalThis.caches;
    }
  };
}

class MockPresenceStatement {
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
    if (/INSERT INTO presence/i.test(this.sql)) {
      this.db.upserts++;
      this.db.presence.set(this.params[0], this.params[1]);
    } else if (/DELETE FROM presence/i.test(this.sql)) {
      this.db.cleanups++;
      for (const [id, lastSeen] of this.db.presence) {
        if (lastSeen < this.params[0]) this.db.presence.delete(id);
      }
    }
    return { success: true };
  }

  async all() {
    if (/COUNT\(\*\) AS count FROM presence/i.test(this.sql)) {
      this.db.countReads++;
      const activeSince = this.params[0];
      const count = [...this.db.presence.values()].filter(time => time >= activeSince).length;
      return { results: [{ count }] };
    }
    return { results: [] };
  }
}

class MockPresenceD1 {
  constructor() {
    this.presence = new Map();
    this.upserts = 0;
    this.cleanups = 0;
    this.countReads = 0;
  }

  prepare(sql) {
    return new MockPresenceStatement(this, sql);
  }
}

class MockResultsStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  bind() {
    return this;
  }

  async all() {
    this.db.reads++;
    if (/WHERE is_high_tier = 1/i.test(this.sql)) {
      return { results: [this.db.highTierResult] };
    }
    return { results: [this.db.liveResult] };
  }
}

class MockResultsD1 {
  constructor() {
    this.reads = 0;
    this.liveResult = {
      id: 1,
      guild_id: "guild-1",
      user_id: "player-1",
      username: "LivePlayer",
      tester_id: null,
      tester_name: null,
      tier: "LT3",
      mode: "sword",
      region: "EU",
      ticket_type: "test",
      is_high_tier: 0,
      created_at: 1_700_000_000_000,
    };
    this.highTierResult = {
      ...this.liveResult,
      id: 2,
      username: "HighPlayer",
      tier: "HT1",
      is_high_tier: 1,
    };
  }

  prepare(sql) {
    return new MockResultsStatement(this, sql);
  }
}

test("presence heartbeats reuse the cached count instead of recounting on every write", async () => {
  const restoreCache = installCache();
  try {
    const DB = new MockPresenceD1();
    const env = { DB };
    const first = await worker.fetch(
      new Request("https://api.test/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "visitor-1" }),
      }),
      env,
    );
    const second = await worker.fetch(
      new Request("https://api.test/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "visitor-1" }),
      }),
      env,
    );

    assert.deepEqual(await first.json(), { online: 1 });
    assert.deepEqual(await second.json(), { online: 1 });
    assert.equal(DB.upserts, 2, "each heartbeat records its last-seen timestamp");
    assert.equal(DB.cleanups, 1, "expired visitors are removed only on a count refresh");
    assert.equal(DB.countReads, 1, "the second heartbeat uses the cached count");
  } finally {
    restoreCache();
  }
});

test("combined results feed returns both lists and is edge-cached", async () => {
  const restoreCache = installCache();
  try {
    const DB = new MockResultsD1();
    const env = { DB };
    const first = await worker.fetch(
      new Request("https://api.test/api/results/feed?client=home"),
      env,
    );
    const second = await worker.fetch(
      new Request("https://api.test/api/results/feed?client=results-page"),
      env,
    );

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const body = await first.json();
    assert.equal(body.liveResults[0].username, "LivePlayer");
    assert.equal(body.highTierResults[0].username, "HighPlayer");
    assert.equal(DB.reads, 2, "the second client reuses the cached combined response");
    assert.match(second.headers.get("cache-control"), /max-age=60/);
  } finally {
    restoreCache();
  }
});
