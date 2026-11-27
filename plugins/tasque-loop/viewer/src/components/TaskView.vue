<script setup>
import CodeBlock from "./CodeBlock.vue";

defineProps({ task: { type: Object, required: true } });
</script>

<template>
  <section class="lu-card lu-stack lu-stack--gap-2">
    <h2 class="tv-section-title">{{ task.id }}: {{ task.title }}</h2>
    <p class="tv-goal tv-prewrap">{{ task.goal }}</p>
    <p class="tv-dim">
      上限 {{ task.max_diff?.lines }} 行 / {{ task.max_diff?.files }} ファイル
      <template v-if="task.depends_on?.length"> ・ 依存 {{ task.depends_on.join(", ") }}</template>
    </p>
  </section>

  <section v-if="task.uncertain?.length" class="lu-card lu-stack lu-stack--gap-2">
    <h3 class="tv-section-title">判断が必要な点</h3>
    <ol class="tv-list">
      <li v-for="(u, i) in task.uncertain" :key="i">
        <span class="tv-prewrap">{{ u.q }}</span>
        <span v-if="u.decision" class="tv-decision">→ {{ u.decision }}</span>
      </li>
    </ol>
  </section>

  <section class="lu-card lu-stack lu-stack--gap-3">
    <h3 class="tv-section-title">範囲</h3>
    <div>
      <h4 class="tv-label">変えてよい（allow）</h4>
      <ul class="tv-paths">
        <li v-for="p in task.allow" :key="p"><code>{{ p }}</code></li>
      </ul>
    </div>
    <div v-if="task.deny?.length">
      <h4 class="tv-label">除外（deny）</h4>
      <ul class="tv-paths">
        <li v-for="p in task.deny" :key="p"><code>{{ p }}</code></li>
      </ul>
    </div>
    <div v-if="task.delete?.length">
      <h4 class="tv-label tv-label--danger">消すファイル（delete）</h4>
      <ul class="tv-paths">
        <li v-for="p in task.delete" :key="p"><code>{{ p }}</code></li>
      </ul>
    </div>
    <div v-if="task.out_of_scope?.length">
      <h4 class="tv-label">やらないこと</h4>
      <ul class="tv-list">
        <li v-for="s in task.out_of_scope" :key="s">{{ s }}</li>
      </ul>
    </div>
  </section>

  <section class="lu-card lu-stack lu-stack--gap-3">
    <h3 class="tv-section-title">受け入れテスト</h3>
    <div v-if="task.tests.length === 0" class="lu-alert lu-alert--info">
      <strong class="lu-alert__title">テストなし</strong>
      <p>出来をテストで確かめないタスク。goal が完了を判断できる具体さで書かれているかを見る。</p>
    </div>

    <div v-for="(a, i) in task.acceptance" :key="i" class="lu-stack lu-stack--gap-1">
      <p class="tv-cmd"><code>{{ a.cmd }}</code></p>
      <p class="tv-dim">{{ a.why }}<template v-if="a.cwd">（{{ a.cwd }} で実行）</template></p>
      <template v-if="a.result">
        <p v-if="a.result.status !== 'fail'"><span class="lu-chip lu-chip--warning">{{ a.result.mark }}</span></p>
        <details v-if="a.result.stdout?.trim() || a.result.stderr?.trim()" class="tv-details">
          <summary>コマンドの出力（末尾）</summary>
          <pre v-if="a.result.stdout?.trim()" class="tv-output">{{ a.result.stdout.trimEnd() }}</pre>
          <pre v-if="a.result.stderr?.trim()" class="tv-output tv-output--stderr">{{ a.result.stderr.trimEnd() }}</pre>
        </details>
      </template>
    </div>

    <details v-for="t in task.tests" :key="t.path" class="tv-details" open>
      <summary><code>{{ t.path }}</code></summary>
      <p v-if="t.missing" class="tv-missing">ファイルがない</p>
      <template v-else>
        <p v-if="t.truncated" class="tv-dim">長いので先頭だけを表示している</p>
        <CodeBlock :code="t.content" :language="t.language" />
      </template>
    </details>
  </section>
</template>
