<script setup>
defineProps({ data: { type: Object, required: true } });
defineEmits(["open"]);

/**
 * Red 確認で、期待どおり（fail）でなかった受け入れコマンドがあるか。
 */
const redWarned = (task) => (task.acceptance ?? []).some((a) => a.result && a.result.status !== "fail");
</script>

<template>
  <section class="lu-stack lu-stack--gap-2">
    <h2 class="tv-section-title">要件</h2>
    <p class="tv-prewrap">{{ data.request ?? "（要件なし）" }}</p>
  </section>

  <section class="lu-stack lu-stack--gap-3">
    <h2 class="tv-section-title">タスク</h2>
    <button
      v-for="t in data.tasks"
      :key="t.id"
      type="button"
      class="lu-card lu-card--link tv-task-link"
      @click="$emit('open', t.id)"
    >
      <span class="tv-task-head">
        <span class="tv-task-id">{{ t.id }}</span>
        <span class="tv-task-title">{{ t.title }}</span>
      </span>
      <span class="tv-goal">{{ t.goal }}</span>
      <span class="lu-stack lu-stack--horizontal lu-stack--wrap lu-stack--gap-1">
        <span v-if="t.tests.length === 0" class="lu-chip lu-chip--warning">テストなし</span>
        <span v-else class="lu-chip lu-chip--dimmed">テスト {{ t.tests.length }}</span>
        <span v-if="redWarned(t)" class="lu-chip lu-chip--warning">Red 要確認</span>
        <span v-if="t.delete?.length" class="lu-chip lu-chip--danger">削除 {{ t.delete.length }}</span>
        <span v-if="t.uncertain?.length" class="lu-chip lu-chip--primary">要判断 {{ t.uncertain.length }}</span>
      </span>
      <span class="tv-dim">上限 {{ t.max_diff?.lines }} 行 / {{ t.max_diff?.files }} ファイル</span>
    </button>
  </section>
</template>
