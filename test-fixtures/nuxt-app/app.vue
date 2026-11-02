<script setup>
import { onMounted } from "vue";

const film = { title: "Akira", year: 1988 };
if (import.meta.server) console.log("nuxt server", film); // @expect nuxt-server
onMounted(() => {
  console.log("nuxt browser", { title: film.title }); // @expect nuxt-browser
});
</script>

<template>
  <h1>{{ film.title }}</h1>
</template>
