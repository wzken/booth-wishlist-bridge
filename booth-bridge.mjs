import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DIR, '.booth-bridge-config.json');
const SCRIPT = path.join(DIR, 'booth-bridge.local.user.js');
const BASE = 'http://127.0.0.1:8765';
const tasks = new Map();
const queue = [];

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}
async function loadConfig() {
  if (!existsSync(CONFIG)) throw new Error('请先运行 node booth-bridge.mjs setup');
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.token)) throw new Error('本机配置无效');
  return config;
}
async function setup() {
  const config = existsSync(CONFIG) ? await loadConfig() : { token: randomBytes(32).toString('hex'), firstBackup: null };
  if (!existsSync(CONFIG)) await saveJson(CONFIG, config);
  const template = await readFile(path.join(DIR, 'booth-bridge.user.js'), 'utf8');
  if (!template.includes('__BRIDGE_TOKEN__')) throw new Error('用户脚本模板缺少令牌占位符');
  await writeFile(SCRIPT, template.replace('__BRIDGE_TOKEN__', config.token), { encoding: 'utf8', mode: 0o600 });
  console.log(`已生成 ${SCRIPT}\n请导入 Tampermonkey，然后打开 https://accounts.booth.pm/wish_lists`);
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5_000_000) throw new Error('Request too large');
  }
  return body ? JSON.parse(body) : {};
}
async function serve() {
  const { token } = await loadConfig();
  http.createServer(async (req, res) => {
    try {
      if (req.headers['x-booth-bridge-token'] !== token) return json(res, 403, { error: 'Invalid token' });
      const u = new URL(req.url, BASE);
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, queued: queue.length });
      if (req.method === 'POST' && u.pathname === '/submit') {
        const command = await readJson(req);
        if (!['status', 'scan', 'lists', 'backup', 'create-list', 'item-lists', 'add-items', 'move-items'].includes(command.type)) return json(res, 400, { error: 'Unsupported command' });
        const id = randomUUID();
        tasks.set(id, { state: 'queued', created: Date.now() });
        queue.push({ id, command });
        return json(res, 200, { id });
      }
      if (req.method === 'GET' && u.pathname === '/next') {
        const task = queue.shift();
        if (task) tasks.get(task.id).state = 'running';
        return json(res, 200, task || null);
      }
      if (req.method === 'POST' && u.pathname === '/result') {
        const result = await readJson(req);
        const task = tasks.get(result.id);
        if (!task) return json(res, 404, { error: 'Unknown task' });
        task.state = 'done';
        task.result = result.result;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && u.pathname.startsWith('/result/')) {
        const task = tasks.get(u.pathname.slice(8));
        return json(res, task ? 200 : 404, task || { error: 'Unknown task' });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) { return json(res, 500, { error: String(error) }); }
  }).listen(8765, '127.0.0.1', () => console.log(`BOOTH bridge listening on ${BASE}`));
  setInterval(() => { for (const [id, task] of tasks) if (Date.now() - task.created > 3600_000) tasks.delete(id); }, 60_000);
}
async function api(token, route, method = 'GET', body) {
  const response = await fetch(BASE + route, { method, headers: { 'X-Booth-Bridge-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Bridge HTTP ${response.status}`);
  return value;
}
async function command(token, input) {
  const { id } = await api(token, '/submit', 'POST', input);
  const deadline = Date.now() + (['scan', 'backup', 'add-items', 'move-items'].includes(input.type) ? 900_000 : 60_000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const task = await api(token, '/result/' + id);
    if (task.state === 'done') {
      if (!task.result?.ok) throw new Error(task.result?.error || 'Browser command failed');
      return task.result.data;
    }
  }
  throw new Error('等待浏览器超时。请保持 BOOTH 收藏页、Tampermonkey 和服务进程运行。');
}
async function backup(token, target) {
  const data = await command(token, { type: 'backup' });
  if (!Array.isArray(data.favorites?.items) || !Array.isArray(data.lists)) throw new Error('备份内容不完整，未保存');
  const total = data.favorites.pagination?.total_count;
  if (data.favorites.items.length !== total) throw new Error(`收藏数量不匹配：读取 ${data.favorites.items.length}，BOOTH 报告 ${total}`);
  for (const list of data.lists) if (!Array.isArray(list.itemIds)) throw new Error(`分组 ${list.name} 缺少商品 ID，未保存`);
  const file = path.resolve(target || path.join(DIR, 'backups', `booth-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  if (existsSync(file)) throw new Error(`备份文件已存在：${file}`);
  await saveJson(file, data);
  const config = await loadConfig();
  if (!config.firstBackup) { config.firstBackup = file; await saveJson(CONFIG, config); }
  console.log(JSON.stringify({ saved: file, favorites: data.favorites.items.length, lists: data.lists.length }, null, 2));
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'setup') return setup();
  if (args[0] === 'serve') return serve();
  const config = await loadConfig();
  let input;
  switch (args[0]) {
    case 'status': case 'scan': case 'lists': input = { type: args[0] }; break;
    case 'backup': return backup(config.token, args[1]);
    case 'create-list': input = { type: 'create-list', name: args.slice(1).join(' ') }; break;
    case 'item-lists': input = { type: 'item-lists', itemId: Number(args[1]) }; break;
    case 'add-items': {
      if (!args[1] || !args[2]) throw new Error('用法：add-items 分组名称 ids.json');
      const ids = JSON.parse(await readFile(args[2], 'utf8'));
      input = { type: 'add-items', list: args[1], itemIds: ids };
      break;
    }
    case 'move-items': {
      if (!args[1] || !args[2] || !args[3]) throw new Error('用法：move-items 原分组 目标分组 ids.json');
      const ids = JSON.parse(await readFile(args[3], 'utf8'));
      input = { type: 'move-items', from: args[1], to: args[2], itemIds: ids };
      break;
    }
    default: throw new Error('命令：setup | serve | status | backup [文件] | scan [文件] | lists | create-list 名称 | item-lists ID | add-items 分组 ids.json | move-items 原分组 目标分组 ids.json');
  }
  if (['create-list', 'add-items', 'move-items'].includes(input.type) && (!config.firstBackup || !existsSync(config.firstBackup))) {
    console.log('首次修改前自动备份收藏和分组…');
    await backup(config.token);
  }
  const result = await command(config.token, input);
  if (args[0] === 'scan' && args[1]) {
    await saveJson(path.resolve(args[1]), result);
    console.log(JSON.stringify({ saved: path.resolve(args[1]), count: result.items.length, pagination: result.pagination }));
  } else console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
