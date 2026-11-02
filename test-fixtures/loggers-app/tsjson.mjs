// tslog's JSON output: written in batches, after the call. With its stack
// capture on, each line says where it was made and lands there. Without it
// nothing says so, and it is left out. Lines marked "@expect" are checked.
import { Logger } from "tslog";

const placed = new Logger({ name: "api", type: "json", stack: { capture: "on" } });
placed.info("tslog json placed", { order: 9 }); // @expect tslog-json-info
placed.warn("tslog json careful"); // @expect tslog-json-warn

const plain = new Logger({ name: "plain", type: "json" });
plain.info("tslog json no position"); // @expect tslog-json-none
