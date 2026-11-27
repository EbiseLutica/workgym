<script setup>
import { computed, ref } from "vue";
import OverviewView from "./components/OverviewView.vue";
import TaskView from "./components/TaskView.vue";

const props = defineProps({ data: { type: Object, required: true } });

const tasks = computed(() => props.data.tasks ?? []);
const tab = ref("overview");
const current = computed(() => tasks.value.find((t) => t.id === tab.value) ?? null);

/**
 * 今のタブの次に読むタスク。最後のタスクなら null。
 */
const next = computed(() => {
  const i = current.value === null ? -1 : tasks.value.indexOf(current.value);
  return tasks.value[i + 1] ?? null;
});

const open = (id) => {
  tab.value = id;
  window.scrollTo({ top: 0 });
};

/**
 * 検査結果と Red 確認が、今の契約とテストを見て作られたか。どれかのハッシュが違えば、承認は拒否される。
 */
const stale = computed(() => {
  const { draft, check, red } = props.data.integrity ?? {};
  const reasons = [];
  if (!props.data.check) reasons.push("契約の検査結果がない");
  else if (check !== draft) reasons.push("契約の検査の後に、契約かテストが変わった");
  if (!props.data.red) reasons.push("Red 確認の結果がない");
  else if (red !== draft) reasons.push("Red 確認の後に、契約かテストが変わった");
  return reasons;
});
</script>

<template>
  <header class="tv-header">
    <div class="lu-container">
      <p class="tv-eyebrow">tasque 契約レビュー</p>
      <h1 class="tv-title">{{ data.run ?? "（run なし）" }}</h1>
      <p class="tv-meta">
        base: <code>{{ data.base ?? "?" }}</code>
        ・ タスク {{ tasks.length }} 件
        ・ {{ new Date(data.generated_at).toLocaleString("ja-JP") }} に生成
      </p>
    </div>
  </header>

  <main class="lu-container lu-stack lu-stack--gap-4 tv-main">
    <div v-if="data.error" class="lu-alert lu-alert--danger">
      <strong class="lu-alert__title">契約を読めない</strong>
      <p>{{ data.error }}</p>
    </div>

    <div v-if="data.check && !data.check.ok" class="lu-alert lu-alert--danger">
      <strong class="lu-alert__title">契約の検査に通っていない</strong>
      <ul class="tv-list">
        <li v-for="e in data.check.errors" :key="e">{{ e }}</li>
      </ul>
    </div>

    <div v-if="stale.length > 0" class="lu-alert lu-alert--warning">
      <strong class="lu-alert__title">このままでは承認できない</strong>
      <ul class="tv-list">
        <li v-for="r in stale" :key="r">{{ r }}</li>
      </ul>
    </div>

    <div v-if="data.red?.warnings?.length" class="lu-alert lu-alert--warning">
      <strong class="lu-alert__title">Red 確認で確かめが必要な点が {{ data.red.warnings.length }} 件ある</strong>
      <ul class="tv-list">
        <li v-for="w in data.red.warnings" :key="w">{{ w }}</li>
      </ul>
    </div>

    <nav class="lu-tabbar" role="tablist">
      <button
        class="lu-tabbar__tab"
        role="tab"
        :aria-selected="tab === 'overview'"
        @click="open('overview')"
      >
        概要
      </button>
      <button
        v-for="t in tasks"
        :key="t.id"
        class="lu-tabbar__tab"
        role="tab"
        :aria-selected="tab === t.id"
        @click="open(t.id)"
      >
        {{ t.id }}
      </button>
    </nav>

    <OverviewView v-if="current === null" :data="data" @open="open" />
    <TaskView v-else :key="current.id" :task="current" />

    <div v-if="next" class="tv-next">
      <button type="button" class="lu-button lu-button--primary" @click="open(next.id)">
        次へ: {{ next.id }}
      </button>
    </div>
  </main>
</template>
