import { useEffect } from "react";
import { useLoaderData } from "react-router";

export function loader() {
  const team = { name: "Madrid", wins: 15 };
  console.log("rr loader", team); // @expect rr-server
  return { team };
}

export default function Home() {
  const { team } = useLoaderData();
  useEffect(() => {
    console.log("rr browser", { name: team.name }); // @expect rr-browser
  }, [team.name]);
  return <h1>{team.name}</h1>;
}
