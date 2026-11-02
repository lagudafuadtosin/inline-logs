"use client";
// A client component: rendered on the server first, then runs in the browser.
import { useEffect, useState } from "react";

export default function Counter({ start }) {
  const [n] = useState(start);
  useEffect(() => {
    const info = { n, where: typeof window };
    console.log("client counter", info); // @expect app-browser
  }, [n]);
  return <p>Count {n}</p>;
}
