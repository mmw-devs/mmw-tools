import path from "node:path";
import { loadConfig, ConfigError } from "./config.mjs";
import { Store } from "./store.mjs";
import { Policy, PolicyError } from "./policy.mjs";
import { Auth } from "./auth.mjs";
import { createAuthServer } from "./server.mjs";

function main() {
  let config;
  let store;
  try {
    config = loadConfig();
    store = new Store(path.join(config.dataDir, "auth.sqlite"));
    const policy = Policy.load(config.contractsDir);
    const auth = new Auth({ store, config, policy });
    const server = createAuthServer({ auth, config });

    server.on("error", (error) => {
      console.error(`mmw-tools-auth: server error: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(config.port, "127.0.0.1", () => {
      console.log(`mmw-tools-auth listening on http://127.0.0.1:${config.port}`);
      console.log(`origin: ${config.origin}`);
      console.log(`contracts: ${config.contractsDir}`);
      console.log(`catalogRevision: ${policy.catalogRevision}`);
    });

    const shutdown = () => {
      server.close(() => {
        try {
          store.close();
        } catch {
          // best effort
        }
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PolicyError) {
      console.error(`mmw-tools-auth: ${error.message}`);
    } else {
      console.error("mmw-tools-auth: failed to start", error);
    }
    try {
      store?.close();
    } catch {
      // best effort
    }
    process.exitCode = 1;
  }
}

main();
