/**
 * End-to-end test for per-client area-of-interest visibility in MyRoom.
 *
 * Spins up a real @colyseus/core server (WebSocket transport) and connects
 * real @colyseus/sdk clients. The server keeps the full player list in
 * state.players, but each client only receives players within VIEW_RADIUS
 * of its own position, with hysteresis guarding the boundary.
 *
 * Run: node --import tsx test/aoi-visibility.test.ts
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Server } from "@colyseus/core";
import { Client, type Room } from "@colyseus/sdk";

const PORT = 2599;
const ENDPOINT = `ws://localhost:${PORT}`;

// Room/database modules are imported dynamically inside `before` AFTER setting
// DATABASE_URL, so the GameDatabase singleton boots against an isolated
// in-memory sqlite file instead of the shared on-disk colyseus.db (which
// other tests in this package wipe).
process.env.DATABASE_URL = ":memory:";
process.env.NODE_ENV = "test";

let server: Server;
let VIEW_RADIUS: number;
type MyRoomState = import("../src/MyRoom.ts").MyRoomState;

before(async () => {
  const roomModule = await import("../src/MyRoom.ts");
  const { database } = await import("../src/db/database.ts");

  VIEW_RADIUS = roomModule.VIEW_RADIUS;

  // The room's analytics/cloud-save/leaderboard plugins require a booted
  // GameDatabase — the in-memory sqlite above keeps this test self-contained.
  await database.boot();

  server = new Server();
  // Same room name the example page's button connects to.
  server.define("my_room_2", roomModule.MyRoom);
  await server.listen(PORT);
});

after(async () => {
  await server.gracefullyShutdown(false);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Teleport a connected player to an exact position via the room's move message. */
async function teleport(room: Room<MyRoomState>, x: number, y: number) {
  room.send("move", { x, y });
  // Wait for the message round-trip plus one 30Hz AOI tick + one patch.
  await wait(120);
}

describe("MyRoom area-of-interest visibility", () => {
  it("hides far players from each client while the server keeps the full list", async () => {
    const observer = new Client(ENDPOINT);
    const roomA = await observer.joinOrCreate<MyRoomState>("my_room_2");

    // Pin the observer to a known spot.
    await teleport(roomA, 100, 100);

    // Bring 19 more clients into the SAME room, spread across the 800x600 map.
    const others: Room<MyRoomState>[] = [];
    for (let i = 0; i < 19; i++) {
      const c = new Client(ENDPOINT);
      const r = await c.joinById<MyRoomState>(roomA.roomId);
      const angle = (i / 19) * Math.PI * 2;
      const radius = 60 + (i % 4) * 70; // 60..270
      await teleport(
        r,
        Math.max(0, Math.min(800, 100 + Math.cos(angle) * radius)),
        Math.max(0, Math.min(600, 100 + Math.sin(angle) * radius)),
      );
      others.push(r);
    }

    // Server-side count: 20 players in the room.
    assert.equal(others.length + 1, 20);
    assert.equal(roomA.state.mapWidth, 800, "map width stays 800");
    assert.equal(roomA.state.mapHeight, 600, "map height stays 600");

    // Let the 30Hz AOI loop run several ticks.
    await wait(300);

    // Observer's client state: only players actually within 200px.
    const me = roomA.state.players.get(roomA.sessionId)!;
    const clientCount = roomA.state.players.size;
    assert.ok(clientCount < 20, `far players must not reach the client (saw ${clientCount}/20)`);
    assert.ok(clientCount >= 1, "the client's own player must always be visible");
    for (const [id, p] of roomA.state.players.entries()) {
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      assert.ok(d <= VIEW_RADIUS + 0.001, `player ${id} at distance ${d.toFixed(2)} leaked into client state`);
    }

    // An independent client gets its own view rather than a shared list.
    const otherClient = others[0];
    const otherMe = otherClient.state.players.get(otherClient.sessionId)!;
    for (const [id, p] of otherClient.state.players.entries()) {
      const d = Math.hypot(p.x - otherMe.x, p.y - otherMe.y);
      assert.ok(d <= VIEW_RADIUS + 0.001, `other client received ${id} at distance ${d.toFixed(2)}`);
    }

    await roomA.leave();
    await Promise.all(others.map((r) => r.leave()));
  });

  it("adds a player when they walk into 200px and removes them past the buffered boundary", async () => {
    const observer = new Client(ENDPOINT);
    const roomA = await observer.joinOrCreate<MyRoomState>("my_room_2");
    await teleport(roomA, 400, 300);

    const wandererClient = new Client(ENDPOINT);
    const roomB = await wandererClient.joinById<MyRoomState>(roomA.roomId);
    await teleport(roomB, 400, 10); // 290px away — outside the circle
    await wait(200);

    const idB = roomB.sessionId;
    assert.equal(roomA.state.players.has(idB), false, "wanderer starts outside the observer's state");

    // Walk down in 5px steps exactly like the arrow-key move loop.
    for (let y = 10; y <= 140; y += 5) {
      await teleport(roomB, 400, y);
    }
    // y=140 → 160px from observer, inside the 200 circle.
    assert.equal(roomA.state.players.has(idB), true, "wanderer appears once within 200px");
    assert.equal(roomA.state.players.get(idB)!.y, 140);

    // Walk back out: hysteresis keeps them until 220px, then drops them.
    for (let y = 140; y >= 0; y -= 5) {
      await teleport(roomB, 400, y);
    }
    await wait(200);
    assert.equal(roomA.state.players.has(idB), false, "wanderer disappears after leaving the buffered circle");

    await roomA.leave();
    await roomB.leave();
  });

  it("keeps a boundary player visible while jittering between 199px and 204px", async () => {
    const observer = new Client(ENDPOINT);
    const roomA = await observer.joinOrCreate<MyRoomState>("my_room_2");
    await teleport(roomA, 400, 300);

    const jitterClient = new Client(ENDPOINT);
    const roomB = await jitterClient.joinById<MyRoomState>(roomA.roomId);
    await teleport(roomB, 400, 99); // distance 201 — just outside
    await wait(200);

    const idB = roomB.sessionId;
    assert.equal(roomA.state.players.has(idB), false);

    // Step in to 199px — enters.
    await teleport(roomB, 400, 101);
    assert.equal(roomA.state.players.has(idB), true, "enters at 199px");

    // Out to 204px — beyond 200 but inside the 220 hysteresis buffer: must stay.
    await teleport(roomB, 400, 96);
    assert.equal(roomA.state.players.has(idB), true, "stays visible inside hysteresis buffer");

    // Back to 199px — still there, no re-add churn.
    await teleport(roomB, 400, 101);
    assert.equal(roomA.state.players.has(idB), true, "no flicker when stepping back in");

    // One more out-and-in pair, simulating holding the direction key.
    await teleport(roomB, 400, 96);
    await teleport(roomB, 400, 101);
    assert.equal(roomA.state.players.has(idB), true, "stable across repeated boundary steps");

    // A genuinely far move finally removes the player.
    await teleport(roomB, 400, 10); // 290px
    await wait(200);
    assert.equal(roomA.state.players.has(idB), false, "removed once clearly beyond the buffer");

    await roomA.leave();
    await roomB.leave();
  });
});
