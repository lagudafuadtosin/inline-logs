// Every page this dev server sends has a strict Content-Security-Policy: no inline scripts.
export default {
  server: {
    headers: {
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; connect-src 'self' ws:",
    },
  },
};
