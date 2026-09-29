// ==UserScript==
// @name         BOOTH 收藏分类桥接
// @namespace    local.booth.bridge
// @version      2.0.0
// @description  本机批量读取 BOOTH 收藏、备份和管理私有收藏分组
// @match        https://accounts.booth.pm/wish_lists*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  if (!location.pathname.startsWith('/wish_lists')) return;
  const BASE = 'http://127.0.0.1:8765';
  const TOKEN = '__BRIDGE_TOKEN__';
  if (TOKEN.startsWith('__')) return; // 导入 setup 生成的本机脚本，不要直接导入此模板
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function bridge(method, route, data) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: BASE + route,
      headers: { 'X-Booth-Bridge-Token': TOKEN, 'Content-Type': 'application/json' },
      data: data === undefined ? undefined : JSON.stringify(data),
      timeout: 20_000,
      onload: response => {
        try {
          const value = JSON.parse(response.responseText);
          response.status >= 200 && response.status < 300 ? resolve(value) : reject(new Error(value.error || `Bridge HTTP ${response.status}`));
        } catch (error) { reject(error); }
      },
      onerror: () => reject(new Error('Local bridge unavailable')),
      ontimeout: () => reject(new Error('Local bridge timed out')),
    }));
  }

  async function booth(route, method = 'GET', body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      const token = document.querySelector('meta[name="csrf-token"]')?.content;
      if (!token) throw new Error('BOOTH CSRF token unavailable');
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = token;
    }
    const response = await fetch(route, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : null; } catch { value = { message: raw.slice(0, 300) }; }
    if (!response.ok) throw new Error(`BOOTH HTTP ${response.status}: ${JSON.stringify(value).slice(0, 500)}`);
    return value;
  }

  async function scan() {
    const first = await booth('/wish_list_name_items.json?page=1');
    if (!Array.isArray(first.items) || !Number.isInteger(first.pagination?.total_pages) || first.pagination.total_pages < 0) throw new Error('Unexpected BOOTH pagination response');
    const items = [...first.items];
    for (let page = 2; page <= first.pagination.total_pages; page++) {
      await sleep(150);
      const next = await booth(`/wish_list_name_items.json?page=${page}`);
      if (!Array.isArray(next.items) || next.pagination?.current_page !== page) throw new Error(`Unexpected page ${page}`);
      items.push(...next.items);
    }
    return {
      pagination: first.pagination,
      items: items.map(item => ({
        id: item.id, name: item.name, url: item.url,
        category: item.category?.name, categoryUrl: item.category?.url,
        shop: item.shop?.name, shopUrl: item.shop?.url,
        price: item.price, isAdult: item.is_adult,
        isVRChat: item.is_vrchat, isSoldOut: item.is_sold_out,
      })),
    };
  }

  async function listItemIds(code) {
    const query = `wish_list_name_code=${encodeURIComponent(code)}`;
    const first = await booth(`/wish_list_name_items.json?page=1&${query}`);
    if (!Array.isArray(first.items) || !Number.isInteger(first.pagination?.total_pages) || first.pagination.total_pages < 0) throw new Error('Unexpected BOOTH list response');
    const ids = first.items.map(item => item.id);
    for (let page = 2; page <= first.pagination.total_pages; page++) {
      const next = await booth(`/wish_list_name_items.json?page=${page}&${query}`);
      if (!Array.isArray(next.items) || next.pagination?.current_page !== page) throw new Error(`Unexpected list page ${page}`);
      ids.push(...next.items.map(item => item.id));
    }
    if (ids.length !== first.pagination.total_count) throw new Error(`BOOTH list count mismatch: ${ids.length}/${first.pagination.total_count}`);
    return new Set(ids);
  }

  async function execute(command) {
    switch (command.type) {
      case 'status': return { url: location.href, userVisible: !!document.querySelector('#js-mount-point-wish-list'), account: document.querySelector('meta[name="csrf-token"]') ? 'signed-in page' : 'unknown' };
      case 'scan': return scan();
      case 'lists': return booth('/wish_list_names.json');
      case 'backup': {
        const favorites = await scan();
        const rawLists = await booth('/wish_list_names.json');
        if (!Array.isArray(rawLists)) throw new Error('Unexpected BOOTH groups response');
        const lists = [];
        for (const list of rawLists) {
          if (!list.code || !list.name) throw new Error('BOOTH group code/name missing');
          const ids = [...await listItemIds(list.code)];
          lists.push({ name: list.name, code: list.code, metadata: list, itemIds: ids });
        }
        return { formatVersion: 1, createdAt: new Date().toISOString(), sourceUrl: location.href, favorites, lists };
      }
      case 'create-list': {
        const name = String(command.name || '').trim();
        if (!name || name.length > 40) throw new Error('List name must be 1–40 characters');
        const existing = await booth('/wish_list_names.json');
        if (existing.some(x => x.name === name || x.wishListNameName === name)) throw new Error('List already exists');
        await booth('/wish_list_names.json', 'POST', { name });
        return booth('/wish_list_names.json');
      }
      case 'item-lists': {
        const id = Number(command.itemId);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid item ID');
        return booth(`/items/${id}/wish_list_items.json`);
      }
      case 'add-items': {
        const listNames = await booth('/wish_list_names.json');
        const target = listNames.find(x => [x.name, x.code].some(v => String(v) === String(command.list)));
        if (!target) throw new Error(`List not found: ${command.list}`);
        const code = target.code;
        if (!code) throw new Error('BOOTH list code missing');
        if (!Array.isArray(command.itemIds) || command.itemIds.length > 1000) throw new Error('Expected an array of at most 1000 item IDs');
        const ids = [...new Set(command.itemIds.map(Number))];
        if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid item ID');
        const result = { list: command.list, added: [], alreadyPresent: [], failed: [] };
        const before = await listItemIds(code);
        result.alreadyPresent = ids.filter(id => before.has(id));
        const pending = ids.filter(id => !before.has(id));
        for (let i = 0; i < pending.length; i += 20) {
          const chunk = pending.slice(i, i + 20);
          try {
            await booth(`/wish_list_names/${encodeURIComponent(code)}/items.json`, 'POST', { item_ids: chunk });
          } catch (error) { result.failed.push(...chunk.map(id => ({ id, error: String(error) }))); }
          await sleep(150);
        }
        const after = await listItemIds(code);
        result.added = pending.filter(id => after.has(id));
        const failedIds = new Set(result.failed.map(x => x.id));
        result.failed.push(...pending.filter(id => !after.has(id) && !failedIds.has(id)).map(id => ({ id, error: 'BOOTH did not confirm membership' })));
        result.failed = result.failed.filter(x => !after.has(x.id));
        return result;
      }
      default: throw new Error('Unsupported command');
    }
  }

  async function poll() {
    for (;;) {
      try {
        const task = await bridge('GET', '/next');
        if (!task) { await sleep(750); continue; }
        let result;
        try { result = { ok: true, data: await execute(task.command) }; }
        catch (error) { result = { ok: false, error: String(error) }; }
        await bridge('POST', '/result', { id: task.id, result });
      } catch { await sleep(1500); }
    }
  }
  poll();
})();
