"use client";
import { useEffect } from "react";

export default function Secret() {
  useEffect(() => {
    const csp = { nonce: true };
    console.log("secure page", csp); // @expect csp-nonce
  }, []);
  return <p>secure</p>;
}
