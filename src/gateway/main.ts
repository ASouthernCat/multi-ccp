import { pathToFileURL } from "node:url";
import type { PathContext } from "../core/paths.js";
import { getGatewayEndpoint, readGatewayRuntimeConfig } from "./config.js";
import { GatewayRegistry } from "./registry.js";
import { createGatewayServer } from "./server.js";

export async function runGatewayMain(): Promise<void> {
  const context: PathContext = process.env.CCP_GATEWAY_HOME
    ? { homeDir: process.env.CCP_GATEWAY_HOME }
    : {};
  const config = await readGatewayRuntimeConfig(context);
  const handle = createGatewayServer({
    context,
    registry: new GatewayRegistry(context),
    instanceId: process.env.CCP_GATEWAY_INSTANCE_ID
  });
  await handle.listen({ host: config.host, port: config.port });
  console.log(`multi-ccp gateway listening at ${getGatewayEndpoint(config)} (${handle.instanceId})`);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(entry).href === import.meta.url);
}

if (isDirectExecution()) {
  runGatewayMain().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
