import { pathToFileURL } from "node:url";

import { run } from "./inoai/app.js";
import { launchUi } from "./ui/server.js";
import { parseUiOptions } from "./ui/common/options.js";

export * from "./inoai/app.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const command = args[0] === "ui"
    ? (() => {
        const options = parseUiOptions(args.slice(1));
        return launchUi(process.cwd(), options.connectDirectory, options.port);
      })()
    : run(args);
  void command.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
