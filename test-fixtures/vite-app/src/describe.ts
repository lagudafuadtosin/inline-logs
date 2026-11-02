// TypeScript in the browser: Vite strips the types, so the served lines move.
interface Person {
  name: string;
  age?: number;
}

export function describe(p: Person): string {
  const text: string = `${p.name} (${p.age ?? "age unknown"})`;
  console.log("describing", p); // @expect ts-in-browser
  return text;
}
