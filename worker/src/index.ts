export { GameRoom } from "./GameRoom";

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const code = Math.random().toString(36).substring(2, 7).toUpperCase();
      const gmToken = Math.random().toString(36).substring(2, 15);
      return new Response(JSON.stringify({ code, gmToken }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const match = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/ws/);
    if (match) {
      const roomCode = match[1];
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
