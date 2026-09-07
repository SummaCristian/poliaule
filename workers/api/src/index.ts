import { Hono } from "hono";
import { cors } from "hono/cors";
import { classrooms } from "./routes/classrooms";
import { openingHours } from "./routes/opening-hours";
import { occupancy } from "./routes/occupancy";
import { photos } from "./routes/photos";
import { config } from "./routes/config";

export interface Env {
  DATA_BUCKET: R2Bucket;
  // URL-restricted Mapbox public token, set via `wrangler secret put MAPBOX_TOKEN`
  // (per environment). Served to the frontend by GET /v1/config.
  MAPBOX_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.route("/v1/config", config);
app.route("/v1/classrooms", classrooms);
app.route("/v1/opening-hours", openingHours);
app.route("/v1/occupations", occupancy);
app.route("/v1/photos", photos);

export default app;
