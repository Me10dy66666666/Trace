import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const port = Number(process.env.TRACEANDBACK_PROTOTYPE_PORT ?? 4173);
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (request, response) => {
  const requested = request.url === "/" ? "/trace-graph.html" : request.url?.split("?")[0] ?? "/trace-graph.html";
  const relativePath = normalize(requested).replace(/^([.][.][/\\])+/, "");
  try {
    const filePath = join(root, relativePath);
    response.writeHead(200, { "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Trace Graph prototype: http://127.0.0.1:${port}/trace-graph.html?variant=A`));
