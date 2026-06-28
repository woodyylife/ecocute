// エコキュート 新形名の「下書き」自動生成スクリプト
//
// check-new-models.mjs が書き出した new-models.json（新形名の一覧）を読み、
// 各メーカー公式ページのテキストを Google Gemini（無料枠）に渡して、
// PARTS_DATA に追記する1行ぶんの項目を抽出する。抽出結果を index.html の
// PARTS_DATA 先頭に追記し、LAST_UPDATED を当日に更新する。
//
// Gemini API（Google AI Studio の無料APIキーで利用。週1・少量なら無料枠内）:
//   - エンドポイント: https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
//   - 認証: ヘッダ x-goog-api-key: <GEMINI_API_KEY>
//   - JSON出力: generationConfig.responseMimeType = "application/json"
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

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const INDEX_PATH = 'index.html';
const NEW_MODELS_PATH = 'new-models.json';
const MAX_TEXT = 60000; // メーカー1社あたりに渡すテキストの上限（文字数）

if (!API_KEY) {
  console.log('GEMINI_API_KEY が未設定のため、自動ドラフトPRはスキップします。');
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
    // 画像のalt/titleなどに機種名や品番が入ることが多いので本文へ拾い出す
    .replace(/(?:alt|title)="([^"]*)"/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

// --- Gemini（JSON出力）で1メーカーぶんの行を抽出 ---
const SYSTEM_INSTRUCTION =
  'あなたは住宅設備会社の部品データ整理担当です。指定された形のJSONだけを出力します。' +
  '推測で品番をでっち上げず、読み取れない品番は空文字にします。';

async function extractRows(maker, tokens, pageText) {
  const srcUrls = MAKERS.find((m) => m.name === maker)?.urls.join(' , ') || '';
  const prompt =
    `以下はエコキュートメーカー「${maker}」の公式ラインアップページから抽出したテキストです。\n\n` +
    `次の「システム形名の候補」は、公式ページで検出された実在する形名です。\n` +
    `候補: ${tokens.join(', ')}\n\n` +
    `出力は次の形のJSONのみ（前後に説明文やマークダウンを付けない）:\n` +
    `{"rows":[{"system":"...","region":"...","tank":"...","remote":"...","legcover":"...","heatpump":"...","conf":"high|medium|low","note":"...","src":"..."}]}\n\n` +
    `各フィールドの意味:\n` +
    `- system: システム形名（検索キー。候補の文字列をそのまま入れる）\n` +
    `- region: 設置地域（例: 一般地 / 寒冷地 / 耐塩害。不明なら "一般地"）\n` +
    `- tank: 貯湯ユニット品番 / remote: リモコン品番 / legcover: 脚部カバー品番 / heatpump: ヒートポンプ品番\n` +
    `- conf: 公式に明記=high、命名規則などからの推定=medium、不明が多い=low\n` +
    `- src: 参照した公式URL（次のいずれか）: ${srcUrls}\n\n` +
    `ルール:\n` +
    `- 各候補がエコキュートの「システム形名（貯湯ユニットとヒートポンプのセット商品）」であれば、必ず1件ずつ rows に含める。system には候補の文字列をそのまま入れる。\n` +
    `- 明らかにリモコン・脚部カバー・ヒートポンプ等の「部品単体のコード」である候補だけ除外する。判断が付かなければ含める。\n` +
    `- 各部品(tank/remote/legcover/heatpump)は、ページから読み取れた場合のみ品番を入れる。読み取れない場合は空文字 "" にし、conf は low にする。\n` +
    `- 推測で品番をでっち上げない。不明な品番は "" のままにする。\n\n` +
    `--- 公式ページのテキスト ---\n${pageText}`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-goog-api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });

  if (!res.ok) {
    console.error(`Gemini NG (${maker}):`, res.status, await res.text());
    return [];
  }
  const data = await res.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) {
    console.error(`応答にテキストなし (${maker}):`, JSON.stringify(data).slice(0, 300));
    return [];
  }
  try {
    const parsed = JSON.parse(content);
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
