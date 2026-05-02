// logger.js — Color-coded logger (adopted from Meridian logger pattern)
import { createWriteStream, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

mkdirSync(path.join(__dirname, "logs"), { recursive: true });
const logStream = createWriteStream(path.join(__dirname, "logs", "plutardia.log"), { flags: "a" });

const COLORS = {
  reset:   "\x1b[0m",
  bright:  "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
};

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function write(level, color, label, msg) {
  const ts   = timestamp();
  const line = `[${ts}] [${label}] ${msg}`;
  const tty  = `${COLORS.gray}[${ts}]${COLORS.reset} ${color}${COLORS.bright}[${label}]${COLORS.reset} ${msg}`;
  process.stdout.write(tty + "\n");
  logStream.write(line + "\n");
}

export const logger = {
  info:    (msg) => write("INFO",    COLORS.cyan,    "INFO   ", msg),
  scan:    (msg) => write("SCAN",    COLORS.blue,    "SCAN   ", msg),
  found:   (msg) => write("FOUND",   COLORS.yellow,  "FOUND  ", msg),
  exec:    (msg) => write("EXEC",    COLORS.magenta, "EXEC   ", msg),
  success: (msg) => write("SUCCESS", COLORS.green,   "SUCCESS", msg),
  error:   (msg) => write("ERROR",   COLORS.red,     "ERROR  ", msg),
  warn:    (msg) => write("WARN",    COLORS.yellow,  "WARN   ", msg),
  dim:     (msg) => write("DEBUG",   COLORS.gray,    "DEBUG  ", msg),

  // Summary banner
  banner: (title) => {
    const line = "═".repeat(60);
    const pad  = " ".repeat(Math.max(0, (60 - title.length - 2) / 2));
    process.stdout.write(
      `\n${COLORS.cyan}${line}\n${pad} ${COLORS.bright}${title}${COLORS.reset}${COLORS.cyan} ${pad}\n${line}${COLORS.reset}\n\n`
    );
  },
};

export default logger;
