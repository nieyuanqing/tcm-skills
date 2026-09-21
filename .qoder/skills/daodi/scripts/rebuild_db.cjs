#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, '..', 'references');
const PARTS = path.join(REF, '_parts');
const DB = path.join(REF, 'daodi-yaocai.md');

const ORDER = [
  ['华北', ['北京', '天津', '河北', '山西', '内蒙古']],
  ['东北', ['辽宁', '吉林', '黑龙江']],
  ['华东', ['上海', '江苏', '浙江', '安徽', '福建', '江西', '山东']],
  ['华中', ['河南', '湖北', '湖南']],
  ['华南', ['广东', '广西', '海南']],
  ['西南', ['重庆', '四川', '贵州', '云南', '西藏']],
  ['西北', ['陕西', '甘肃', '青海', '宁夏', '新疆']],
];
const KNOWN = ORDER.flatMap((x) => x[1]);

const grpRe = /([\u4e00-\u9fa5]{2,6}?(?:八味|九味|十味|六宝|四大南药)|十[大一二三][\u4e00-\u9fa5]{1,3}药|[一二三四五六七八十]大[\u4e00-\u9fa5]{1,3}药|浙八味|四大怀药|十八青药|岭南新八味)/g;

function normProvince(title) {
  return title.replace(/(省|市|自治区|维吾尔|壮族|回族)$/g, '').trim();
}

function splitSections(text) {
  const map = new Map();
  let cur = null;
  let buf = [];
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) map.set(cur, buf.join('\n').trim());
      const name = normProvince(m[1]);
      cur = KNOWN.includes(name) ? name : null;
      buf = [];
    } else if (cur) buf.push(line);
  }
  if (cur) map.set(cur, buf.join('\n').trim());
  return map;
}

function rowsOf(body) {
  return body
    .split('\n')
    .filter((l) => /^\|/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((s) => s.trim()))
    .filter((c) => c.length >= 5 && c[0] !== '药材' && !/^-+$/.test(c[0].replace(/\s/g, '')));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const mode = process.argv.includes('--from-parts') ? 'parts' : process.argv.includes('--reindex') ? 'reindex' : null;
if (!mode) {
  process.stdout.write(
    `用法: node scripts/rebuild_db.cjs --from-parts | --reindex\n` +
      `  --from-parts  合并 references/_parts/*.md 为生库（全量重建后使用）\n` +
      `  --reindex     保留现有分省内容，只重算头部统计与经典药群索引（联网补查回写后使用）\n`
  );
  process.exit(2);
}

let sections;
let cutoff = today();
if (mode === 'parts') {
  if (!fs.existsSync(PARTS)) {
    process.stdout.write(`缺少 ${PARTS}，无法按片段合并\n`);
    process.exit(2);
  }
  sections = new Map();
  for (const f of fs.readdirSync(PARTS).sort()) {
    for (const [k, v] of splitSections(fs.readFileSync(path.join(PARTS, f), 'utf8'))) sections.set(k, v);
  }
} else {
  if (!fs.existsSync(DB)) {
    process.stdout.write(`缺少 ${DB}，先用 --from-parts 建库\n`);
    process.exit(2);
  }
  const old = fs.readFileSync(DB, 'utf8');
  sections = splitSections(old);
  const m = /数据截止\s*[*]*\s*(\d{4}-\d{2}-\d{2})/.exec(old);
  if (m) cutoff = m[1];
}

const names = [...KNOWN.filter((p) => sections.has(p)), ...[...sections.keys()].filter((p) => !KNOWN.includes(p))];
if (!names.length) {
  process.stdout.write('没有解析到任何省级小节（## + 省级区域名），中止，未改写文件\n');
  process.exit(2);
}

const byProv = names.map((p) => sections.get(p));
const rows = byProv.flatMap(rowsOf);
const bad = byProv
  .flatMap((b) => b.split('\n'))
  .filter((l) => /^\|/.test(l))
  .map((l) => l.split('|').slice(1, -1).map((s) => s.trim()))
  .filter((c) => c[0] !== '药材' && !/^-+$/.test((c[0] || '').replace(/\s/g, '')) && c.length !== 5).length;
const total = rows.length;
const cunhe = rows.filter((r) => /存核/.test(r[4])).length;
const groups = new Map();
const shared = new Map();
for (const p of names) {
  for (const r of rowsOf(sections.get(p))) {
    if (shared.has(r[0])) shared.get(r[0]).add(p);
    else shared.set(r[0], new Set([p]));
    let m;
    grpRe.lastIndex = 0;
    while ((m = grpRe.exec(r[4]))) {
      if (!groups.has(m[1])) groups.set(m[1], []);
      if (!groups.get(m[1]).includes(r[0])) groups.get(m[1]).push(r[0]);
    }
  }
}
const multi = [...shared.entries()].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);
const geoCount = rows.filter((r) => /地理标志/.test(r[4])).length;

