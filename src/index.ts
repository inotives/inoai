import { pathToFileURL } from "node:url";
import { isSea } from "node:sea";

import { run } from "./inoai/app.js";
import { launchUi } from "./ui/server.js";
import { parseUiOptions } from "./ui/common/options.js";
import { normalizeDirectoryArgs } from "./inoai/agent-instance/direct-directory.js";
import { startForeground } from "./platform/foreground.js";

export * from "./inoai/app.js";

if (isSea() || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const command = Promise.resolve().then(async () => {
    const args = normalizeDirectoryArgs(process.argv.slice(2));
    if (args[0] === "start") {
      process.exitCode = await startForeground(parseUiOptions(args.slice(1), "start"));
    } else if (args[0] === "ui") {
        const options = parseUiOptions(args.slice(1));
        await launchUi(process.cwd(), options.connectDirectory, options.port, options.host);
        process.send?.({ type: "inoai-ui-ready" });
    } else {
      await run(args);
    }
  });
  void command.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
