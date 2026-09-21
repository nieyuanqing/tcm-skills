#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'references', 'daodi-yaocai.md');

const HELP = `道地药材分布查询

用法: node scripts/daodi_query.cjs [选项] [关键词...]

按维度指定（同类多值取并集，不同类之间取交集）:
  -n, --name=<药材[,药材]>     药材名，正名或道地产品习用名皆可（如 牛膝,怀牛膝）
  -r, --region=<区域[,区域]>   区域，接受大区名（华北/东北/华东/华中/华南/西南/西北）
                               或省名（云南、云南省、内蒙古），多个取并集
  -c, --county=<产区>          只在「道地产区」列里找市、县名（如 文山、焦作）
  -g, --group=<药群>           只在「备注」列里找经典药群名（如 浙八味、十大楚药）
  <关键词...>                  不限字段的自由关键词，多个词须同时命中

其它选项:
      --by=<字段>              限定关键词字段: name|product|region|feature|note|all(默认)
      --province=<省>          旧写法，等价于 -r <省>
      --list                   只列各省药材数与清单，不查详情
      --limit=<N>              最多输出 N 条命中，默认 40
      --json                   以 JSON 输出，供程序消费
  -h, --help                   显示本帮助

示例:
  -n 三七                      某味药材的道地信息
  -n 牛膝 -r 河南              指定药材 + 指定区域
  -r 华东 --list               只列华东七省覆盖清单
  -c 焦作                      反查某产区产哪些道地药材
  -g 浙八味                    整个经典药群的组成
  茯苓 云南                    自由关键词写法，等价 -n 茯苓 -r 云南

退出码: 0=有命中  3=无命中(需联网补查)  2=参数错误`;

const PROVINCES = ['北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西', '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏', '新疆'];

const REGIONS = {
  华北: ['北京', '天津', '河北', '山西', '内蒙古'],
  东北: ['辽宁', '吉林', '黑龙江'],
  华东: ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东'],
  华中: ['河南', '湖北', '湖南'],
  华南: ['广东', '广西', '海南'],
  西南: ['重庆', '四川', '贵州', '云南', '西藏'],
  西北: ['陕西', '甘肃', '青海', '宁夏', '新疆'],
};

const FIELD_COL = { name: 'yaocai', product: 'chanpin', region: 'changu', feature: 'tezheng', note: 'beizhu' };
const BY_FIELDS = Object.keys(FIELD_COL).concat('all');
const SHORT = { h: 'help', n: 'name', r: 'region', c: 'county', g: 'group', l: 'list', j: 'json' };
const VALUE_OPTS = { name: 'names', region: 'regions', county: 'county', group: 'group', by: 'by', limit: 'limit', province: 'regions' };

function normProvince(s) {
  return String(s).replace(/(省|市|自治区|维吾尔|壮族|回族)$/g, '').trim();
}

function splitList(v) {
  return String(v || '').split(/[、，,;；|]+/).map((s) => s.trim()).filter(Boolean);
}

