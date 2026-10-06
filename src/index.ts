import { pathToFileURL } from "node:url";

import { run } from "./app/application.js";

export * from "./app/application.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
