// A pages router page: getServerSideProps runs on the server, the effect in the browser.
import { useEffect } from "react";

export async function getServerSideProps() {
  const props = { title: "legacy", items: [1, 2, 3] };
  console.log("pages server", props); // @expect pages-server
  return { props };
}

export default function Legacy({ title, items }) {
  useEffect(() => {
    const total = items.reduce((a, b) => a + b, 0);
    console.warn("pages browser", title, total); // @expect pages-browser
  }, [title, items]);
  return <h1>{title}</h1>;
}
