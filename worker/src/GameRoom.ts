export class GameRoom implements DurableObject {
  state: DurableObjectState;
  sessions: Map<WebSocket, { role: "gm" | "player"; id: string; name: string }> = new Map();
  players: Array<{ id: string; name: string; connected: boolean; alive: boolean; role?: string }> = [];
  phase: string = "lobby";
  rolesConfig: Record<string, number> = { werewolf: 1 };

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "player";
    const name = url.searchParams.get("name") || "名無し";
    let pid = url.searchParams.get("pid") || "";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    if (role === "player") {
      if (!pid) pid = Math.random().toString(36).substring(2, 9);
      let p = this.players.find((x) => x.id === pid);
      if (!p) {
        p = { id: pid, name, connected: true, alive: true };
        this.players.push(p);
      } else {
        p.connected = true;
        p.name = name;
      }
      this.sessions.set(server, { role: "player", id: pid, name });
      server.send(JSON.stringify({ type: "welcome", playerId: pid }));
    } else {
      this.sessions.set(server, { role: "gm", id: "gm", name: "GM" });
    }

    this.broadcastState();

    server.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        this.handleMessage(server, msg);
      } catch (e) {}
    });

    server.addEventListener("close", () => {
      const sess = this.sessions.get(server);
      if (sess && sess.role === "player") {
        const p = this.players.find((x) => x.id === sess.id);
        if (p) p.connected = false;
      }
      this.sessions.delete(server);
      this.broadcastState();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(ws: WebSocket, msg: any) {
    const sess = this.sessions.get(ws);
    if (!sess) return;

    if (sess.role === "gm") {
      if (msg.type === "set_config") this.rolesConfig = msg.roles;
      if (msg.type === "start_game") this.startGame();
      if (msg.type === "advance_phase") this.advancePhase();
      if (msg.type === "reset") this.resetGame();
    }
    this.broadcastState();
  }

  startGame() {
    this.phase = "night";
    const rolesList: string[] = [];
    for (const [r, count] of Object.entries(this.rolesConfig)) {
      for (let i = 0; i < count; i++) rolesList.push(r);
    }
    while (rolesList.length < this.players.length) rolesList.push("villager");
    rolesList.sort(() => Math.random() - 0.5);

    this.players.forEach((p, idx) => {
      p.role = rolesList[idx];
      p.alive = true;
    });

    for (const [ws, s] of this.sessions.entries()) {
      if (s.role === "player") {
        const p = this.players.find((x) => x.id === s.id);
        if (p && p.role) {
          ws.send(JSON.stringify({ type: "your_role", role: p.role }));
        }
      }
    }
  }

  advancePhase() {
    const phases = ["night", "day", "voting", "result"];
    const nextIdx = (phases.indexOf(this.phase) + 1) % phases.length;
    this.phase = phases[nextIdx];
  }

  resetGame() {
    this.phase = "lobby";
    this.players.forEach((p) => delete p.role);
  }

  broadcastState() {
    const state = {
      phase: this.phase,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        alive: p.alive,
        role: this.phase === "result" ? p.role : undefined,
      })),
    };

    for (const ws of this.sessions.keys()) {
      ws.send(JSON.stringify({ type: "state", ...state }));
    }
  }
}
