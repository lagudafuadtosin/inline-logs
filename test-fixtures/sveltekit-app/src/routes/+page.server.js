export function load() {
  const book = { title: "Dune", year: 1965 };
  console.log("kit server load", book); // @expect kit-server
  return { book };
}