function fail(msg) {
  process.stdout.write(`参数错误: ${msg}\n\n${HELP}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { by: 'all', names: [], regions: [], county: [], group: [], kw: [], list: false, limit: 40, json: false, help: false, regionLabel: [] };
  const takeValue = (inline, i) => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined || /^-/.test(next)) fail(`${argv[i]} 缺少取值`);
    return [next, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const long = /^--([^=]+)(?:=(.*))?$/.exec(a);
    const shrt = /^-([a-zA-Z])(?:=(.*))?$/.exec(a);
    let key = null;
    let inline;
    if (long) {
      key = long[1];
      inline = long[2];
    } else if (shrt) {
      key = SHORT[shrt[1]];
      inline = shrt[2];
      if (!key) fail(`未知选项 ${a}`);
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
      continue;
    } else {
      opts.kw.push(a);
      continue;
    }
    const slot = VALUE_OPTS[key];
    if (slot) {
      const [v, used] = takeValue(inline, i);
      i = used;
      if (key === 'by') {
        if (!BY_FIELDS.includes(v)) fail(`--by=${v} 不是合法字段`);
        opts.by = v;
      } else if (key === 'limit') {
        opts.limit = Math.max(1, parseInt(v, 10) || 40);
      } else {
        const vals = splitList(v);
        if (!vals.length) fail(`--${key} 取值为空`);
        opts[slot].push(...vals);
        if (key === 'province') opts.regionLabel.push(v);
      }
    } else if (key === 'list') opts.list = true;
    else if (key === 'json') opts.json = true;
    else if (key === 'help') opts.help = true;
    else fail(`未知选项 ${a}`);
  }
  return opts;
}

function resolveRegions(spec) {
  if (!spec.regions.length) return null;
  const set = new Set();
  for (const raw of spec.regions) {
    const v = normProvince(raw);
    if (REGIONS[v]) {
      REGIONS[v].forEach((p) => set.add(p));
      continue;
    }
    if (PROVINCES.includes(v)) {
      set.add(v);
      continue;
    }
    const fuzzy = PROVINCES.filter((p) => p.includes(v));
    if (fuzzy.length) {
      fuzzy.forEach((p) => set.add(p));
      continue;
    }
    fail(`区域「${raw}」无法识别，可用大区名或省名（--list 查看）`);
  }
  return [...set];
}

function loadDb() {
  if (!fs.existsSync(DB)) {
    process.stdout.write(`数据库缺失: ${DB}\n请先执行本 skill 的数据采集步骤建立 references/daodi-yaocai.md\n`);
    process.exit(2);
  }
  const provinces = [];
  let cur = null;
  for (const raw of fs.readFileSync(DB, 'utf8').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) {
      const title = normProvince(h[1]);
      cur = PROVINCES.includes(title) ? { province: title, rows: [], sources: [] } : null;
      if (cur) provinces.push(cur);
      continue;
    }
    if (/^\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((s) => s.trim());
      if (cells.length < 5 || cells[0] === '药材' || /^-+$/.test(cells[0].replace(/\s/g, '')) || !cur) continue;
      cur.rows.push({ province: cur.province, yaocai: cells[0], chanpin: cells[1], changu: cells[2], tezheng: cells[3], beizhu: cells[4] });
    } else if (cur && /^>\s*来源[:：]/.test(line)) {
      cur.sources.push(line.replace(/^>\s*来源[:：]\s*/, ''));
    }
  }
  return provinces.filter((p) => p.rows.length > 0);
}

function aliases(row) {
  return (row.chanpin + '、' + row.yaocai).split(/[、，,;；/]/).map((s) => s.replace(/[（(].*?[)）]/g, '').trim()).filter(Boolean);
}

function fieldsOf(row, by) {
  if (by === 'all') return [row.province, row.yaocai, row.chanpin, row.changu, row.tezheng, row.beizhu];
  return [row[FIELD_COL[by]]];
}

function matchName(row, name) {
  return aliases(row).some((a) => a === name || a.includes(name) || (a.length >= 2 && name.includes(a)));
}

function matchKw(row, kws, by) {
  const hay = fieldsOf(row, by).join(' ');
  const als = by === 'all' || by === 'name' || by === 'product' ? aliases(row) : [];
  return kws.every((k) => hay.includes(k) || als.some((a) => a.includes(k) || (a.length >= 2 && k.includes(a))));
}

function pick(provinces, opts) {
  const out = [];
  for (const p of provinces) {
    for (const r of p.rows) {
      if (opts.names.length && !opts.names.some((n) => matchName(r, n))) continue;
      if (opts.county.length && !opts.county.some((c) => r.changu.includes(c))) continue;
      if (opts.group.length && !opts.group.some((g) => r.beizhu.includes(g))) continue;
      if (!matchKw(r, opts.kw, opts.by)) continue;
      out.push(r);
    }
  }
  return out;
}

function nearMiss(provinces, terms) {
  const scored = [];
  for (const p of provinces) {
    for (const r of p.rows) {
      const hay = aliases(r).join('');
      let best = 0;
      for (const k of terms) {
        let hit = 0;
        for (const ch of k) if (hay.includes(ch)) hit++;
        const score = k.length ? hit / k.length : 0;
        if (score > best) best = score;
      }
      if (best > 0.4) scored.push({ name: r.yaocai, score: best });
    }
  }
  const uniq = new Map();
  for (const s of scored.sort((a, b) => b.score - a.score)) if (!uniq.has(s.name)) uniq.set(s.name, s);
  return [...uniq.values()].slice(0, 12).map((s) => s.name);
}

function renderList(provinces) {
  const w = process.stdout;
  const total = provinces.reduce((n, p) => n + p.rows.length, 0);
  const uniq = new Set(provinces.flatMap((p) => p.rows.map((r) => r.yaocai))).size;
  w.write(`道地药材库: ${provinces.length} 个省级区域 / ${total} 条 / 去重 ${uniq} 味\n\n`);
  for (const p of provinces) {
    const names = [...new Set(p.rows.map((r) => r.yaocai))];
    const shown = names.slice(0, 14).join('、') + (names.length > 14 ? ` …（共 ${names.length} 味）` : '');
    w.write(`${p.province}（${p.rows.length} 条/${names.length} 味）: ${shown}\n`);
  }
}

function describe(opts, regionSet) {
  const parts = [];
  if (opts.names.length) parts.push(`药材=${opts.names.join('、')}`);
  if (regionSet) parts.push(`区域=${regionSet.join('、')}`);
  if (opts.county.length) parts.push(`产区=${opts.county.join('、')}`);
  if (opts.group.length) parts.push(`药群=${opts.group.join('、')}`);
  if (opts.kw.length) parts.push(`关键词=${opts.kw.join(' ')}`);
  return parts.length ? parts.join('｜') : '全部';
}

function renderHits(rows, opts, regionSet) {
  const w = process.stdout;
  if (opts.json) {
    w.write(JSON.stringify({ query: describe(opts, regionSet), count: rows.length, hits: rows.slice(0, opts.limit) }, null, 2) + '\n');
    return;
  }
  const shown = rows.slice(0, opts.limit);
  let pending = 0;
  w.write(`查询: ${describe(opts, regionSet)}\n命中 ${rows.length} 条（显示前 ${shown.length} 条）\n\n`);
  let curProv = null;
  for (const r of shown) {
    if (r.province !== curProv) {
      curProv = r.province;
      w.write(`【${curProv}】\n`);
    }
    if (/存核/.test(r.beizhu)) pending++;
    w.write(`  ${r.yaocai}｜道地产品: ${r.chanpin}｜产区: ${r.changu}\n`);
    w.write(`    特征: ${r.tezheng}\n`);
    w.write(`    备注: ${r.beizhu}\n`);
  }
  w.write(`\n字段口径: 药材=药典正名｜道地产品=当地习用名/地理标志名｜产区=市县级主产地｜存核=县级细节需再核实\n`);
  if (pending) w.write(`注意: 本批命中有 ${pending} 条备注含「存核」，引用到对外材料前建议联网复核产地或地理标志名称。\n`);
  if (rows.length > shown.length) w.write(`还有 ${rows.length - shown.length} 条未显示，用 --limit=${rows.length} 看全部。\n`);
}

function renderMiss(opts, regionSet, near) {
  const w = process.stdout;
  if (opts.json) {
    w.write(JSON.stringify({ query: describe(opts, regionSet), count: 0, hits: [], suggestions: near, action: 'NEED_WEB_LOOKUP' }) + '\n');
    return;
  }
  w.write(`NOT_FOUND: 本地道地药材库无「${describe(opts, regionSet)}」的记录\n`);
  if (near.length) w.write(`近似词条（可能是同一药材的别名/写法差异）: ${near.join('、')}\n`);
  w.write(`本库只收录已核实的道地药材。查不到不等于该药材不存在或不道地 —— 请联网补查并把结果回写进库（见 SKILL.md 第 2 步）。\n`);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.kw.length === 1 && !opts.regions.length && !opts.names.length) {
  const only = normProvince(opts.kw[0]);
  if (PROVINCES.includes(only) || REGIONS[only]) {
    opts.regions = [only];
    opts.kw = [];
  }
}
const bare = opts.list || opts.names.length || opts.regions.length || opts.county.length || opts.group.length || opts.kw.length;
if (opts.help || !bare) {
  process.stdout.write(HELP + '\n');
  process.exit(opts.help || bare ? 0 : 2);
}

const regionSet = resolveRegions(opts);
let provinces = loadDb();
if (regionSet) {
  provinces = provinces.filter((p) => regionSet.includes(p.province));
  if (!provinces.length) {
    process.stdout.write(`参数错误: 库里没有 ${regionSet.join('、')} 的数据，可用 --list 查看现有省级区域\n`);
    process.exit(2);
  }
}

if (opts.list) {
  renderList(provinces);
  process.exit(0);
}

const rows = pick(provinces, opts);
if (rows.length) {
  renderHits(rows, opts, regionSet);
  process.exit(0);
}
renderMiss(opts, regionSet, nearMiss(provinces, [...opts.names, ...opts.kw]));
process.exit(3);
