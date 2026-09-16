import { runCli } from "./cli-commands.js";
import { CliError } from "./cli-files.js";
process.umask(0o077);
try {
  const service = await runCli(process.argv.slice(2));
  if (service) {
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        if (stopping) return;
        stopping = true;
        void service.close().then(
          () => process.exit(0),
          () => {
            process.stderr.write("shutdown_incomplete\n");
            process.exit(1);
          },
        );
      });
  }
} catch (error) {
  process.stderr.write(
    (error instanceof CliError ? error.code : "operation_failed") + "\n",
  );
  process.exitCode = 1;
}
