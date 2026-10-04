<!--
  A `js run` block. Step B1 only shows the highlighted code; the runner arrives in step B3.
-->
<script setup lang="ts">
defineProps<{ code: string }>();
</script>

<template>
  <div class="course-runnable"><slot /></div>
</template>
