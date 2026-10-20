export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

interface Player {
  id: string;
  name: string;
  connected: boolean;
  alive: boolean;
  role?: string;
}

type Phase = "lobby" | "night" | "day" | "voting" | "result" | "ended";

// デフォルトの役職ラベル（表示用。自由に増やしてOK）
export const ROLE_LABELS: Record<string, string> = {
  werewolf: "人狼",
  villager: "村人",
  seer: "占い師",
  medium: "霊媒師",
  hunter: "狩人",
  madman: "狂人",
};

export class GameRoom {
  state: DurableObjectState;
  env: Env;
  sockets: Map<string, WebSocket> = new Map(); // playerId -> ws
  gmSocket: WebSocket | null = null;
  players: Map<string, Player> = new Map();
  phase: Phase = "lobby";
  roleConfig: Record<string, number> = {};
  votes: Map<string, string> = new Map();
  gmToken: string | null = null;
  roomCode = "";

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/create" && request.method === "POST") {
      const body = (await request.json()) as { code: string; gmToken: string };
      this.roomCode = body.code;
      this.gmToken = body.gmToken;
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      server.accept();
      this.handleSocket(server, url);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  handleSocket(ws: WebSocket, url: URL) {
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token") || "";
    const name = (url.searchParams.get("name") || "").slice(0, 20);
    const isGm = role === "gm";
    const playerId = url.searchParams.get("pid") || crypto.randomUUID();

    if (isGm) {
      if (this.gmToken && token !== this.gmToken) {
        ws.close(4001, "invalid gm token");
        return;
      }
      this.gmSocket = ws;
      this.sendTo(ws, { type: "state", ...this.publicState() });
    } else {
      let p = this.players.get(playerId);
      if (!p) {
        p = { id: playerId, name: name || "名無し", connected: true, alive: true };
        this.players.set(playerId, p);
      } else {
        p.connected = true;
        if (name) p.name = name;
      }
      this.sockets.set(playerId, ws);
      this.sendTo(ws, { type: "welcome", playerId });
      if (p.role) this.sendTo(ws, { type: "your_role", role: p.role });
      this.broadcastState();
    }

    ws.addEventListener("message", (evt: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }
      this.handleMessage(isGm ? "gm" : playerId, msg);
    });

    ws.addEventListener("close", () => {
      if (isGm) {
        if (this.gmSocket === ws) this.gmSocket = null;
      } else {
        const p = this.players.get(playerId);
        if (p) p.connected = false;
        this.sockets.delete(playerId);
        this.broadcastState();
      }
    });
  }

  handleMessage(sender: string, msg: any) {
    if (sender === "gm") {
      switch (msg.type) {
        case "set_config":
          this.roleConfig = msg.roles || {};
          this.broadcastState();
          break;
        case "start_game":
          this.startGame();
          break;
        case "advance_phase":
          this.advancePhase();
          break;
        case "kick": {
          const id = msg.playerId;
          this.players.delete(id);
          this.sockets.get(id)?.close();
          this.sockets.delete(id);
          this.broadcastState();
          break;
        }
        case "reset":
          this.resetGame();
          break;
      }
    } else {
      switch (msg.type) {
        case "vote":
          if (this.phase === "voting") {
            const voter = this.players.get(sender);
            if (voter && voter.alive) {
              this.votes.set(sender, msg.target);
              this.broadcastState();
            }
          }
          break;
      }
    }
  }

  startGame() {
    const playerIds = [...this.players.keys()];
    const n = playerIds.length;
    if (n === 0) return;

    const roleList: string[] = [];
    for (const [role, count] of Object.entries(this.roleConfig)) {
      for (let i = 0; i < (count as number); i++) roleList.push(role);
    }
    // 設定が足りない分は村人で埋める。多すぎる場合は切り詰める
    while (roleList.length < n) roleList.push("villager");
    roleList.length = n;

    // シャッフル
    for (let i = roleList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
    }

    playerIds.forEach((id, i) => {
      const p = this.players.get(id)!;
      p.role = roleList[i];
      p.alive = true;
      const ws = this.sockets.get(id);
      if (ws) this.sendTo(ws, { type: "your_role", role: p.role });
    });

    this.phase = "night";
    this.votes.clear();
    this.broadcastState();
  }

  advancePhase() {
    if (this.phase === "lobby") {
      // ロビーからは start_game を使う
      return;
    }
    if (this.phase === "night") {
      this.phase = "day";
    } else if (this.phase === "day") {
      this.phase = "voting";
      this.votes.clear();
    } else if (this.phase === "voting") {
      this.resolveVote();
      this.phase = "result";
    } else if (this.phase === "result") {
      const winner = this.checkWin();
      if (winner) {
        this.phase = "ended";
      } else {
        this.phase = "night";
        this.votes.clear();
      }
    }
    this.broadcastState();
  }

  resolveVote() {
    const tally: Record<string, number> = {};
    for (const target of this.votes.values()) {
      tally[target] = (tally[target] || 0) + 1;
    }
    let max = -1;
    let chosen: string | null = null;
    let tie = false;
    for (const [id, c] of Object.entries(tally)) {
      if (c > max) {
        max = c;
        chosen = id;
        tie = false;
      } else if (c === max) {
        tie = true;
      }
    }
    if (chosen && !tie) {
      const p = this.players.get(chosen);
      if (p) p.alive = false;
    }
  }

  checkWin(): string | null {
    const alive = [...this.players.values()].filter((p) => p.alive);
    const wolves = alive.filter((p) => p.role === "werewolf").length;
    const others = alive.length - wolves;
    if (wolves === 0) return "villagers";
    if (wolves >= others) return "werewolves";
    return null;
  }

  resetGame() {
    this.phase = "lobby";
    this.votes.clear();
    for (const p of this.players.values()) {
      p.role = undefined;
      p.alive = true;
    }
    this.broadcastState();
  }

  publicState() {
    return {
      roomCode: this.roomCode,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        alive: p.alive,
        // ゲーム終了後だけ役職を全員に公開する
        role: this.phase === "ended" ? p.role : undefined,
      })),
      roleConfig: this.roleConfig,
      voteCount: [...this.votes.values()].reduce((acc: Record<string, number>, t) => {
        acc[t] = (acc[t] || 0) + 1;
        return acc;
      }, {}),
      votedPlayerIds: [...this.votes.keys()],
      winner: this.phase === "ended" ? this.checkWin() : null,
    };
  }

  broadcastState() {
    const state = { type: "state", ...this.publicState() };
    if (this.gmSocket) this.sendTo(this.gmSocket, state);
    for (const ws of this.sockets.values()) this.sendTo(ws, state);
  }

  sendTo(ws: WebSocket, data: any) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // ignore send errors (socket may be closing)
    }
  }
}
