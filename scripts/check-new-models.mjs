// エコキュート新商品（新形名）チェッカー
// 各メーカーの公式ページを取得し、品番らしき文字列を抽出。
// 既知リスト(seen-models.json)に無いものを「新形名の可能性」として
// チャットワークに通知する。検知分は seen に追記して重複通知を防ぐ。
//
// メール通知にも対応：新形名があれば通知文を notify-message.txt /
// notify-subject.txt に書き出す。ワークフロー側でメール用の項目(Secrets)が
// 登録されていれば、その内容を使ってメールも送る（未登録ならメールはスキップ）。
//
// 依存パッケージなし（Node.js 20 の標準 fetch を使用）。

import fs from 'node:fs';

const SEEN_PATH = 'seen-models.json';

// 監視対象：メーカーごとに「品番の形」と「巡回するURL」を定義
const MAKERS = [
  {
    name: '三菱電機',
    re: /SRT-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://www.mitsubishielectric.co.jp/home/ecocute/product/',
      'https://www.mitsubishielectric.co.jp/home/ecocute/product/s/index.html',
    ],
  },
  {
    name: 'パナソニック',
    re: /HE-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://sumai.panasonic.jp/hp/lineup/',
    ],
  },
  {
    name: 'ダイキン',
    re: /EQ[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://www.ac.daikin.co.jp/sumai/alldenka/ecocute/lineup/fullauto/01',
      'https://www.ac.daikin.co.jp/sumai/alldenka/ecocute/lineup/fullauto/02',
      'https://www.ac.daikin.co.jp/sumai/alldenka/ecocute/lineup/auto/01',
      'https://www.ac.daikin.co.jp/sumai/alldenka/ecocute/lineup/raku/01',
    ],
  },
  {
    name: '日立',
    re: /BHP-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://kadenfan.hitachi.co.jp/kyutou/lineup/f-xd/',
      'https://kadenfan.hitachi.co.jp/kyutou/lineup/fv-xd/',
      'https://kadenfan.hitachi.co.jp/kyutou/lineup/fw-xd/',
      'https://kadenfan.hitachi.co.jp/kyutou/lineup/f-xdk/',
    ],
  },
  {
    name: 'コロナ',
    re: /CHP-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://www.corona.co.jp/eco/highgrade/lineup.html',
      'https://www.corona.co.jp/eco/slim/lineup.html',
      'https://www.corona.co.jp/eco/thin/lineup.html',
    ],
  },
  {
    name: '東芝',
    re: /HWH-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
    urls: [
      'https://www.toshiba-carrier.co.jp/products/small/eco/lineup/',
    ],
  },
];

const seen = new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')));
const found = {}; // メーカー名 -> [新トークン]

for (const m of MAKERS) {
  const tokens = new Set();
  for (const url of m.urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (ecocute-monitor)' },
      });
      if (!res.ok) { console.error('NG', res.status, url); continue; }
      const html = await res.text();
      for (const t of html.match(m.re) || []) tokens.add(t);
    } catch (e) {
      console.error('取得失敗', url, e.message);
    }
  }
  const news = [...tokens].filter((t) => !seen.has(t));
  if (news.length) found[m.name] = news.sort();
}

const newAll = Object.values(found).flat();

if (newAll.length === 0) {
  console.log('新形名は見つかりませんでした。');
  process.exit(0);
}

// --- 通知本文を組み立て ---
// メーカーごとの一覧（プレーン）
let plain = '';
for (const [maker, list] of Object.entries(found)) {
  plain += `■ ${maker}\n` + list.map((t) => '・' + t).join('\n') + '\n';
}
const footer =
  '\n※自動抽出のため誤検知（部品コード等）を含む場合があります。公式サイトで確認の上、アプリへの追加をご依頼ください。';

// チャットワーク用（装飾タグ付き）
const cwMsg =
  '[info][title]🆕 エコキュート 新形名の可能性を検知（週次チェック）[/title]\n' +
  plain + footer + '[/info]';

// メール用（プレーンテキスト）＋件名
const mailSubject = `🆕 エコキュート新形名の可能性 ${newAll.length}件（週次チェック）`;
const mailBody = '🆕 エコキュート 新形名の可能性を検知（週次チェック）\n\n' + plain + footer + '\n';

// --- チャットワークへ送信 ---
const token = process.env.CHATWORK_TOKEN;
const room = process.env.CHATWORK_ROOM;
if (token && room) {
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${room}/messages`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': token,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ body: cwMsg }),
  });
  console.log('チャットワーク送信ステータス:', res.status);
  if (!res.ok) console.error(await res.text());
} else {
  console.log('（チャットワーク未設定のため送信せず）');
}

// --- メール送信用のファイルを書き出し（ワークフロー側が利用） ---
// メール用の項目(Secrets)が登録されていれば、このファイルを使って送信される。
fs.writeFileSync('notify-subject.txt', mailSubject);
fs.writeFileSync('notify-message.txt', mailBody);
console.log('通知本文を書き出しました（メール用）。');

// --- 検知分を既知リストに追記（次回からの重複通知を防止） ---
for (const t of newAll) seen.add(t);
fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].sort(), null, 2));
console.log('検知済みリストに追加:', newAll);
