import { CloseCode, Room, type Client, validate, type Messages, type AuthContext, definePlugins } from "@colyseus/core";
import { schema, t, StateView, type SchemaType } from "@colyseus/schema";
import { AnalyticsPlugin, CloudSavesPlugin, LeaderboardsPlugin } from "@colyseus/database";
import { z } from "zod";
import { database } from "./db/database.ts";
// Importing @colyseus/auth installs a JWT-decoding default for
// Room.onAuth (side-effect import). The example already imports it
// elsewhere via app.config.ts, but pinning the import here documents
// the dependency for anyone reading just this room file.
import "@colyseus/auth";
import { TrackUserSessionsPlugin } from "colyseus/plugins/track-user-sessions";

const VERSION = 5;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  // `.view()` turns `players` into a view-scoped collection: the full list
  // still lives on the server, but each client only receives the entries its
  // own StateView opts into (see updateVisibility() below).
  players: t.map(Player).view(),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;

/**
 * Area-of-interest radius (pixels). A client only receives players whose
 * distance to its own player is at most this value. 200 = a quarter of the
 * 800px-wide map, matching the canvas/collage layout.
 */
export const VIEW_RADIUS = 200;
const VIEW_RADIUS_SQUARED = VIEW_RADIUS * VIEW_RADIUS;

/**
 * Anti-flicker margin (pixels). A player already inside a client's view stays
 * visible until it crosses VIEW_RADIUS + HYSTERESIS_MARGIN, and only enters
 * once it is within VIEW_RADIUS. Stepping back and forth exactly on the
 * boundary therefore can't make a circle appear/disappear on consecutive
 * frames.
 */
const HYSTERESIS_MARGIN = 20;

const thirdPartyMessages: Messages<MyRoom> = {
  nopayload: function (client: MyClient, message: any) {
    this.broadcast("hello", {});
    client.send("hello", {});
  },

  with_validation: validate(z.object({
    name: z.string(),
  }), function (client: MyClient, message: any) {
    this.broadcast("obj_message", { message: "hello" });
    client.send("obj_message", { message: "hello" })
  }),

  // _ and * are equivalent (fallback handlers)
  // we're using both just to check types
  _: function (client: MyClient, type: string, message: any) {
    this.broadcast("hello", {});
  },
  // // _ and * are equivalent (fallback handlers)
  // // we're using both just to check types
  // '*': function (client: MyClient, type: string, message: any) {
  //   this.broadcast("hello", {});
  // },
}

type MyClient = Client<{
  userData: { custom: boolean };
  auth: { custom: boolean };
  messages: {
    nopayload: never;
    message: any;
    nopayload_2: any;
    obj_message: { message: string };
    hello: any;
  };
}>;

const Input = schema({
  seq: t.number(),
  x: t.number(),
  y: t.number(),
});
type Input = SchemaType<typeof Input>;

export class MyRoom extends Room<{ state: MyRoomState, client: MyClient, input: Input }> {
  state = new MyRoomState();

  // Database-driven plugins — one instance per room. The framework
  // walks this record at __init, computes the lifecycle/message layout
  // ONCE per Room class (cached on the constructor), and installs hook
  // wrappers on the prototype. Subsequent constructs of MyRoom reuse
  // the cached layout. Public methods are reachable as
  // `this.plugins.<key>.<method>(...)` with full types.

  plugins = definePlugins([
    new TrackUserSessionsPlugin(),
    new AnalyticsPlugin({ database, prefix: 'my_room' }),
    new CloudSavesPlugin({
      database,
      slot: 0,
      payload: (room, client) => {
        const player = room.state.players.get(client.sessionId);
        return player ? { x: player.x, y: player.y, score: player.score } : null;
      },
      apply: (room, client, data) => {
        const player = room.state.players.get(client.sessionId);
        if (!player || !data) return;
        const d = data as { x: number; y: number; score: number };
        player.x = d.x;
        player.y = d.y;
        player.score = d.score;
      },
    }),
    new LeaderboardsPlugin({
      database,
      boardId: 'my_room_score',
      boardName: 'MyRoom Score',
      score: (room, client) => room.state.players.get(client.sessionId)?.score ?? null,
    })
  ]);

