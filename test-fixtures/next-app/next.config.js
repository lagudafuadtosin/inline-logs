// The Turbopack and webpack dev servers write to their own folders, so one can start after the other.
module.exports = {
  distDir: process.env.TURBOPACK ? ".next" : ".next-webpack",
  turbopack: { root: __dirname },
  agentRules: false,
};
