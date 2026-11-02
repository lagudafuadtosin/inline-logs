// An unhandled rejection (Node's default is to crash with it).
async function load() {
  await null;
  throw new Error("could not load"); // @expect reject
}
load();
