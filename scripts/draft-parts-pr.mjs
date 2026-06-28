// エコキュート 新形名の「下書き」自動生成スクリプト
//
// check-new-models.mjs が書き出した new-models.json（新形名の一覧）を読み、
// 各メーカー公式ページのテキストを Claude API（構造化出力）に渡して、
// PARTS_DATA に追記する1行ぶんの項目を抽出する。抽出結果を index.html の
// PARTS_DATA 先頭に追記し、LAST_UPDATED を当日に更新する。
//
// 出力（ワークフロー側が利用）：
//   - index.html を書き換え（差分があればPRにする）
//   - pr-body.txt … プルリクエスト本文
//   - pr-ready    … このファイルが存在すれば「PRを作る価値のある差分あり」の合図
//
// ※ AI抽出は「公式ページから読み取れた範囲」の下書き。確定値ではないため、
//   conf(確度) を控えめに付け、最終確認は人（PRレビュー）が行う前提。
//
// 依存パッケージなし（Node.js 20+ の標準 fetch を使用）。

import fs from 'node:fs';
import { MAKERS } from './makers.mjs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const INDEX_PATH = 'index.html';
const NEW_MODELS_PATH = 'new-models.json';
const MAX_TEXT = 80000; // メーカー1社あたりに渡すテキストの上限（コスト抑制）

if (!API_KEY) {
  console.log('ANTHROPIC_API_KEY が未設定のため、自動ドラフトPRはスキップします。');
  process.exit(0);
}
if (!fs.existsSync(NEW_MODELS_PATH)) {
  console.log('new-models.json が無いため、追加対象はありません。');
  process.exit(0);
}

const found = JSON.parse(fs.readFileSync(NEW_MODELS_PATH, 'utf8')); // { メーカー名: [トークン...] }
let indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');

// 既に PARTS_DATA に登録済みの system 形名を集める（重複追加を防ぐ）
const existingSystems = new Set(
  [...indexHtml.matchAll(/system:"([^"]+)"/g)].map((m) => m[1])
);

// --- HTML をプレーンテキストへ（雑でよい。AIが読めればよい） ---
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

// --- Claude API（構造化出力）で1メーカーぶんの行を抽出 ---
const ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['system', 'region', 'tank', 'remote', 'legcover', 'heatpump', 'conf', 'note', 'src'],
        properties: {
          system: { type: 'string', description: 'システム形名（検索キー。new-models.jsonのトークン）' },
          region: { type: 'string', description: '設置地域。例: 一般地 / 寒冷地 / 耐塩害' },
          tank: { type: 'string', description: '貯湯ユニット品番。不明なら""' },
          remote: { type: 'string', description: 'リモコン品番。不明なら""' },
          legcover: { type: 'string', description: '脚部カバー品番。不明なら""' },
          heatpump: { type: 'string', description: 'ヒートポンプ品番。不明なら""' },
          conf: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high=公式に明記 / medium=命名規則等から推定 / low=不明' },
          note: { type: 'string', description: 'シリーズ名・容量などの備考' },
          src: { type: 'string', description: '参照した公式URL' },
        },
      },
    },
  },
};

