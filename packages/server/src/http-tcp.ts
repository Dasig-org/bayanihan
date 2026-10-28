/**
 * A small HTTP/1.1 server over raw TCP sockets, so Bayanihan Server can run on a phone as a hub.
 * Works with Node's `net` and with react-native-tcp-socket, which has the same shape.
 * Handles Content-Length bodies (what the Dasig app sends), keep-alive, and up to 16 MB per request.
 */
export interface TcpSocket {
  on(event: "data", cb: (chunk: Uint8Array | string) => void): unknown;
  on(event: "error" | "close", cb: (...a: unknown[]) => void): unknown;
  write(data: Uint8Array | string): unknown;
  end(): unknown;
  destroy(): unknown;
}
export interface TcpServer { listen(opts: { port: number; host: string }, cb?: () => void): unknown; close(): unknown }
export type CreateServer = (onConnection: (socket: TcpSocket) => void) => TcpServer;

const MAX = 16 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const STATUS: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 500: "Internal Server Error", 501: "Not Implemented" };

function concat(a: Uint8Array, b: Uint8Array) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function indexOfCrlf2(b: Uint8Array) { for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i; return -1; }

export function serveTcp(createServer: CreateServer, fetch: (req: Request) => Response | Promise<Response>, opts: { port: number; host?: string; origin: () => string }) {
  const server = createServer((socket) => {
    let buf = new Uint8Array(0);
    let busy = false;
    const pump = async () => {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          const end = indexOfCrlf2(buf);
          if (end < 0) { if (buf.length > 64 * 1024) { socket.destroy(); } return; }
          const head = dec.decode(buf.slice(0, end)).split("\r\n");
          const [method, path] = (head[0] ?? "").split(" ");
          const headers = new Headers();
          for (const line of head.slice(1)) { const i = line.indexOf(":"); if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
          const len = Number(headers.get("content-length") ?? 0);
          if (len > MAX) { socket.write(enc.encode("HTTP/1.1 413 Payload Too Large\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")); socket.end(); return; }
          if (buf.length < end + 4 + len) return; // wait for the rest of the body
          const body = buf.slice(end + 4, end + 4 + len);
          buf = buf.slice(end + 4 + len);
          let res: Response;
          try {
            const req = new Request(opts.origin() + (path ?? "/"), { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body }) });
            res = await fetch(req);
          } catch (e) { res = new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "content-type": "application/json" } }); }
          const out = new Uint8Array(await res.arrayBuffer());
          let h = `HTTP/1.1 ${res.status} ${STATUS[res.status] ?? ""}\r\n`;
          res.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding") h += `${k}: ${v}\r\n`; });
          h += `content-length: ${out.length}\r\n`;
          const close = (headers.get("connection") ?? "").toLowerCase() === "close";
          h += close ? "connection: close\r\n\r\n" : "connection: keep-alive\r\n\r\n";
          socket.write(concat(enc.encode(h), out));
          if (close) { socket.end(); return; }
        }
      } finally { busy = false; }
    };
    socket.on("data", (chunk) => { buf = concat(buf, typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk)); pump(); });
    socket.on("error", () => {});
  });
  server.listen({ port: opts.port, host: opts.host ?? "0.0.0.0" });
  return server;
}
