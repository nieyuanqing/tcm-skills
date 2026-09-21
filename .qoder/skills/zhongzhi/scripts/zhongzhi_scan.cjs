#!/usr/bin/env node
'use strict';
/*
 * /zhongzhi 本地底座：从 /daodi 道地药材库出候选排序与产区竞争格局。
 * 只做「本地库能确定的事」，价格/面积/政策/天气一律留给实时核实环节。
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const DAODI_Q = path.join(__dirname, '..', '..', 'daodi', 'scripts', 'daodi_query.cjs');
const BIG_REGIONS = ['华北', '东北', '华东', '华中', '华南', '西南', '西北'];
const CERT_RE = /地理标志|保护产品|证明商标|GAP|良好农业规范/;
const GROUP_RE = /浙八味|四大怀药|八大怀药|十大[冀晋皖楚云川渝宁陇桂苏]|八大[祁宛]|八大特色药|五大特色药|五大[药南]|辽药六宝|赣食十味|十八青药|岭南新八味|桂十味|川药|广药|云药|藏药|蒙药|关药|怀药|华药|北药|南药|道地/;
const VERIFY_RE = /存核/;

const HELP = `用法: node scripts/zhongzhi_scan.cjs <--region=地区 | --name=药材> [选项]

  --region=<地区>   省名（湖北）/ 大区名（华中）/ 市县级产区（文山、罗田）
                    → 出该地区候选品种排序表，供挑 2-3 个再联网核实
  --name=<药材>     药典正名或道地产品习用名（三七、文山三七）
                    → 出该药材全国道地产区与竞争格局
  --top=<N>         region 模式最多输出 N 行，默认 8
  --score=off       只按本区产区县数排序，不加认证/药群权重
  --json            结构化输出
  -h, --help        本帮助

分数只用于排候选顺序，不构成种植推荐；结论必须过 references/dimensions.md 的实时维度。`;

function q(args) {
  const argv = [DAODI_Q, ...args, '--json', '--limit=9999'];
  let out = '';
  try {
    out = execFileSync(process.execPath, argv, { encoding: 'utf8' });
  } catch (e) {
    out = (e && e.stdout ? String(e.stdout) : '');
  }
  const s = out.indexOf('{');
  if (s < 0) return { count: 0, hits: [] };
  try {
    const j = JSON.parse(out.slice(s));
    return { count: j.count || 0, hits: j.hits || [] };
  } catch {
    return { count: 0, hits: [] };
  }
}

function splitList(s) {
  return s ? s.split(/[、，,；;]|\s+或\s+/).map(x => x.trim()).filter(Boolean) : [];
}

function nationalIndex() {
  const map = new Map();
  for (const r of BIG_REGIONS) {
    for (const h of q(['-r', r]).hits) {
      if (!map.has(h.yaocai)) map.set(h.yaocai, new Set());
      map.get(h.yaocai).add(h.province);
    }
  }
  return map;
}

function aggregate(rows) {
  const map = new Map();
  for (const h of rows) {
    if (!map.has(h.yaocai)) {
      map.set(h.yaocai, { name: h.yaocai, provinces: new Set(), counties: new Set(), products: new Set(), notes: [], features: new Set() });
    }
    const v = map.get(h.yaocai);
    v.provinces.add(h.province);
    for (const c of splitList(h.changu)) v.counties.add(c);
    if (h.chanpin) v.products.add(h.chanpin);
    if (h.beizhu) v.notes.push(h.beizhu);
    if (h.tezheng) v.features.add(h.tezheng);
  }
  return map;
}

function decorate(v, nat, scored) {
  const note = v.notes.join('；');
  const comp = nat.has(v.name) ? nat.get(v.name).size : 1;
  const cert = CERT_RE.test(note);
  const group = GROUP_RE.test(note);
  const verify = VERIFY_RE.test(note);
  const local = v.provinces.size;
  const score = scored
    ? (cert ? 3 : 0) + (group ? 2 : 0) + (comp <= 2 ? 2 : comp <= 4 ? 1 : 0.5) + (local >= 3 ? 1 : 0)
    : 0;
  return {
    name: v.name,
    products: [...v.products].join('/'),
    provinces: [...v.provinces].join('、'),
    countyCount: v.counties.size,
    comp,
    cert,
    group,
    verify,
    score: Math.round(score * 10) / 10,
    note,
    features: [...v.features].join('；'),
  };
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function pad(s, n) {
  let w = 0;
  for (const ch of String(s)) w += /[一-龥＀-￯]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(1, n - w));
}

function runRegion(input, opts) {
  let rows = [];
  let scope = '';
  let localNames = null;

  const byAdmin = q(['-r', input]);
  if (byAdmin.count > 0) {
    rows = byAdmin.hits;
    scope = `${cut(input, 12)}（${[...new Set(rows.map(r => r.province))].join('、')}）`;
  } else {
    const byCounty = q(['-c', input]);
    if (byCounty.count === 0) {
      console.log(`NOT_FOUND: 本地道地库无「${input}」，既不是省/大区名，也不是库内市县级产区。`);
      console.log('action: 先联网确认该地区属哪个省，再用 --region=<省名> 重跑；不要凭印象套省份。');
      process.exit(3);
    }
    localNames = new Set(byCounty.hits.map(h => h.yaocai));
    const provs = [...new Set(byCounty.hits.map(h => h.province))];
    rows = provs.flatMap(p => q(['-r', p]).hits);
    scope = `${input}（本县命中 ${localNames.size} 味；同省参考 ${provs.join('、')}）`;
  }

  const nat = nationalIndex();
  let list = [...aggregate(rows).values()].map(v => decorate(v, nat, opts.scoreOn));
  if (localNames) for (const it of list) it.local = localNames.has(it.name);
  else for (const it of list) it.local = true;

  list = localNames
    ? list.sort((a, b) => (b.local - a.local) || (b.score - a.score) || (b.countyCount - a.countyCount))
    : list.sort((a, b) => (b.score - a.score) || (b.countyCount - a.countyCount) || a.name.localeCompare(b.name, 'zh'));

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'region', scope, total: list.length, candidates: list.slice(0, opts.top) }, null, 2));
    return;
  }

  console.log(`地区: ${scope}`);
  console.log(`本地库候选 ${list.length} 味，按可用信号排序输出前 ${Math.min(opts.top, list.length)}：`);
  console.log('');
  const showLocal = !!localNames;
  const cols = [{ k: '名次', n: 5 }, { k: '品种', n: 11 }]
    .concat(showLocal ? [{ k: '本区', n: 7 }] : [])
    .concat([{ k: '本区道地名', n: 20 }, { k: '本区县数', n: 9 }, { k: '跨省', n: 6 }, { k: '认证', n: 5 }, { k: '药群', n: 5 }, { k: '存核', n: 5 }])
    .concat(opts.scoreOn ? [{ k: '分', n: 0 }] : []);
  console.log(cols.map(c => (c.n ? pad(c.k, c.n) : c.k)).join(''));
  list.slice(0, opts.top).forEach((it, i) => {
    const cells = [i + 1, it.name]
      .concat(showLocal ? [it.local ? '命中' : '-'] : [])
      .concat([cut(it.products, 8), it.countyCount, it.comp + '省', it.cert ? '有' : '-', it.group ? '是' : '-', it.verify ? '存核' : '-'])
      .concat(opts.scoreOn ? [String(it.score)] : []);
    console.log(cells.map((v, ix) => (cols[ix].n ? pad(v, cols[ix].n) : v)).join(''));
  });
  console.log('');
  console.log('读表口径: 本区县数=库内该市县级产区点位数（产业规模线索）｜跨省=全国把它列为道地的省数' );
  console.log('        跨省多 = 需求普遍但同质竞争强；跨省 1-2 = 产区集中，外地引种要核实品质认可度与品牌壁垒');
  console.log('        标「存核」的条目县级产区或地标名未经二次确认，引用时如实标注');
  if (localNames) console.log('本区行置顶 = 该县直接命中道地记录；其后为同省其他市县品种，仅作参考不可当本县道地');
  console.log('');
  console.log('下一步（必做）: 按 references/dimensions.md 的 17 个维度逐条联网核实，尤其第 6 号（生育期与采收年限）、' );
  console.log('               第 9-11 号（价格周期/供给管道/库存代理）、第 14-17 号（耕地用途管制/濒危合规/政策补贴）；');
  console.log('               本地库不含价格、面积、生育期年限与连作信息，不得凭本表下种植结论。');
}

function runName(input, opts) {
  const res = q(['-n', input]);
  if (res.count === 0) {
    console.log(`NOT_FOUND: 本地道地库无「${input}」的道地记录（正名与道地产品习用名都查过）。`);
    console.log('action: 先联网确认它是否被收载为道地/有产区记录，再走 dimensions.md 的维度核实。');
    process.exit(3);
  }
  const nat = nationalIndex();
  const list = [...aggregate(res.hits).values()].map(v => decorate(v, nat, false));
  const it = list[0] || decorate(aggregate(res.hits).values().next().value, nat, false);

  const byProv = res.hits.slice().sort((a, b) => a.province.localeCompare(b.province, 'zh'));
  const allNote = res.hits.map(h => h.beizhu).join('；');
  const products = [...new Set(res.hits.map(h => h.chanpin).filter(Boolean))];

  if (opts.json) {
    console.log(JSON.stringify({
      mode: 'name', name: it.name, query: input, daoProvinceCount: it.comp,
      cert: CERT_RE.test(allNote), group: GROUP_RE.test(allNote),
      verifyCount: res.hits.filter(h => VERIFY_RE.test(h.beizhu)).length,
      products, rows: byProv,
    }, null, 2));
    return;
  }

  console.log(`药材: ${it.name}   查询词: ${input}${products.length && products[0] !== it.name ? `   道地产品别名: ${products.slice(0, 6).join('/')}` : ''}`);
  console.log(`全国把它列为道地的省级区域: ${it.comp} 个   地标/GAP 认证: ${CERT_RE.test(allNote) ? '有' : '无'}   经典药群: ${GROUP_RE.test(allNote) ? '属' : '-'}   存核条目: ${res.hits.filter(h => VERIFY_RE.test(h.beizhu)).length}/${res.hits.length}`);
  console.log('');
  for (const h of byProv) {
    console.log(`【${h.province}】${h.chanpin || h.yaocai}`);
    console.log(`  产区: ${h.changu}`);
    console.log(`  特征: ${h.tezheng}`);
    console.log(`  备注: ${h.beizhu}`);
  }
  console.log('');
  console.log(`竞争结构: ${it.comp <= 2 ? '产区高度集中，主产区占绝对份额 → 引种前先核实外地货的市场接受度与检测指标差异' : it.comp <= 5 ? '少数省份分占，产区差异即品质/价格差异 → 必须锁定对标产区' : '全国性品种，' + it.comp + ' 省都列为道地 → 竞争看成本与渠道，不看点地标签'}`);
  console.log('本表不含: 当前价格与周期位置、种植面积与存苗量、生育期年限、连作障碍、种苗可得性与价格、' );
  console.log('          耕地/林地合规、补贴变动 → 全部按 references/dimensions.md 联网核实。');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { top: 8, json: false, scoreOn: true };
  let region = null, name = null;
  for (const a of argv) {
    if (a === '-h' || a === '--help' || a === '帮助') { console.log(HELP); return; }
    else if (a.startsWith('--region=')) region = a.slice(9);
    else if (a.startsWith('--name=')) name = a.slice(7);
    else if (a.startsWith('--top=')) opts.top = Math.max(1, parseInt(a.slice(6), 10) || 8);
    else if (a === '--json') opts.json = true;
    else if (a === '--score=off') opts.scoreOn = false;
    else { console.log(`参数错误: ${a}\n`); console.log(HELP); process.exit(2); }
  }
  if (!region && !name) {
    console.log('缺少 --region=<地区> 或 --name=<药材>\n');
    console.log(HELP);
    process.exit(2);
  }
  if (region && name) { console.log('--region 与 --name 二选一，不要同时给\n'); process.exit(2); }
  if (region) runRegion(region.trim(), opts); else runName(name.trim(), opts);
}

main();
