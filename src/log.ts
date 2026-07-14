let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
};

function line(level: string, subsystem: string, msg: string): string {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
  return `${ts} ${level.padEnd(5)} [${subsystem}] ${msg}`;
}

export function createLogger(subsystem: string): Logger {
  return {
    info: (msg) => console.log(line("INFO", subsystem, msg)),
    warn: (msg) => console.error(line("WARN", subsystem, msg)),
    error: (msg) => console.error(line("ERROR", subsystem, msg)),
    debug: (msg) => {
      if (verbose) console.log(line("DEBUG", subsystem, msg));
    },
  };
}
