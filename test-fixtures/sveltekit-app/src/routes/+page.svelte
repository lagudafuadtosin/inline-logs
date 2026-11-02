<script>
  import { onMount } from "svelte";
  let { data } = $props();
  let pages = $state(1);
  $inspect(pages); // @expect kit-inspect
  onMount(() => {
    console.log("kit browser", { title: data.book.title }); // @expect kit-browser
    pages = 2;
  });
</script>

<h1>{data.book.title} {pages}</h1>
