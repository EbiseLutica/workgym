// 使い方: node render-review.mjs
// 契約の下書き・検査結果・Red 確認の結果・受け入れテストの中身を、ビューア（viewer/dist/review.html）に埋め込んで
// .tasque/tmp/review.html に書き、そのパスを標準出力に出す。人間が契約をレビューするときに開く。
import { cliProjectDir } from "./lib/git.mjs";
import { writeReviewPage } from "./lib/review-page.mjs";

if (process.argv.length > 2) {
  console.error("usage: render-review.mjs");
  process.exit(2);
}

try {
  console.log(writeReviewPage(cliProjectDir()));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
