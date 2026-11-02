// A plain webpack dev server with webpack's development defaults (devtool "eval").
const path = require("path");

module.exports = {
  mode: "development",
  entry: "./src/index.js",
  output: { path: path.resolve(__dirname, "dist"), filename: "main.js" },
  devServer: { port: 5203, static: { directory: path.resolve(__dirname, "public") }, open: false },
};
