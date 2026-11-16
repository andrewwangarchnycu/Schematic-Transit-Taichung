// 呼叫 TDX API 並印出 / 存檔結果 (金鑰讀自 repo 根目錄的 tdx-key.local.js，該檔不進版控)
// 用法：node tools/probe.js <路徑或完整網址> ...
//   路徑以 /v2/... 開頭時接在 https://tdx.transportdata.tw/api/basic 後
//   設環境變數 OUT=檔名 可把回應存檔，例：OUT=tools/shape_all.json node tools/probe.js '/v2/Bus/Shape/City/Taichung?$format=JSON'
const fs = require('fs'), path = require('path');
const keyFile = path.join(__dirname, '..', 'tdx-key.local.js');
const txt = fs.readFileSync(keyFile, 'utf8');
const id = txt.match(/id: "([^"]+)"/)[1], secret = txt.match(/secret: "([^"]+)"/)[1];
(async () => {
    const tk = await (await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
    })).json();
    const H = { authorization: 'Bearer ' + tk.access_token, 'accept-encoding': 'gzip' };
    for (const u of process.argv.slice(2)) {
        const r = await fetch(u.startsWith('http') ? u : 'https://tdx.transportdata.tw/api/basic' + u, { headers: H });
        const t = await r.text();
        if (process.env.OUT) fs.writeFileSync(process.env.OUT, t);
        console.log(r.status, u, t.length, t.slice(0, 1500).replace(/\s+/g, ' '));
    }
})();
