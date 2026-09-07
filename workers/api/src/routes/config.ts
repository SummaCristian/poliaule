import { Hono } from "hono";
import type { Env } from "../index";

export const config = new Hono<{ Bindings: Env }>();

// Public client configuration. The Mapbox token here is a URL-restricted public
// (`pk.`) token — safe to hand to the browser; it lives in a worker secret only
// so it stays out of the (public) source repo. Cacheable for a while: it changes
// about never, and a rotation is a redeploy anyway.
config.get("/", (c) =>
  c.json(
    { mapboxToken: c.env.MAPBOX_TOKEN ?? null },
    c.env.MAPBOX_TOKEN ? 200 : 503,
    { "Cache-Control": "public, max-age=3600" }
  )
);
