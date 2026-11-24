export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/info") {
      return Response.json({
        game: "water-polo",
        servedBy: "cloudflare-worker",
        time: new Date().toISOString(),
        hint: "Open / to play",
      });
    }

    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set("X-Served-By", "water-polo-worker");
    return response;
  },
} satisfies ExportedHandler<Env>;
