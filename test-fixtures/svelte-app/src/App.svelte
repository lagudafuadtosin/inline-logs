<script>
  let count = $state(0);
  let user = $state({ name: "Ada", langs: ["svelte"] });
  $inspect(count); // @expect inspect-count
  $inspect(user); // @expect inspect-user
  console.log("svelte mounted", { count }); // @expect svelte-log
  setTimeout(() => {
    count += 1;
    count += 1;
    user.langs.push("js");
  }, 50);
</script>

<p>{count} {user.name}</p>
