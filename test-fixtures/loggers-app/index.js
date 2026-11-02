// pino, winston, consola and tslog, each through its own default output.
// Lines marked "@expect" are where the entries must land.
const pino = require("pino");
const winston = require("winston");
const { createConsola } = require("consola");

async function main() {
  const { Logger } = await import("tslog");

  const p = pino({ base: undefined, timestamp: false });
  p.info({ order: 7 }, "pino order placed"); // @expect pino-info
  p.warn("pino low stock %d", 3); // @expect pino-warn
  p.debug("pino hidden"); // below pino's level: nothing is printed, nothing is recorded
  p.child({ part: "cart" }).error(new Error("pino failed")); // @expect pino-error

  const w = winston.createLogger({ level: "info", format: winston.format.simple(), transports: [new winston.transports.Console()] });
  w.info("winston started", { port: 8080 }); // @expect winston-info
  w.warn("winston slow"); // @expect winston-warn
  w.debug("winston hidden"); // below the transport's level
  w.log("error", "winston broke"); // @expect winston-error

  const c = createConsola({ fancy: false });
  c.info("consola ready", { mode: "dev" }); // @expect consola-info
  c.warn("consola careful"); // @expect consola-warn
  c.error("consola bad"); // @expect consola-error

  const t = new Logger({ name: "app" });
  t.info("tslog hello", { id: 1 }); // @expect tslog-info
  t.warn("tslog warned"); // @expect tslog-warn
}

main();