const stats = ORDER.map(([region, provs]) => {
  const list = provs.filter((p) => sections.has(p)).map((p) => `${p} ${rowsOf(sections.get(p)).length}`);
  return list.length ? `- **${region}**：${list.join('、')}` : null;
}).filter(Boolean);

const body = names.map((p) => `## ${p}\n\n${sections.get(p)}`).join('\n\n');

const head = `# 全国道地药材分布库

\`/daodi\` skill 的数据底座，由联网核实生成，**数据截止 ${cutoff}**。全库 ${total} 条、${names.length} 个省级区域，其中 ${geoCount} 条标注地理标志或 GAP 认定、${cunhe} 条含「存核」标记。

## 库说明与索引

### 列口径

| 列 | 含义 |
| --- | --- |
| 药材 | 《中国药典》收载的中药材正名 |
| 道地产品 | 当地道地商品习用名 / 地理标志产品名（如「怀地黄」「中宁枸杞」「新会陈皮」） |
| 道地产区 | 市、区、县级主产地，顿号分隔 |
| 品质特征 | 性状鉴别要点（形、色、质、气、味）或品质指标 |
| 备注 | 所属经典药群、地理标志/GAP 认定、出处简称 |

备注带「存核」= 道地属性有来源支撑，但县级产区细节或地理标志名称尚未二次确认，对外引用前先复核。

### 覆盖情况

${stats.join('\n')}

共 ${multi.length} 个品种跨省出现（道地与否本身就是比较结论），其中 4 省以上的：${multi.filter(([, v]) => v.size >= 4).slice(0, 16).map(([k, v]) => `${k}（${v.size} 省）`).join('、')}。

### 经典药群速查（由库内「备注」聚合）

| 药群 | 条目数 | 组成 |
| --- | --- | --- |
${[...groups.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length).map(([g, v]) => `| ${g} | ${v.length} | ${v.join('、')} |`).join('\n')}

查询用 \`node scripts/daodi_query.cjs <关键词>\`，不必整读本文件。格式约定：\`## \` 二级标题只能用于省级区域名（脚本按此解析，其余小节的表格不会被当成药材数据）；每省一张 5 列表格，表格后跟一行 \`> 来源：\`；单元格内不得出现 \`|\`。新增条目后执行 \`node scripts/rebuild_db.cjs --reindex\` 刷新本节统计。

`;

fs.writeFileSync(DB, (head + body + '\n').replace(/\n{3,}/g, '\n\n'));
process.stdout.write(`OK [${mode}] ${names.length} 省 / ${total} 条 / 异常行 ${bad} / 存核 ${cunhe} / 药群 ${groups.size} 个 / 数据截止 ${cutoff}\n`);
if (bad) process.stdout.write(`提醒: 有 ${bad} 行表格列数不是 5 列，这些行不会被查询脚本读到，需修正\n`);
if (mode === 'parts' && names.length < 31) process.stdout.write(`提醒: 只有 ${names.length} 个省有数据，缺 ${KNOWN.filter((p) => !sections.has(p)).join('、')}\n`);