  messages = {
    ...thirdPartyMessages,
    move: validate(z.object({
      x: z.number(),
      y: z.number(),
      z: z.number().optional()
    }), (client, message) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
      console.log("MOVE", { sessionId: client.sessionId, VERSION });
    }),

    nopayload_2: (client: MyClient, message: any) => {
      client.send("obj_message", { message: "hello" })
      this.broadcast("obj_message", { message: "hello" })
    },

    _: (client: MyClient, type: string, message: any) => {
      this.broadcast(type as any, message);
    },
  };

  onCreate(options: any) {
    this.seatReservationTimeout = 31;

    // map dimensions
    this.state.mapWidth = 800;
    this.state.mapHeight = 600;

    this.onMessage("__move", (client, message) => {})
    this.onMessage("__dummy", (client, message) => { })

    this.onMessage("move_with_validation", z.object({ x: z.number(), y: z.number() }), (client, message) => {
      const player = this.state.players.get(client.sessionId)!;
      player.x = message.x;
      player.y = message.y;
    });

    // Re-evaluate every client's area of interest at 30Hz — the same rate at
    // which the client sends arrow-key moves. Each client keeps its own
    // StateView, so two clients standing apart receive different player lists
    // while the authoritative `state.players` map always holds all 20.
    this.setSimulationInterval(() => this.update(), 1000 / 30);
  }

  onJoin(client: MyClient, options: any) {
    const player = new Player();
    player.x = Math.random() * this.state.mapWidth;
    player.y = Math.random() * this.state.mapHeight;
    this.state.players.set(client.sessionId, player);

    // Per-client view of the state. The room's full player list is untouched;
    // only entries added to this view are encoded for this client.
    client.view = new StateView();
    this.updateClientVisibility(client);

    console.log("ON JOIN", { VERSION });
  }

  public onReconnect(client: MyClient): void | Promise<any> {
    console.log(client.sessionId, "reconnected!");
  }

  update() {
    // Refresh each client's area of interest. add()/remove() only touch the
    // client's own StateView; the shared state keeps every player in the room.
    for (const client of this.clients) {
      this.updateClientVisibility(client);
    }
  }

  /**
   * Reconcile one client's StateView with the area around its own player.
   *
   * - Players within VIEW_RADIUS are added to the view (if not already there).
   * - Players already visible are kept until they pass VIEW_RADIUS plus the
   *   hysteresis margin, so jittering on the boundary never flickers.
   * - The client's own player is always visible.
   */
  private updateClientVisibility(client: MyClient): void {
    const view = client.view;
    if (!view) { return; }

    const self = this.state.players.get(client.sessionId);
    if (!self) { return; }

    const leaveRadiusSquared =
      (VIEW_RADIUS + HYSTERESIS_MARGIN) * (VIEW_RADIUS + HYSTERESIS_MARGIN);

    this.state.players.forEach((player, sessionId) => {
      const dx = player.x - self.x;
      const dy = player.y - self.y;
      const distanceSquared = dx * dx + dy * dy;

      const isVisible = view.has(player);

      if (distanceSquared <= VIEW_RADIUS_SQUARED) {
        // Enter (or stay in) the inner circle.
        if (!isVisible) {
          view.add(player);
        }

      } else if (isVisible && distanceSquared > leaveRadiusSquared) {
        // Only drop once clearly outside the buffered outer circle — this is
        // the hysteresis guard against boundary flicker.
        view.remove(player);
      }
    });
  }

  async onLeave(client, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }

      console.log(client.sessionId, "waiting for reconnection...");
      await this.allowReconnection(client, 10);

      console.log(client.sessionId, "reconnected!");

    } catch (e) {
      this.state.players.delete(client.sessionId);
      // Release the per-client view's ID and its visibility bits so a future
      // client can't inherit this view's filtering state.
      client.view?.dispose();
      client.view = undefined;
      console.log(client.sessionId, "left!");
    }
  }

  onCacheRoom() {
    return { hello: true };
  }

  onRestoreRoom(cached: any): void {
    console.log("onRestoreRoom", cached);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  onBeforeShutdown() {
    //
    // Disconnect all clients after 5 seconds
    //
    this.clock.setTimeout(() => this.disconnect(), 5 * 1000);
  }

}
