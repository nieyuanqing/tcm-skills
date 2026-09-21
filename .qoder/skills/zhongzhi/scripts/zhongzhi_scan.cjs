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
let NATIONAL = null;
const CERT_RE = /地理标志|保护产品|证明商标|GAP|良好农业规范/;
const GROUP_RE = /浙八味|四大怀药|八大怀药|十大[冀晋皖楚云川渝宁陇桂苏]|八大[祁宛]|八大特色药|五大特色药|五大[药南]|辽药六宝|赣食十味|十八青药|岭南新八味|桂十味|川药|广药|云药|藏药|蒙药|关药|怀药|华药|北药|南药|道地/;
const VERIFY_RE = /存核/;

const HELP = `用法: node scripts/zhongzhi_scan.cjs --region=<地区> [--name=<药材>] | --name=<药材> | --pick[=N] [选项]

  --region=<地区>   省名（湖北）/ 大区名（华中）/ 市县级产区（文山、罗田）
                    → 出该地区候选品种排序表，供挑 2-3 个再联网核实
  --name=<药材>     药典正名或道地产品习用名（三七、文山三七）
                    → 出该药材全国道地产区与竞争格局
  --region + --name 组合查询 → 判该药材在该地区有无道地记录、本区位次、无记录时按引种风险输出
  --pick[=N]        不出地区时的全国当期榜，库内全品种初筛取前 N（默认 15）
                    → 供联网核实后收敛到 3 个；榜本身不是推荐；不与上两项同给
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

function nationalRows() {
  if (!NATIONAL) {
    NATIONAL = [];
    for (const r of BIG_REGIONS) NATIONAL.push(...q(['-r', r]).hits);
  }
  return NATIONAL;
}

function nationalIndex() {
  const map = new Map();
  for (const h of nationalRows()) {
    if (!map.has(h.yaocai)) map.set(h.yaocai, new Set());
    map.get(h.yaocai).add(h.province);
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

function runPick(N, opts) {
  const rows = nationalRows();
  if (!rows.length) {
    console.log('ERROR: 读不到道地库数据，确认 ../daodi/scripts/daodi_query.cjs 与库文件在位。');
    process.exit(2);
  }
  const list = [];
  for (const v of aggregate(rows).values()) {
    const note = v.notes.join('；');
    const comp = v.provinces.size;
    const cert = CERT_RE.test(note);
    const group = GROUP_RE.test(note);
    const verify = VERIFY_RE.test(note);
    const counties = v.counties.size;
    const score = (cert ? 3 : 0) + (group ? 2 : 0)
      + (comp <= 2 ? 3 : comp <= 4 ? 1.5 : comp <= 7 ? 0 : -2)
      + (counties >= 10 ? 1 : 0);
    list.push({
      name: v.name, comp, counties, cert, group, verify,
      score: Math.round(score * 10) / 10,
      products: [...v.products].slice(0, 3).join('/'),
    });
  }
  list.sort((a, b) => (b.score - a.score) || (a.comp - b.comp) || (b.counties - a.counties) || a.name.localeCompare(b.name, 'zh'));

  if (opts.json) {
    console.log(JSON.stringify({ mode: 'pick', universe: list.length, top: N, candidates: list.slice(0, N) }, null, 2));
    return;
  }
  console.log(`全国当期榜（本地信号初筛）：库内去重 ${list.length} 味 → 取前 ${Math.min(N, list.length)}`);
  console.log('');
  console.log(pad('名次', 5) + pad('品种', 11) + pad('道地省数', 9) + pad('产区县数', 9) + pad('道地名', 20) + pad('认证', 5) + pad('药群', 5) + pad('存核', 5) + '分');
  list.slice(0, N).forEach((it, i) => {
    console.log(
      pad(i + 1, 5) + pad(it.name, 11) + pad(it.comp, 9) + pad(it.counties, 9) +
      pad(cut(it.products, 8), 20) + pad(it.cert ? '有' : '-', 5) + pad(it.group ? '是' : '-', 5) +
      pad(it.verify ? '存核' : '-', 5) + String(it.score),
    );
  });
  console.log('');
  console.log('口径: 本榜与分省候选榜目标不同 —— 奖励品牌壁垒（地标/药群）与产区集中（别人不好复制），');
  console.log('      惩罚全国都在产的同质品种。道地省数高不等于不好，只等于没有差异化。');
  console.log('      分数只决定核实顺序，不决定推荐；下行期最大的收益来自不种别人正在扩的品种。');
  console.log('');
  console.log('出推荐前必查三条（本地库无这些数据，缺一不可）：');
  console.log('  1 周期位置：近 5-10 年价格分位 + 近 12 个月方向，用相对量不用绝对价');
  console.log('  2 供给管道：在田未采面积 × 采挖年限 → 今年种下去会撞上谁的采收高峰');
  console.log('  3 退出成本：当年/一年生可采收优先，多年生在下行期等于锁死资金 3 年以上');
}

function runBoth(name, region, opts) {
  const natRes = q(['-n', name]);
  if (natRes.count === 0) {
    console.log(`NOT_FOUND: 本地道地库无「${name}」的道地记录，无法与地区「${region}」组合查询。`);
    console.log('action: 先按 references/dimensions.md 联网确认该药材与该地区的关系，不要改字凑库内条目。');
    process.exit(3);
  }
  const provs = [...new Set(natRes.hits.map(h => h.province))];
  const local = q(['-n', name, '-r', region]);
  const localByCounty = local.count ? local : q(['-n', name, '-c', region]);

  const provCounties = new Map();
  for (const h of natRes.hits) {
    if (!provCounties.has(h.province)) provCounties.set(h.province, new Set());
    const s = provCounties.get(h.province);
    for (const c of splitList(h.changu)) s.add(c);
  }
  const ranked = [...provCounties].map(([p, s]) => ({ p, n: s.size })).sort((a, b) => b.n - a.n);
  const topProv = ranked[0];

  if (opts.json) {
    console.log(JSON.stringify({
      mode: 'both', name, region, daoProvinceCount: provs.length,
      provinceRanking: ranked.map(x => `${x.p}:${x.n}`),
      localHit: localByCounty.count > 0, localRows: localByCounty.hits, nationalRows: natRes.hits,
    }, null, 2));
    return;
  }

  console.log(`组合查询: 药材「${name}」× 地区「${region}」`);
  console.log(`全国把它列为道地的省级区域: ${provs.length} 个   主产区: ${topProv ? `${topProv.p}（${topProv.n} 个产区点）` : '-'}   产区点排序: ${ranked.map(x => x.p + x.n).join(' > ')}`);
  console.log('');
  if (localByCounty.count === 0) {
    console.log(`本省/本地区结论: 本地道地库【无】「${name}」在「${region}」的道地记录 → 属引种到非道地产区，这是本次分析的重点风险，不得当作道地品种对外表述。`);
    console.log('');
    console.log('对照：该药材现有道地产区明细');
    for (const h of natRes.hits) console.log(`  【${h.province}】${h.chanpin || h.yaocai}｜产区: ${h.changu}｜${cut(h.beizhu, 40)}`);
    console.log('');
    console.log('下一步（必做，按 references/dimensions.md）：第 2-3 号维度先判气候土壤海拔能不能活，第 4 号判连作与地块，');
    console.log('  第 5 号查本地有无栽培规程与大田案例，第 9-10 号查价格分位与在田面积，第 14-15 号查用地与许可。');
    console.log('  引种非道地产区的成败取决于检测指标与收购方认可度，不取决于气候适宜；先把收购方问到再谈面积。');
    return;
  }
  console.log(`本地区结论: 命中 ${localByCounty.count} 条道地记录`);
  for (const h of localByCounty.hits) {
    console.log(`【${h.province}】${h.chanpin || h.yaocai}`);
    console.log(`  产区: ${h.changu}`);
    console.log(`  特征: ${h.tezheng}`);
    console.log(`  备注: ${h.beizhu}`);
  }
  const localProv = localByCounty.hits[0].province;
  const rank = ranked.findIndex(x => x.p === localProv) + 1;
  console.log('');
  console.log(`本区位次: ${localProv} 在 ${ranked.length} 个道地省里排第 ${rank}（按产区点位数）${rank === 1 ? ' → 主产区本身，竞争看成本与渠道' : rank <= 3 ? ' → 第二梯队，可打差异化产区牌' : ' → 非主流产区，需说明凭什么卖得掉'}`);
  console.log(`竞争格局: 全国 ${provs.length} 省列为道地${provs.length >= 6 ? ' → 同质竞争强，别看道地标签，看你的收购方与加工能力' : ' → 产区集中，外地货认可度要提前核实'}`);
  console.log('');
  console.log('本表不含价格、面积、采挖年限、连作、种苗、用地合规 → 按 references/dimensions.md 联网核实。');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { top: 8, json: false, scoreOn: true };
  let region = null, name = null, pick = null;
  for (const a of argv) {
    if (a === '-h' || a === '--help' || a === '帮助') { console.log(HELP); return; }
    else if (a.startsWith('--region=')) region = a.slice(9);
    else if (a.startsWith('--name=')) name = a.slice(7);
    else if (a === '--pick') pick = 15;
    else if (a.startsWith('--pick=')) pick = Math.max(3, parseInt(a.slice(7), 10) || 15);
    else if (a.startsWith('--top=')) opts.top = Math.max(1, parseInt(a.slice(6), 10) || 8);
    else if (a === '--json') opts.json = true;
    else if (a === '--score=off') opts.scoreOn = false;
    else { console.log(`参数错误: ${a}\n`); console.log(HELP); process.exit(2); }
  }
  if (!region && !name && pick === null) {
    console.log('缺少输入：--region=<地区> / --name=<药材> / --pick[=N]（前两者可同给）\n');
    console.log(HELP);
    process.exit(2);
  }
  if (pick !== null && (region || name)) {
    console.log('--pick 是全国尺度的榜，不接地区与药材条件；要看某省或某药材去掉 --pick 即可\n');
    console.log(HELP);
    process.exit(2);
  }
  if (pick !== null) runPick(pick, opts);
  else if (region && name) runBoth(name.trim(), region.trim(), opts);
  else if (region) runRegion(region.trim(), opts);
  else runName(name.trim(), opts);
}

main();
