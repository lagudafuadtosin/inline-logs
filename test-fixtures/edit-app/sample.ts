// The log commands' fixture. The host test opens a copy of it.
interface User {
  name: string;
  langs: string[];
}

export function describe(user: User, extra = "x") {
  const label = `${user.name} knows ${user.langs.length}`;
  const note = "console.log(not a call)";
  console.log("label", label);
  if (user.langs.length > 1) console.warn("many");
  console.info(
    "multi line",
    { a: 1 },
  );
  const twice = [1, 2].map((n) => console.debug(n));
  return label + note + extra + twice.length;
}
