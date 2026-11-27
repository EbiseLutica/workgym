<script setup>
import hljs from "highlight.js/lib/common";
import { computed } from "vue";

const props = defineProps({
  code: { type: String, required: true },
  language: { type: String, default: null },
});

/**
 * highlight.js の出力は、元のコードの文字を HTML としてエスケープしたうえで span を足したものなので、v-html に渡せる。
 * 言語が分からなければ、ハイライトせずにテキストとして出す。
 */
const highlighted = computed(() => {
  if (!props.language || !hljs.getLanguage(props.language)) return null;
  return hljs.highlight(props.code, { language: props.language, ignoreIllegals: true }).value;
});
</script>

<template>
  <pre class="tv-code"><code v-if="highlighted !== null" class="hljs" v-html="highlighted"></code><code v-else>{{ code }}</code></pre>
</template>
