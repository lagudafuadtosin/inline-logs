export default defineEventHandler(() => {
  const reply = { hello: "nitro" };
  console.log("nuxt api", reply); // @expect nuxt-api
  return reply;
});
