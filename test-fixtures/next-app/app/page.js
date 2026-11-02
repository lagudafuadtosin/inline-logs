// An app router page. A server component, so this runs in the Node server.
import Counter from "./client/counter";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = { name: "Linus", langs: ["c", "git"] };
  console.log("server user", user); // @expect app-server
  return (
    <main>
      <h1>Hello {user.name}</h1>
      <Counter start={2} />
    </main>
  );
}
