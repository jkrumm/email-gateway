import { app } from "./app";
import { env } from "./env";
import { startJobSystem } from "./jobs/register";

app.listen(env.PORT);
startJobSystem();

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port} with NODE_ENV=${process.env.NODE_ENV} 🦊`,
);
