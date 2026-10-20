import { GameRoom } from "./GameRoom";

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function generateCode(): string {
  // 紛らわしい文字(0/O, 1/I)を除いた文字セット
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const code = generateCode();
      const gmToken = crypto.randomUUID();
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      await stub.fetch("https://do/create", {
        method: "POST",
        body: JSON.stringify({ code, gmToken }),
      });
      return Response.json({ code, gmToken }, { headers: CORS_HEADERS });
    }

    // /api/room/XXXXX/ws  (WebSocketアップグレード)
    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]+)\/ws$/);
    if (match) {
      const code = match[1];
      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      const doUrl = new URL(request.url);
      doUrl.pathname = "/ws";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("not found", { status: 404, headers: CORS_HEADERS });
  },
};
