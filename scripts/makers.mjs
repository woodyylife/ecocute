// 監視対象メーカーの定義（検知スクリプトと自動ドラフトPRスクリプトで共用）
// name : メーカー名
// re   : 品番（システム形名）らしき文字列を拾う正規表現
// urls : 巡回する公式ラインアップページ
export const MAKERS = [
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
