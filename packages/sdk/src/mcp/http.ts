/** Bound transport bytes before the official SDK parses JSON/SSE; never follow redirects. */
export async function mcpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "error" });
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("MCP HTTP response exceeds 4 MiB");
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