async function extractRows(maker, tokens, pageText) {
  const prompt =
    `あなたは住宅設備会社の部品データ整理担当です。\n` +
    `以下はエコキュートメーカー「${maker}」の公式ラインアップページから抽出したテキストです。\n\n` +
    `次の「システム形名の候補」について、各部品の品番を抽出してください。\n` +
    `候補: ${tokens.join(', ')}\n\n` +
    `ルール:\n` +
    `- 候補のうち、実際に販売されているエコキュートの「システム形名（貯湯ユニット＋ヒートポンプのセット商品の形名）」だけを rows に含める。\n` +
    `- リモコン単体・脚部カバー単体・部材コードなど、システム形名でないものは rows に含めない（除外）。\n` +
    `- 各部品(tank/remote/legcover/heatpump)は、ページから確実に読み取れた場合のみ品番を入れる。読み取れない場合は空文字 "" にする。\n` +
    `- conf は、公式に明記されていれば high、命名規則などからの推定なら medium、不明が多ければ low。\n` +
    `- src は参照した公式URL（次のいずれか）: ${MAKERS.find((m) => m.name === maker)?.urls.join(' , ')}\n` +
    `- 推測で品番をでっち上げない。不明は "" のままにする。\n\n` +
    `--- 公式ページのテキスト ---\n${pageText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: ROW_SCHEMA } },
    }),
  });

  if (!res.ok) {
    console.error(`Claude API NG (${maker}):`, res.status, await res.text());
    return [];
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    console.error(`Claude応答にテキストなし (${maker})`);
    return [];
  }
  try {
    const parsed = JSON.parse(textBlock.text);
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch (e) {
    console.error(`JSON解析失敗 (${maker}):`, e.message);
    return [];
  }
}

// --- メイン ---
const j = (s) => JSON.stringify(s ?? ''); // 値を "..." 形式へ（エスケープ込み）
const newRowLines = [];
const summary = []; // PR本文用

for (const [maker, tokens] of Object.entries(found)) {
  // すでに登録済みの形名は除外
  const targets = tokens.filter((t) => !existingSystems.has(t));
  if (!targets.length) continue;

  const conf = MAKERS.find((m) => m.name === maker);
  if (!conf) continue;

  // ページテキストを取得・連結
  let text = '';
  for (const url of conf.urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (ecocute-monitor)' } });
      if (r.ok) text += '\n' + htmlToText(await r.text());
    } catch (e) {
      console.error('取得失敗', url, e.message);
    }
  }
  if (!text.trim()) continue;
  text = text.slice(0, MAX_TEXT);

  const rows = await extractRows(maker, targets, text);
  for (const row of rows) {
    if (!row.system || existingSystems.has(row.system)) continue;
    existingSystems.add(row.system);
    const line =
      `{maker:${j(maker)},system:${j(row.system)},region:${j(row.region)},tank:${j(row.tank)},` +
      `remote:${j(row.remote)},legcover:${j(row.legcover)},heatpump:${j(row.heatpump)},` +
      `conf:${j(row.conf || 'low')},note:${j(row.note)},src:${j(row.src)}},`;
    newRowLines.push(line);
    summary.push(`- ${maker} ${row.system}（確度:${row.conf || 'low'}）${row.note ? ' … ' + row.note : ''}`);
  }
}

if (!newRowLines.length) {
  console.log('追記できる新しい行はありませんでした（誤検知のみ、または抽出失敗）。');
  process.exit(0);
}

// PARTS_DATA の先頭に追記（改行コードの違い CRLF/LF に対応）
const markerMatch = indexHtml.match(/const PARTS_DATA = \[\r?\n/);
if (!markerMatch) {
  console.error('index.html に PARTS_DATA の開始位置が見つかりません。中断します。');
  process.exit(1);
}
const insertAt = markerMatch.index + markerMatch[0].length;
const block =
  '// === ⚠️ 自動下書き（要確認）: 公式資料で品番を照合してから確定してください ===\n' +
  newRowLines.join('\n') +
  '\n';
indexHtml = indexHtml.slice(0, insertAt) + block + indexHtml.slice(insertAt);

// LAST_UPDATED を当日に更新
const today = new Date().toISOString().slice(0, 10);
indexHtml = indexHtml.replace(/const LAST_UPDATED = "[^"]*";/, `const LAST_UPDATED = "${today}";`);

fs.writeFileSync(INDEX_PATH, indexHtml);

// PR本文
const body =
  `🤖 エコキュートの新形名を検知したため、PARTS_DATA に**下書き**を自動追記しました。\n\n` +
  `### 追記した形名（${newRowLines.length}件）\n` +
  summary.join('\n') +
  `\n\n### ⚠️ マージ前に必ず確認してください\n` +
  `- 各品番（貯湯ユニット / リモコン / 脚部カバー / ヒートポンプ）を**メーカー公式資料で照合**\n` +
  `- 空欄("")や確度 low/medium の項目を埋める・修正する\n` +
  `- 問題なければ Merge → 約1分で公開アプリに反映されます\n\n` +
  `※ この内容はAIによる自動抽出です。誤り・取りこぼしがありえます。`;
fs.writeFileSync('pr-body.txt', body);
fs.writeFileSync('pr-ready', 'ready');
console.log(`下書き ${newRowLines.length} 件を index.html に追記しました。`);
