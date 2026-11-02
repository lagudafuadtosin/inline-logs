// A custom dev server script that loads webpack and webpack-dev-server with
// import (ES modules), in place of `webpack serve`: node server.mjs <port>
import webpack from "webpack";
import WebpackDevServer from "webpack-dev-server";
import config from "./webpack.config.js";

const port = Number(process.argv[2] || 5213);
const server = new WebpackDevServer({ ...config.devServer, port }, webpack(config));
await server.start();
